/**
 * Gamification & Push — Bathily-Convoyage
 * Badges, niveaux, notifications push pour convoyeurs
 */

(function () {
  'use strict';

  function getSB() {
    if (window._sbClient) return window._sbClient;
    if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY || !window.supabase) return null;
    window._sbClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    return window._sbClient;
  }

  // ── Niveaux ──
  var LEVELS = [
    { name: 'Novice', min: 0, icon: 'fa-seedling', color: '#4A7C6B' },
    { name: 'Apprenti', min: 100, icon: 'fa-leaf', color: '#4A7C6B' },
    { name: 'Convoyeur', min: 300, icon: 'fa-car', color: '#0A4D68' },
    { name: 'Confirmé', min: 600, icon: 'fa-route', color: '#0A4D68' },
    { name: 'Expert', min: 1000, icon: 'fa-medal', color: '#c9a56b' },
    { name: 'Légende', min: 2000, icon: 'fa-crown', color: '#c9a56b' }
  ];

  function getLevel(points) {
    var level = LEVELS[0];
    for (var i = 0; i < LEVELS.length; i++) {
      if (points >= LEVELS[i].min) level = LEVELS[i];
    }
    var nextLevel = null;
    for (var j = 0; j < LEVELS.length; j++) {
      if (LEVELS[j].min > points) { nextLevel = LEVELS[j]; break; }
    }
    return { current: level, next: nextLevel, points: points };
  }

  // ── Charger les badges et le niveau ──
  async function loadGamification(container) {
    var sb = getSB();
    if (!sb) return;

    try {
      var _auth = await sb.auth.getSession();
      if (!_auth.data || !_auth.data.session) {
        container.innerHTML = '<p style="color:var(--gray-mid);font-size:0.85rem;">Connectez-vous pour voir vos badges.</p>';
        return;
      }
      var userId = _auth.data.session.user.id;

      // Badges obtenus
      var _badges = await sb.from('convoyeur_badges')
        .select('*, badges(*)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      var myBadges = _badges.data || [];

      // Tous les badges disponibles
      var _allBadges = await sb.from('badges').select('*').order('points', { ascending: true });
      var allBadges = _allBadges.data || [];

      // Points (depuis la table points_fidelite si elle existe)
      var _pts = await sb.from('solde_fidelite').select('*').eq('user_id', userId).maybeSingle();
      var points = (_pts.data && _pts.data.solde_points) || 0;

      var levelInfo = getLevel(points);

      // Afficher
      var html = '';

      // Niveau
      html += '<div class="gamif-level-card">';
      html += '<div class="gamif-level-icon" style="color:' + levelInfo.current.color + ';"><i class="fas ' + levelInfo.current.icon + '"></i></div>';
      html += '<div class="gamif-level-info">';
      html += '<div class="gamif-level-name">' + escapeHTML(levelInfo.current.name) + '</div>';
      html += '<div class="gamif-level-points">' + points + ' points</div>';
      if (levelInfo.next) {
        var progress = Math.min(100, Math.round((points - levelInfo.current.min) / (levelInfo.next.min - levelInfo.current.min) * 100));
        html += '<div class="gamif-progress-bar"><div class="gamif-progress-fill" style="width:' + progress + '%;"></div></div>';
        html += '<div class="gamif-progress-text">' + (levelInfo.next.min - points) + ' pts jusqu\'à ' + escapeHTML(levelInfo.next.name) + '</div>';
      } else {
        html += '<div class="gamif-progress-text">Niveau maximum atteint ! 🏆</div>';
      }
      html += '</div></div>';

      // Badges
      html += '<div class="gamif-badges-section">';
      html += '<h4 style="font-family:Montserrat,sans-serif;font-size:1rem;margin-bottom:16px;color:var(--bordeaux);"><i class="fas fa-medal" style="margin-right:8px;"></i>Badges (' + myBadges.length + '/' + allBadges.length + ')</h4>';
      html += '<div class="gamif-badges-grid">';

      allBadges.forEach(function(b) {
        var earned = myBadges.find(function(mb) { return mb.badge_id === b.id; });
        var cls = earned ? 'gamif-badge earned' : 'gamif-badge locked';
        var opacity = earned ? '1' : '0.4';
        html += '<div class="' + cls + '" title="' + escapeHTML(b.description) + '">';
        html += '<div class="gamif-badge-icon" style="color:' + escapeHTML(b.couleur) + ';opacity:' + opacity + ';"><i class="fas ' + escapeHTML(b.icon) + '"></i></div>';
        html += '<div class="gamif-badge-name">' + escapeHTML(b.nom) + '</div>';
        if (!earned) html += '<div class="gamif-badge-locked"><i class="fas fa-lock"></i></div>';
        html += '</div>';
      });

      html += '</div></div>';

      container.innerHTML = html;
    } catch (err) {
      console.error('Erreur loadGamification:', err);
      container.innerHTML = '<p style="color:var(--gray-mid);font-size:0.85rem;">Erreur lors du chargement.</p>';
    }
  }

  // ── Push notifications ──

  function pushSupported() {
    return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
  }

  function vapidConfigured() {
    return !!(window.VAPID_PUBLIC_KEY && window.VAPID_PUBLIC_KEY.length > 0);
  }

  function showPushStatus(msg) {
    var el = document.getElementById('pushStatus');
    if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
  }

  function showSwal(title, text, icon, timer) {
    if (typeof Swal !== 'undefined') {
      var opts = { title: title, text: text, icon: icon };
      if (timer) { opts.timer = timer; opts.showConfirmButton = false; }
      Swal.fire(opts);
    }
  }

  // Refresh push UI state based on browser support, permission, and subscription.
  // Does NOT request permission or subscribe — only inspects current state.
  async function refreshPushUIState() {
    var btnEnable = document.getElementById('btnEnablePush');
    var btnDisable = document.getElementById('btnDisablePush');
    if (!btnEnable || !btnDisable) return;

    // Reset
    btnEnable.style.display = 'none';
    btnDisable.style.display = 'none';
    showPushStatus('');

    if (!pushSupported()) {
      showPushStatus('Les notifications push ne sont pas supportées par votre navigateur.');
      return;
    }

    if (!vapidConfigured()) {
      btnEnable.style.display = 'block';
      btnEnable.disabled = true;
      btnEnable.style.opacity = '0.5';
      btnEnable.style.cursor = 'not-allowed';
      showPushStatus('Configuration des notifications indisponible. Veuillez réessayer plus tard.');
      return;
    }

    btnEnable.disabled = false;
    btnEnable.style.opacity = '1';
    btnEnable.style.cursor = 'pointer';

    var permission = Notification.permission;

    if (permission === 'denied') {
      showPushStatus('Les notifications ont été bloquées. Réactivez-les dans les paramètres de votre navigateur.');
      return;
    }

    // Check existing subscription
    try {
      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (sub) {
        btnEnable.style.display = 'none';
        btnDisable.style.display = 'block';
      } else {
        btnEnable.style.display = 'block';
        btnDisable.style.display = 'none';
      }
    } catch (err) {
      console.error('refreshPushUIState:', err);
      btnEnable.style.display = 'block';
      btnDisable.style.display = 'none';
    }
  }

  async function subscribePush() {
    if (!pushSupported()) {
      showSwal('Non supporté', 'Les notifications push ne sont pas supportées par votre navigateur.', 'warning');
      return;
    }

    if (!vapidConfigured()) {
      showSwal('Configuration manquante', 'Les notifications push ne sont pas configurées sur ce site. Veuillez réessayer plus tard.', 'warning');
      return;
    }

    try {
      var permission = await Notification.requestPermission();
      if (permission === 'denied') {
        showSwal('Notifications bloquées', 'Vous avez refusé les notifications. Réactivez-les dans les paramètres de votre navigateur.', 'info');
        await refreshPushUIState();
        return;
      }
      if (permission !== 'granted') {
        // Dismissed or default — no subscription attempt
        await refreshPushUIState();
        return;
      }

      var reg = await navigator.serviceWorker.ready;

      // Check existing subscription first — avoid duplicates
      var existingSub = await reg.pushManager.getSubscription();
      var sub = existingSub;

      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(window.VAPID_PUBLIC_KEY)
        });
      }

      var sb = getSB();
      if (!sb) {
        showSwal('Erreur', 'Impossible de se connecter au service. Veuillez vous connecter.', 'error');
        return;
      }

      var _auth = await sb.auth.getSession();
      if (!_auth.data || !_auth.data.session) {
        showSwal('Erreur', 'Vous devez être connecté pour activer les notifications.', 'error');
        return;
      }

      var userId = _auth.data.session.user.id;
      var endpoint = sub.endpoint;
      var p256dh = arrayBufferToBase64(sub.getKey('p256dh'));
      var authKey = arrayBufferToBase64(sub.getKey('auth'));

      // Persistence: SELECT first, then INSERT or UPDATE as needed.
      // Uses owner-only UPDATE RLS policy (P3-B2.2B) to refresh keys
      // when the browser re-subscribes with the same endpoint but new keys.
      // Does NOT change user_id or endpoint — only p256dh, auth_key, user_agent.
      var _existing = await sb.from('push_subscriptions')
        .select('id, p256dh, auth_key, user_agent')
        .eq('user_id', userId)
        .eq('endpoint', endpoint)
        .maybeSingle();

      if (_existing.error) {
        throw _existing.error;
      }

      if (!_existing.data) {
        // No existing row for this endpoint — INSERT
        var _insert = await sb.from('push_subscriptions').insert({
          user_id: userId,
          endpoint: endpoint,
          p256dh: p256dh,
          auth_key: authKey,
          user_agent: navigator.userAgent
        });

        if (_insert.error) {
          // Persistence failed — roll back browser subscription to avoid inconsistency
          try { await sub.unsubscribe(); } catch (e) { /* best effort */ }
          throw _insert.error;
        }
      } else {
        // Row exists — check if keys/user_agent differ
        var _row = _existing.data;
        if (_row.p256dh !== p256dh || _row.auth_key !== authKey || _row.user_agent !== navigator.userAgent) {
          // Keys changed — UPDATE only mutable columns, scoped to user_id + endpoint
          var _update = await sb.from('push_subscriptions')
            .update({
              p256dh: p256dh,
              auth_key: authKey,
              user_agent: navigator.userAgent
            })
            .eq('user_id', userId)
            .eq('endpoint', endpoint);

          if (_update.error) {
            throw _update.error;
          }
        }
        // If keys unchanged — no-op
      }

      showSwal('Activé !', 'Vous recevrez les notifications push.', 'success', 2000);
      await refreshPushUIState();
    } catch (err) {
      console.error('Erreur subscribePush:', err);
      showSwal('Erreur', 'L\'activation des notifications a échoué. Veuillez réessayer.', 'error');
      await refreshPushUIState();
    }
  }

  async function unsubscribePush() {
    if (!pushSupported()) {
      showSwal('Non supporté', 'Les notifications push ne sont pas supportées par votre navigateur.', 'warning');
      return;
    }

    try {
      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();

      if (!sub) {
        // Already unsubscribed — clean up any stale DB rows for this user
        var sb0 = getSB();
        if (sb0) {
          var _auth0 = await sb0.auth.getSession();
          if (_auth0.data && _auth0.data.session) {
            // No browser subscription to identify endpoint — nothing to delete safely
          }
        }
        await refreshPushUIState();
        return;
      }

      // Capture endpoint before unsubscribing
      var endpoint = sub.endpoint;

      // Unsubscribe browser subscription
      await sub.unsubscribe();

      // Delete only the matching DB row (per-device, not per-user)
      var sb = getSB();
      if (sb) {
        var _auth = await sb.auth.getSession();
        if (_auth.data && _auth.data.session) {
          var _del = await sb.from('push_subscriptions')
            .delete()
            .eq('user_id', _auth.data.session.user.id)
            .eq('endpoint', endpoint);

          if (_del.error) {
            console.error('DB cleanup failed:', _del.error);
            showSwal('Attention', 'Désactivé de votre navigateur, mais une erreur est survenue lors de la suppression du serveur.', 'warning');
          } else {
            showSwal('Désactivé', 'Vous ne recevrez plus les notifications push.', 'success', 2000);
          }
        } else {
          showSwal('Désactivé', 'Vous ne recevrez plus les notifications push.', 'success', 2000);
        }
      } else {
        showSwal('Désactivé', 'Vous ne recevrez plus les notifications push.', 'success', 2000);
      }

      await refreshPushUIState();
    } catch (err) {
      console.error('Erreur unsubscribePush:', err);
      showSwal('Erreur', 'La désactivation des notifications a échoué. Veuillez réessayer.', 'error');
      await refreshPushUIState();
    }
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var output = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
    return output;
  }

  function arrayBufferToBase64(buf) {
    if (!buf) return null;
    var bytes = new Uint8Array(buf);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function escapeHTML(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  document.addEventListener('DOMContentLoaded', function () {
    var container = document.getElementById('gamificationContainer');
    if (container) loadGamification(container);

    var btnSub = document.getElementById('btnEnablePush');
    if (btnSub) btnSub.addEventListener('click', subscribePush);

    var btnUnsub = document.getElementById('btnDisablePush');
    if (btnUnsub) btnUnsub.addEventListener('click', unsubscribePush);

    // Detect initial push UI state (no auto-subscribe, no permission request)
    refreshPushUIState();
  });

  window.BathilyGamification = {
    load: loadGamification,
    subscribePush: subscribePush,
    unsubscribePush: unsubscribePush,
    refreshPushUIState: refreshPushUIState,
    pushSupported: pushSupported,
    vapidConfigured: vapidConfigured,
    getLevel: getLevel,
    LEVELS: LEVELS
  };
})();
