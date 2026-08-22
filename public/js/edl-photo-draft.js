/**
 * EDL Photo Draft Store — CONVOYEUR_MISSION_FLOW_V2_WAVE2B
 *
 * PHOTO_TAKEN_ONCE = PHOTO_NOT_LOST
 * SIGNATURE_RELOAD_PERSISTENCE = IMPLEMENTED
 *
 * Persists EDL photo blobs, signature blobs, and form state in IndexedDB
 * so that photos AND signatures survive reload, back-navigation, page
 * close/reopen, visibility changes, and crashes.
 *
 * Key principle: SERVER_STATE_ALWAYS_WINS.
 * Before restoring any draft, the caller MUST verify the server phase
 * via MissionPhaseResolver. A draft for a phase that is no longer valid
 * (e.g. depart draft when mission is already in_progress) must NOT be
 * restored.
 *
 * Signature resilience:
 *   - Signatures are stored as PNG Blobs in the blobs store.
 *   - A signedSnapshotHash (SHA-256) captures the material EDL state at
 *     signature time. If the material state changes after signing, the
 *     signature is invalidated (SIGN_ONCE_UNLESS_SIGNED_CONTENT_CHANGES).
 *   - On reload without material change: SIGNATURE_RESTORED=YES, RESIGN_REQUIRED=NO.
 *   - On material change after signing: SIGNATURE_INVALIDATED=YES, RESIGN_REQUIRED=YES.
 *
 * Draft lifecycle:
 *   - save():   called on every photo take / form change / signature
 *   - load():   called on EDL init, AFTER server phase check
 *   - clear():  called ONLY after uploads + backend validation succeed
 *   - If validation fails → DRAFT_PRESERVED=YES (clear is NOT called)
 *
 * Storage layout:
 *   DB:   bathily_edl
 *   Store: edl_photos_draft (keyPath: 'draftKey')
 *   Store: edl_photo_blobs  (keyPath: 'blobKey') — holds raw Blob objects
 *
 * Draft record shape:
 *   {
 *     draftKey:    "missionId::userId::edlType",
 *     missionId:   string,
 *     userId:      string,
 *     edlType:     "depart" | "arrivee",
 *     photos:      [{ order, category, viewName, blobKey, mime, size, timestamp }],
 *     dommages:    [{ zone, type, desc, photoBlobKey, photoMime, timestamp }],
 *     formState:   { kilometerage, carburant, observations, ... },
 *     sigConv:     { blobKey, signedAt, signedSnapshotHash } | null,
 *     sigCli:      { blobKey, signedAt, signedSnapshotHash } | null,
 *     finMissionSelfieBlobKey: string | null,
 *     createdAt:   number,
 *     updatedAt:   number
 *   }
 */

;(function (global) {
  'use strict';

  var DB_NAME = 'bathily_edl';
  var DB_VERSION = 1;
  var STORE_DRAFT = 'edl_photos_draft';
  var STORE_BLOBS = 'edl_photo_blobs';
  var DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  // =====================================================
  // Internal: open / upgrade database
  // =====================================================
  var _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB not available'));
        return;
      }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (event) {
        var db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_DRAFT)) {
          db.createObjectStore(STORE_DRAFT, { keyPath: 'draftKey' });
        }
        if (!db.objectStoreNames.contains(STORE_BLOBS)) {
          db.createObjectStore(STORE_BLOBS, { keyPath: 'blobKey' });
        }
      };
      req.onsuccess = function (event) { resolve(event.target.result); };
      req.onerror = function (event) { reject(event.target.error); };
    });
    return _dbPromise;
  }

  function tx(db, storeName, mode) {
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  function reqToPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // =====================================================
  // Key helpers
  // =====================================================
  function draftKey(missionId, userId, edlType) {
    return missionId + '::' + userId + '::' + edlType;
  }

  function blobKey(draftKeyVal, category, order) {
    return draftKeyVal + '::' + category + '::' + order;
  }

  function damageBlobKey(draftKeyVal, damageIdx) {
    return draftKeyVal + '::damage::' + damageIdx;
  }

  function selfieBlobKey(draftKeyVal) {
    return draftKeyVal + '::selfie';
  }

  function sigBlobKey(draftKeyVal, role) {
    return draftKeyVal + '::sig::' + role;
  }

  // =====================================================
  // Blob storage
  // =====================================================
  function putBlob(db, key, blob) {
    var store = tx(db, STORE_BLOBS, 'readwrite');
    return reqToPromise(store.put({ blobKey: key, blob: blob, createdAt: Date.now() }));
  }

  function getBlob(db, key) {
    var store = tx(db, STORE_BLOBS, 'readonly');
    return reqToPromise(store.get(key)).then(function (rec) {
      return rec ? rec.blob : null;
    });
  }

  function deleteBlob(db, key) {
    var store = tx(db, STORE_BLOBS, 'readwrite');
    return reqToPromise(store.delete(key));
  }

  // =====================================================
  // Public API
  // =====================================================

  /**
   * Save (or update) a draft.
   * @param {object} params
   * @param {string} params.missionId
   * @param {string} params.userId
   * @param {string} params.edlType  — "depart" | "arrivee"
   * @param {Array}  params.photos   — [{ order, category, viewName, blob, mime, size }]
   * @param {Array}  params.dommages — [{ zone, type, desc, photoBlob, photoMime }]
   * @param {object} params.formState
   * @param {object|null} params.sigConv — { blob, signedAt, signedSnapshotHash } | null
   * @param {object|null} params.sigCli  — { blob, signedAt, signedSnapshotHash } | null
   * @param {File|Blob|null} params.finMissionSelfieBlob
   * @returns {Promise<void>}
   */
  async function saveDraft(params) {
    var db = await openDB();
    var dk = draftKey(params.missionId, params.userId, params.edlType);
    var now = Date.now();

    // Store photo blobs
    var photoRecords = [];
    for (var i = 0; i < params.photos.length; i++) {
      var p = params.photos[i];
      if (!p || !p.blob) continue;
      var bk = blobKey(dk, p.category, p.order);
      await putBlob(db, bk, p.blob);
      photoRecords.push({
        order: p.order,
        category: p.category,
        viewName: p.viewName,
        blobKey: bk,
        mime: p.mime,
        size: p.size,
        timestamp: now
      });
    }

    // Store damage photo blobs
    var damageRecords = [];
    for (var j = 0; j < params.dommages.length; j++) {
      var d = params.dommages[j];
      var dmgBlobKey = null;
      if (d.photoBlob) {
        dmgBlobKey = damageBlobKey(dk, j);
        await putBlob(db, dmgBlobKey, d.photoBlob);
      }
      damageRecords.push({
        zone: d.zone,
        type: d.type,
        desc: d.desc || '',
        photoBlobKey: dmgBlobKey,
        photoMime: d.photoMime || null,
        timestamp: now
      });
    }

    // WAVE2B: Store signature blobs (PNG)
    var sigConvRecord = null;
    if (params.sigConv && params.sigConv.blob) {
      var sigConvBK = sigBlobKey(dk, 'convoyeur');
      await putBlob(db, sigConvBK, params.sigConv.blob);
      sigConvRecord = {
        blobKey: sigConvBK,
        mime: 'image/png',
        signedAt: params.sigConv.signedAt || now,
        signedSnapshotHash: params.sigConv.signedSnapshotHash || null
      };
    }

    var sigCliRecord = null;
    if (params.sigCli && params.sigCli.blob) {
      var sigCliBK = sigBlobKey(dk, 'client');
      await putBlob(db, sigCliBK, params.sigCli.blob);
      sigCliRecord = {
        blobKey: sigCliBK,
        mime: 'image/png',
        signedAt: params.sigCli.signedAt || now,
        signedSnapshotHash: params.sigCli.signedSnapshotHash || null
      };
    }

    // Store selfie blob
    var selfieBK = null;
    if (params.finMissionSelfieBlob) {
      selfieBK = selfieBlobKey(dk);
      await putBlob(db, selfieBK, params.finMissionSelfieBlob);
    }

    var draft = {
      draftKey: dk,
      missionId: params.missionId,
      userId: params.userId,
      edlType: params.edlType,
      photos: photoRecords,
      dommages: damageRecords,
      formState: params.formState || {},
      sigConv: sigConvRecord,
      sigCli: sigCliRecord,
      finMissionSelfieBlobKey: selfieBK,
      createdAt: now,
      updatedAt: now
    };

    // Preserve createdAt if draft already exists
    var existing = await reqToPromise(tx(db, STORE_DRAFT, 'readonly').get(dk));
    if (existing && existing.createdAt) {
      draft.createdAt = existing.createdAt;
    }

    var store = tx(db, STORE_DRAFT, 'readwrite');
    return reqToPromise(store.put(draft));
  }

  /**
   * Load a draft and return all blobs restored.
   * Caller MUST verify server phase before calling this.
   * @param {string} missionId
   * @param {string} userId
   * @param {string} edlType
   * @returns {Promise<object|null>} draft with blobs restored, or null
   */
  async function loadDraft(missionId, userId, edlType) {
    var db = await openDB();
    var dk = draftKey(missionId, userId, edlType);
    var draft = await reqToPromise(tx(db, STORE_DRAFT, 'readonly').get(dk));
    if (!draft) return null;

    // Restore photo blobs
    var photos = [];
    for (var i = 0; i < draft.photos.length; i++) {
      var pr = draft.photos[i];
      var blob = await getBlob(db, pr.blobKey);
      photos.push({
        order: pr.order,
        category: pr.category,
        viewName: pr.viewName,
        blob: blob,
        mime: pr.mime,
        size: pr.size,
        timestamp: pr.timestamp
      });
    }

    // Restore damage photo blobs
    var dommages = [];
    for (var j = 0; j < draft.dommages.length; j++) {
      var dr = draft.dommages[j];
      var dmgBlob = dr.photoBlobKey ? await getBlob(db, dr.photoBlobKey) : null;
      dommages.push({
        zone: dr.zone,
        type: dr.type,
        desc: dr.desc,
        photoBlob: dmgBlob,
        photoMime: dr.photoMime
      });
    }

    // Restore selfie blob
    var selfieBlob = draft.finMissionSelfieBlobKey ? await getBlob(db, draft.finMissionSelfieBlobKey) : null;

    // WAVE2B: Restore signature blobs
    var sigConvBlob = null;
    var sigConvMeta = null;
    if (draft.sigConv && draft.sigConv.blobKey) {
      sigConvBlob = await getBlob(db, draft.sigConv.blobKey);
      sigConvMeta = {
        signedAt: draft.sigConv.signedAt,
        signedSnapshotHash: draft.sigConv.signedSnapshotHash
      };
    }

    var sigCliBlob = null;
    var sigCliMeta = null;
    if (draft.sigCli && draft.sigCli.blobKey) {
      sigCliBlob = await getBlob(db, draft.sigCli.blobKey);
      sigCliMeta = {
        signedAt: draft.sigCli.signedAt,
        signedSnapshotHash: draft.sigCli.signedSnapshotHash
      };
    }

    return {
      draftKey: dk,
      missionId: draft.missionId,
      userId: draft.userId,
      edlType: draft.edlType,
      photos: photos,
      dommages: dommages,
      formState: draft.formState,
      sigConv: sigConvBlob ? { blob: sigConvBlob, mime: 'image/png', signedAt: sigConvMeta.signedAt, signedSnapshotHash: sigConvMeta.signedSnapshotHash } : null,
      sigCli: sigCliBlob ? { blob: sigCliBlob, mime: 'image/png', signedAt: sigCliMeta.signedAt, signedSnapshotHash: sigCliMeta.signedSnapshotHash } : null,
      finMissionSelfieBlob: selfieBlob,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt
    };
  }

  /**
   * Clear a draft AND its blobs.
   * Called ONLY after uploads + backend validation succeed.
   * @param {string} missionId
   * @param {string} userId
   * @param {string} edlType
   * @returns {Promise<void>}
   */
  async function clearDraft(missionId, userId, edlType) {
    var db = await openDB();
    var dk = draftKey(missionId, userId, edlType);
    var draft = await reqToPromise(tx(db, STORE_DRAFT, 'readonly').get(dk));
    if (!draft) return;

    // Delete all photo blobs
    for (var i = 0; i < draft.photos.length; i++) {
      await deleteBlob(db, draft.photos[i].blobKey);
    }
    // Delete damage photo blobs
    for (var j = 0; j < draft.dommages.length; j++) {
      if (draft.dommages[j].photoBlobKey) {
        await deleteBlob(db, draft.dommages[j].photoBlobKey);
      }
    }
    // Delete selfie blob
    if (draft.finMissionSelfieBlobKey) {
      await deleteBlob(db, draft.finMissionSelfieBlobKey);
    }
    // WAVE2B: Delete signature blobs
    if (draft.sigConv && draft.sigConv.blobKey) {
      await deleteBlob(db, draft.sigConv.blobKey);
    }
    if (draft.sigCli && draft.sigCli.blobKey) {
      await deleteBlob(db, draft.sigCli.blobKey);
    }
    // Delete draft record
    await reqToPromise(tx(db, STORE_DRAFT, 'readwrite').delete(dk));
  }

  /**
   * Check if a draft exists without loading blobs.
   * @returns {Promise<boolean>}
   */
  async function hasDraft(missionId, userId, edlType) {
    var db = await openDB();
    var dk = draftKey(missionId, userId, edlType);
    var rec = await reqToPromise(tx(db, STORE_DRAFT, 'readonly').get(dk));
    return !!rec;
  }

  /**
   * Controlled cleanup of obsolete drafts (older than TTL).
   * Does NOT touch drafts that are still within TTL.
   * Called on EDL init.
   * @returns {Promise<number>} count of purged drafts
   */
  async function purgeObsoleteDrafts() {
    var db = await openDB();
    var now = Date.now();
    var store = tx(db, STORE_DRAFT, 'readonly');
    var allDrafts = await reqToPromise(store.getAll());
    var purged = 0;
    for (var i = 0; i < allDrafts.length; i++) {
      var d = allDrafts[i];
      if (now - d.updatedAt > DRAFT_TTL_MS) {
        // Delete blobs + draft
        for (var j = 0; j < d.photos.length; j++) {
          await deleteBlob(db, d.photos[j].blobKey);
        }
        for (var k = 0; k < d.dommages.length; k++) {
          if (d.dommages[k].photoBlobKey) await deleteBlob(db, d.dommages[k].photoBlobKey);
        }
        if (d.finMissionSelfieBlobKey) await deleteBlob(db, d.finMissionSelfieBlobKey);
        // WAVE2B: Clean signature blobs
        if (d.sigConv && d.sigConv.blobKey) await deleteBlob(db, d.sigConv.blobKey);
        if (d.sigCli && d.sigCli.blobKey) await deleteBlob(db, d.sigCli.blobKey);
        await reqToPromise(tx(db, STORE_DRAFT, 'readwrite').delete(d.draftKey));
        purged++;
      }
    }
    return purged;
  }

  /**
   * Delete a specific draft for a different edlType than the current one.
   * Used when server phase has moved forward and an old draft is stale.
   * e.g. mission is now in_progress → delete any depart draft.
   * @returns {Promise<void>}
   */
  async function deleteDraftByType(missionId, userId, edlType) {
    return clearDraft(missionId, userId, edlType);
  }

  // =====================================================
  // Export
  // =====================================================
  var api = {
    DB_NAME: DB_NAME,
    STORE_DRAFT: STORE_DRAFT,
    STORE_BLOBS: STORE_BLOBS,
    DRAFT_TTL_MS: DRAFT_TTL_MS,
    draftKey: draftKey,
    saveDraft: saveDraft,
    loadDraft: loadDraft,
    clearDraft: clearDraft,
    hasDraft: hasDraft,
    purgeObsoleteDrafts: purgeObsoleteDrafts,
    deleteDraftByType: deleteDraftByType
  };

  if (typeof window !== 'undefined') {
    window.EdlPhotoDraft = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
