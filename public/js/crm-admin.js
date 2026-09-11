// =========================================================
// P3C1 — CRM Admin Foundation
// =========================================================
// Read-only CRM layer for the Bathily-Convoyage admin panel.
// Uses ONLY the anon-key Supabase client (window.getSupabase)
// with the authenticated admin session. RLS gates all reads.
//
// No privileged backend credentials are referenced anywhere in
// this file. No direct stage mutation. No pipeline_event /
// crm_link_event writes. No immutable-event mutation.
//
// Data sources:
//   RPC: crm_organizations_summary()
//   RPC: crm_timeline_read(p_organization_id, p_mission_id,
//        p_opportunity_id, p_client_id, p_limit,
//        p_before_event_at, p_before_event_key)
//   Tables (RLS = is_internal_user()):
//     organizations, organization_segments, organization_sites,
//     organization_contacts, crm_opportunities, crm_activities,
//     devis, missions
// =========================================================

(function () {
  'use strict';

  // ---------------------------------------------------------
  // Constants — mirror the DB CHECK constraints exactly.
  // ---------------------------------------------------------
  var STAGES = [
    'lead', 'qualified', 'contacted', 'meeting',
    'quote_requested', 'quote_sent', 'negotiating',
    'won', 'lost', 'dormant'
  ];
  var STAGE_LABELS = {
    lead: 'Lead',
    qualified: 'Qualifiée',
    contacted: 'Contactée',
    meeting: 'Rendez-vous',
    quote_requested: 'Devis demandé',
    quote_sent: 'Devis envoyé',
    negotiating: 'Négociation',
    won: 'Gagnée',
    lost: 'Perdue',
    dormant: 'En sommeil'
  };
  var STAGE_PILL = {
    lead: 'sp-att', qualified: 'sp-att', contacted: 'sp-att',
    meeting: 'sp-cours', quote_requested: 'sp-cours',
    quote_sent: 'sp-cours', negotiating: 'sp-cours',
    won: 'sp-ok', lost: 'sp-err', dormant: 'sp-att'
  };

  var ACTIVITY_TYPES = [
    'call', 'email', 'meeting', 'note', 'task',
    'follow_up', 'sms', 'whatsapp', 'other'
  ];
  var ACTIVITY_TYPE_LABELS = {
    call: 'Appel', email: 'Email', meeting: 'Réunion', note: 'Note',
    task: 'Tâche', follow_up: 'Relance', sms: 'SMS',
    whatsapp: 'WhatsApp', other: 'Autre'
  };
  var ACTIVITY_TYPE_ICON = {
    call: 'fa-phone', email: 'fa-envelope', meeting: 'fa-users',
    note: 'fa-sticky-note', task: 'fa-check-square',
    follow_up: 'fa-redo', sms: 'fa-comment', whatsapp: 'fa-whatsapp',
    other: 'fa-ellipsis-h'
  };

  var ACTIVITY_STATUS = ['pending', 'in_progress', 'completed', 'cancelled'];
  var ACTIVITY_STATUS_LABELS = {
    pending: 'En attente', in_progress: 'En cours',
    completed: 'Terminée', cancelled: 'Annulée'
  };
  var ACTIVITY_STATUS_PILL = {
    pending: 'sp-att', in_progress: 'sp-cours',
    completed: 'sp-ok', cancelled: 'sp-err'
  };

  var ORG_STATUS_LABELS = {
    active: 'Actif', inactive: 'Inactif', archived: 'Archivé'
  };
  var ORG_STATUS_PILL = {
    active: 'sp-ok', inactive: 'sp-att', archived: 'sp-err'
  };

  var SEGMENTS = [
    'concession', 'garage', 'rental', 'auction', 'notary',
    'fleet', 'leasing', 'dealer', 'logistics', 'other'
  ];
  var SEGMENT_LABELS = {
    concession: 'Concession', garage: 'Garage', rental: 'Location',
    auction: 'Enchères', notary: 'Notaire', fleet: 'Flotte',
    leasing: 'Leasing', dealer: 'Concessionnaire',
    logistics: 'Logistique', other: 'Autre'
  };

  var SOURCE_LABELS = {
    pipeline_event: 'Pipeline',
    mission_event: 'Mission',
    billing_event: 'Facturation',
    devis: 'Devis',
    mission: 'Mission',
    activity: 'Activité'
  };
  var SOURCE_ICON = {
    pipeline_event: 'fa-stream', mission_event: 'fa-route',
    billing_event: 'fa-file-invoice', devis: 'fa-calculator',
    mission: 'fa-truck', activity: 'fa-handshake'
  };
  var RECORD_KIND_LABELS = {
    immutable_event: 'Événement immuable',
    state_projection: "Projection d'état"
  };

  var TIMELINE_DEFAULT_LIMIT = 50;
  var TIMELINE_MAX_LIMIT = 200;

  // ---------------------------------------------------------
  // State
  // ---------------------------------------------------------
  var _orgSummary = [];          // crm_organizations_summary() rows
  var _orgMap = {};              // id -> summary row (name lookup)
  var _orgFilters = { q: '', status: 'all', sort: 'legal_name', dir: 'asc' };
  var _oppData = [];
  var _oppMap = {};              // id -> opportunity row (edit lookup)
  var _oppFilters = { q: '', stage: 'all' };
  var _actData = [];
  var _actMap = {};              // id -> activity row (edit lookup)
  var _actFilters = { q: '', type: 'all', status: 'all', org: 'all' };
  var _siteMap = {};             // id -> site row (edit lookup, org detail)
  var _contactMap = {};          // id -> contact row (edit lookup + name lookup)
  var _orgSegments = [];         // current org detail segments (CHECK-constrained)
  var _tlFilters = { organizationId: null, missionId: null, opportunityId: null, clientId: null };
  var _tlCursor = { eventAt: null, eventKey: null, hasMore: false, loading: false };
  var _orgDetailTimelineCursor = { eventAt: null, eventKey: null, hasMore: false, loading: false };
  var _currentOrgId = null;

  // ---------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------
  function sb() {
    if (typeof window.getSupabase === 'function') return window.getSupabase();
    return null;
  }
  function esc(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDate(s) {
    if (!s) return '—';
    var d = new Date(s);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtDateTime(s) {
    if (!s) return '—';
    var d = new Date(s);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtEur(n) {
    if (n == null || n === '') return '—';
    var num = Number(n);
    if (!isFinite(num)) return '—';
    return num.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' €';
  }
  function fmtInt(n) {
    if (n == null) return '0';
    var num = Number(n);
    if (!isFinite(num)) return '0';
    return String(num);
  }
  function pill(text, cls, icon) {
    var ic = icon ? '<i class="fas ' + icon + '"></i> ' : '';
    return '<span class="sp ' + (cls || 'sp-att') + '"><span class="sp-dot"></span>' + ic + esc(text) + '</span>';
  }
  function orgName(id) {
    var r = _orgMap[id];
    if (!r) return '—';
    return esc(r.trade_name || r.legal_name || '—');
  }
  function contactName(c) {
    if (!c) return '—';
    var n = ((c.first_name || '') + ' ' + (c.last_name || '')).trim();
    return n || '—';
  }
  function setLoading(id, msg) {
    var el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '<div class="crm-state"><i class="fas fa-spinner fa-spin"></i> ' + esc(msg || 'Chargement…') + '</div>';
  }
  function setEmpty(id, msg) {
    var el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '<div class="crm-state crm-empty"><i class="fas fa-inbox"></i> ' + esc(msg || 'Aucune donnée.') + '</div>';
  }
  function setError(id, msg) {
    var el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '<div class="crm-state crm-error"><i class="fas fa-exclamation-triangle"></i> ' + esc(msg || 'Erreur de chargement.') + '</div>';
  }

  // ---------------------------------------------------------
  // RM01A-005: CRM error sanitization (trusted-mapping model)
  // ---------------------------------------------------------
  // SECURITY INVARIANT: crmUserError() never returns the raw database
  // error message (msg) directly. For every server/database-originated
  // error classification, it returns a STATIC TRUSTED French string
  // from CRM_ERROR_MAP (or a generic fallback). The raw message is only
  // used for classification (regex test) and logged to console.error
  // for diagnostics — never rendered to the DOM.
  //
  // Frontend-only validation strings (setModalError with hardcoded
  // French text, not from Supabase) bypass this helper entirely and
  // are trusted by construction.
  //
  // Map structure: { test: RegExp, message: "Fixed trusted French text." }
  // The regex classifies the raw input; the fixed message is the output.
  // OUTPUT != raw input for every server/database error.
  var CRM_ERROR_MAP = [
    // Authorization / internal-user gate (RPCs raise these)
    { test: /^Réservé aux utilisateurs internes/, message: "Réservé aux utilisateurs internes." },
    { test: /^Authentification requise/, message: "Authentification requise." },
    { test: /^Non autorisé/, message: "Accès refusé. Cette opération nécessite un utilisateur interne (admin/opérateur)." },
    // Contact/org integrity (triggers + RPCs)
    { test: /^Un contact nécessite une organisation/, message: "Un contact nécessite une organisation." },
    { test: /^Contact introuvable/, message: "Contact introuvable." },
    { test: /Le contact n'appartient pas à cette organisation/, message: "Le contact n'appartient pas à cette organisation." },
    // Opportunity pipeline (crm_transition_opportunity RPC)
    { test: /^Opportunité introuvable/, message: "Opportunité introuvable." },
    { test: /^Transition non autorisée/, message: "Transition non autorisée." },
    { test: /^Transition no-op/, message: "Transition no-op : aucune modification." },
    // Business links (devis/mission integrity)
    { test: /^Le devis doit avoir la même organisation/, message: "Le devis doit avoir la même organisation que l'opportunité." },
    { test: /L'opportunité n'appartient pas à cette organisation/, message: "L'opportunité n'appartient pas à cette organisation." },
    { test: /Le client n'appartient pas à cette organisation/, message: "Le client n'appartient pas à cette organisation." },
    { test: /^Devis introuvable/, message: "Devis introuvable." },
    { test: /^La mission doit avoir la même organisation/, message: "La mission doit avoir la même organisation que le devis." },
    { test: /Le devis n'appartient pas à cette organisation/, message: "Le devis n'appartient pas à cette organisation." },
    // Timeline cursor contract (crm_timeline_read RPC)
    { test: /^Curseur invalide/, message: "Curseur de pagination invalide." },
    // Organization lookup
    { test: /^Organisation introuvable/, message: "Organisation introuvable." }
  ];
  function crmUserError(err, fallback) {
    if (!err) return fallback || 'Une erreur est survenue. Veuillez réessayer.';
    // Always log raw error for diagnostics (never rendered to DOM).
    console.error('[CRM] error:', err);
    var msg = (err && typeof err === 'object' && err.message) ? err.message : String(err);
    // Classify against the trusted map. Return the FIXED message, never msg.
    for (var i = 0; i < CRM_ERROR_MAP.length; i++) {
      if (CRM_ERROR_MAP[i].test.test(msg)) {
        return CRM_ERROR_MAP[i].message;
      }
    }
    // RLS / authorization errors (SQLSTATE 42501, jwt, permission-denied):
    // stable, safe, honest message. Checked after business map to avoid
    // false matches like "Transition non autorisée" (business rule, not RLS).
    if (/42501|jwt|^permission/i.test(msg)) {
      return "Accès refusé par la base de données. Cette opération nécessite un utilisateur interne (admin/opérateur).";
    }
    // Everything else: generic fallback (raw detail not rendered to DOM).
    return fallback || 'Une erreur est survenue. Veuillez réessayer.';
  }

  function handleRpcError(error, containerId, context) {
    console.error('[CRM] ' + (context || 'RPC error') + ':', error);
    setError(containerId, crmUserError(error, 'Erreur de chargement.'));
  }

  // ---------------------------------------------------------
  // Cursor construction — enforces the P3B6 contract:
  // p_before_event_at and p_before_event_key must be BOTH NULL
  // or BOTH non-NULL. A mixed cursor is rejected by the RPC.
  // ---------------------------------------------------------
  function buildTimelineParams(filters, cursor, limit) {
    var p = {
      p_limit: Math.min(Math.max(limit == null ? TIMELINE_DEFAULT_LIMIT : limit, 1), TIMELINE_MAX_LIMIT)
    };
    if (filters) {
      if (filters.organizationId) p.p_organization_id = filters.organizationId;
      if (filters.missionId) p.p_mission_id = filters.missionId;
      if (filters.opportunityId) p.p_opportunity_id = filters.opportunityId;
      if (filters.clientId) p.p_client_id = filters.clientId;
    }
    // Cursor pair: both NULL (first page) or both non-NULL (next page).
    if (cursor && cursor.eventAt != null && cursor.eventKey != null) {
      p.p_before_event_at = cursor.eventAt;
      p.p_before_event_key = cursor.eventKey;
    }
    return p;
  }

  // ---------------------------------------------------------
  // CRM DASHBOARD
  // ---------------------------------------------------------
  async function loadCrmDashboard() {
    var client = sb();
    if (!client) { setError('crmDashboardKpis', 'Client Supabase indisponible.'); return; }
    setLoading('crmDashboardKpis', 'Chargement des indicateurs…');
    try {
      var res = await client.rpc('crm_organizations_summary');
      if (res.error) { handleRpcError(res.error, 'crmDashboardKpis', 'crm_organizations_summary'); return; }
      _orgSummary = res.data || [];
      _orgMap = {};
      _orgSummary.forEach(function (r) { _orgMap[r.organization_id] = r; });
      renderCrmDashboard(_orgSummary);
      // Populate org filter selects that depend on the summary.
      populateOrgSelects();
    } catch (e) { handleRpcError(e, 'crmDashboardKpis', 'crm_organizations_summary'); }
  }

  function renderCrmDashboard(rows) {
    var total = rows.length;
    var active = rows.filter(function (r) { return r.status === 'active'; }).length;
    var oppCount = rows.reduce(function (s, r) { return s + (Number(r.opportunities_count) || 0); }, 0);
    var openOpp = rows.reduce(function (s, r) { return s; }, 0); // computed in opp page; here approximate
    var pipeline = rows.reduce(function (s, r) { return s + (Number(r.pipeline_value) || 0); }, 0);
    var actCount = rows.reduce(function (s, r) { return s + (Number(r.activities_count) || 0); }, 0);
    var devisCount = rows.reduce(function (s, r) { return s + (Number(r.devis_count) || 0); }, 0);
    var missionCount = rows.reduce(function (s, r) { return s + (Number(r.missions_count) || 0); }, 0);
    var billingCount = rows.reduce(function (s, r) { return s + (Number(r.billing_count) || 0); }, 0);

    // "open opportunities" cannot be derived from the summary RPC alone
    // (it has no per-stage breakdown). Omitted here — reported as future
    // enhancement. We display total opportunities instead.
    var html = '';
    function card(id, ico, val, lbl) {
      return '<div class="stat-card"><div class="stat-ico"><i class="fas ' + ico + '"></i></div>' +
        '<div class="stat-val" id="' + id + '">' + val + '</div>' +
        '<div class="stat-lbl">' + lbl + '</div></div>';
    }
    html += card('kpiTotalOrgs', 'fa-building', fmtInt(total), 'Organisations');
    html += card('kpiActiveOrgs', 'fa-circle-check', fmtInt(active), 'Organisations actives');
    html += card('kpiOpps', 'fa-bullseye', fmtInt(oppCount), 'Opportunités');
    html += card('kpiPipeline', 'fa-euro-sign', fmtEur(pipeline), 'Valeur pipeline');
    html += card('kpiActivities', 'fa-list-check', fmtInt(actCount), 'Activités');
    html += card('kpiDevis', 'fa-calculator', fmtInt(devisCount), 'Devis');
    html += card('kpiMissions', 'fa-route', fmtInt(missionCount), 'Missions');
    html += card('kpiBilling', 'fa-file-invoice', fmtInt(billingCount), 'Factures');

    var wrap = document.getElementById('crmDashboardKpis');
    if (wrap) wrap.innerHTML = html;

    // Recent activity (top 5 organizations by last_activity_at)
    var recent = rows
      .filter(function (r) { return r.last_activity_at; })
      .sort(function (a, b) { return new Date(b.last_activity_at) - new Date(a.last_activity_at); })
      .slice(0, 5);
    var rec = document.getElementById('crmDashboardRecent');
    if (rec) {
      if (!recent.length) {
        rec.innerHTML = '<div class="crm-state crm-empty"><i class="fas fa-inbox"></i> Aucune activité récente.</div>';
      } else {
        rec.innerHTML = recent.map(function (r) {
          return '<div class="crm-recent-row" tabindex="0" role="button" onclick="CrmAdmin.openOrgDetail(\'' + r.organization_id + '\')">' +
            '<div class="crm-recent-name">' + esc(r.trade_name || r.legal_name || '—') + '</div>' +
            '<div class="crm-recent-meta">' + pill(ORG_STATUS_LABELS[r.status] || r.status, ORG_STATUS_PILL[r.status]) +
            ' <span class="crm-muted">' + fmtDateTime(r.last_activity_at) + '</span></div></div>';
        }).join('');
      }
    }
  }

  // ---------------------------------------------------------
  // ORGANIZATIONS LIST
  // ---------------------------------------------------------
  async function loadCrmOrganizations() {
    var client = sb();
    if (!client) { setError('crmOrgTableBody', 'Client Supabase indisponible.'); return; }
    // Reuse the summary already loaded by the dashboard; if empty, fetch.
    if (!_orgSummary.length) {
      setLoading('crmOrgTableBody', 'Chargement des organisations…');
      try {
        var res = await client.rpc('crm_organizations_summary');
        if (res.error) { handleRpcError(res.error, 'crmOrgTableBody', 'crm_organizations_summary'); return; }
        _orgSummary = res.data || [];
        _orgMap = {};
        _orgSummary.forEach(function (r) { _orgMap[r.organization_id] = r; });
        populateOrgSelects();
      } catch (e) { handleRpcError(e, 'crmOrgTableBody', 'crm_organizations_summary'); return; }
    }
    renderCrmOrganizations();
  }

  function renderCrmOrganizations() {
    var rows = _orgSummary.slice();
    // Filter: status
    if (_orgFilters.status !== 'all') {
      rows = rows.filter(function (r) { return r.status === _orgFilters.status; });
    }
    // Filter: search (legal_name / trade_name)
    var q = (_orgFilters.q || '').trim().toLowerCase();
    if (q) {
      rows = rows.filter(function (r) {
        return ((r.legal_name || '').toLowerCase().indexOf(q) !== -1) ||
               ((r.trade_name || '').toLowerCase().indexOf(q) !== -1);
      });
    }
    // Sort
    var sortKey = _orgFilters.sort;
    var dir = _orgFilters.dir === 'desc' ? -1 : 1;
    rows.sort(function (a, b) {
      var va = a[sortKey], vb = b[sortKey];
      if (sortKey === 'legal_name' || sortKey === 'trade_name') {
        va = (va || va === '' ? va : a.legal_name) || '';
        vb = (vb || vb === '' ? vb : b.legal_name) || '';
        return dir * String(va).toLowerCase().localeCompare(String(vb).toLowerCase());
      }
      if (sortKey === 'last_activity_at') {
        va = va ? new Date(va).getTime() : 0;
        vb = vb ? new Date(vb).getTime() : 0;
        return dir * (va - vb);
      }
      va = Number(va) || 0; vb = Number(vb) || 0;
      return dir * (va - vb);
    });

    var countEl = document.getElementById('crmOrgCount');
    if (countEl) countEl.innerHTML = rows.length + ' organisation' + (rows.length > 1 ? 's' : '') + ' <em>active(s)</em> ' +
      '<button class="btn-red btn-sm" style="margin-left:8px;" onclick="CrmAdmin.openCreateOrgForm()"><i class="fas fa-plus"></i> Nouvelle</button>';

    var tbody = document.getElementById('crmOrgTableBody');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">Aucune organisation trouvée.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (r) {
      var name = esc(r.trade_name || r.legal_name || '—');
      var legal = r.trade_name ? '<div class="crm-muted">' + esc(r.legal_name) + '</div>' : '';
      var st = pill(ORG_STATUS_LABELS[r.status] || r.status, ORG_STATUS_PILL[r.status]);
      var lastAct = r.last_activity_at ? fmtDate(r.last_activity_at) : '—';
      return '<tr class="clickable-row" style="cursor:pointer;" onclick="CrmAdmin.openOrgDetail(\'' + r.organization_id + '\')">' +
        '<td><div class="crm-org-name">' + name + '</div>' + legal + '</td>' +
        '<td>' + st + '</td>' +
        '<td>' + fmtInt(r.contacts_count) + '</td>' +
        '<td>' + fmtInt(r.opportunities_count) + '</td>' +
        '<td>' + fmtInt(r.activities_count) + '</td>' +
        '<td>' + fmtInt(r.devis_count) + '</td>' +
        '<td>' + fmtInt(r.missions_count) + '</td>' +
        '<td class="td-price">' + fmtEur(r.pipeline_value) + '</td>' +
        '<td>' + lastAct + '</td>' +
        '</tr>';
    }).join('');
  }

  function setOrgFilter(key, val) {
    _orgFilters[key] = val;
    renderCrmOrganizations();
  }
  function setOrgSort(col) {
    if (_orgFilters.sort === col) {
      _orgFilters.dir = _orgFilters.dir === 'asc' ? 'desc' : 'asc';
    } else {
      _orgFilters.sort = col;
      _orgFilters.dir = col === 'pipeline_value' || col === 'last_activity_at' ? 'desc' : 'asc';
    }
    renderCrmOrganizations();
  }

  // ---------------------------------------------------------
  // ORGANIZATION DETAIL
  // ---------------------------------------------------------
  function openCrmOrgDetail(id) {
    // Defensive navigation guard: never issue a Supabase query with an
    // empty/null organization id. Rows without organization_id must not
    // behave as normal org navigation targets.
    if (!id) return;
    _currentOrgId = id;
    var listV = document.getElementById('crmOrgListView');
    var detV = document.getElementById('crmOrgDetailView');
    if (listV) listV.style.display = 'none';
    if (detV) detV.style.display = 'block';
    loadCrmOrgDetail(id);
  }
  function closeCrmOrgDetail() {
    var listV = document.getElementById('crmOrgListView');
    var detV = document.getElementById('crmOrgDetailView');
    if (listV) listV.style.display = 'block';
    if (detV) detV.style.display = 'none';
    _currentOrgId = null;
    _orgDetailTimelineCursor = { eventAt: null, eventKey: null, hasMore: false, loading: false };
  }

  async function loadCrmOrgDetail(id) {
    var client = sb();
    if (!client) { setError('crmOrgDetailBody', 'Client Supabase indisponible.'); return; }
    setLoading('crmOrgDetailBody', 'Chargement de l\'organisation…');
    try {
      // Identity
      var orgRes = await client.from('organizations')
        .select('id,legal_name,trade_name,siret,siren,vat_number,email,phone,website,source,source_detail,external_reference,status,notes,created_at')
        .eq('id', id).maybeSingle();
      if (orgRes.error) { handleRpcError(orgRes.error, 'crmOrgDetailBody', 'organizations select'); return; }
      if (!orgRes.data) { setError('crmOrgDetailBody', 'Organisation introuvable.'); return; }

      // Parallel reads of children + linked entities.
      var segRes = await client.from('organization_segments').select('segment').eq('organization_id', id);
      var sitesRes = await client.from('organization_sites')
        .select('id,name,site_type,address_line1,address_line2,postal_code,city,country,phone,email,active')
        .eq('organization_id', id).order('created_at', { ascending: true });
      var contactsRes = await client.from('organization_contacts')
        .select('id,first_name,last_name,job_title,department,email,phone,mobile,preferred_channel,decision_maker,primary_contact,active,notes')
        .eq('organization_id', id).order('primary_contact', { ascending: false });
      var oppRes = await client.from('crm_opportunities')
        .select('id,title,stage,estimated_value,probability,source,next_action,next_action_at,last_contact_at,lost_reason,created_at')
        .eq('organization_id', id).order('created_at', { ascending: false });
      var actRes = await client.from('crm_activities')
        .select('id,activity_type,subject,status,occurred_at,due_at,completed_at,assigned_to,created_by,opportunity_id')
        .eq('organization_id', id).order('created_at', { ascending: false }).limit(50);
      var devisRes = await client.from('devis')
        .select('id,reference,status,total_ht,created_at')
        .eq('organization_id', id).order('created_at', { ascending: false }).limit(50);
      var missRes = await client.from('missions')
        .select('id,reference,status,created_at,devis_id')
        .eq('organization_id', id).order('created_at', { ascending: false }).limit(50);

      var errors = [segRes, sitesRes, contactsRes, oppRes, actRes, devisRes, missRes].filter(function (r) { return r.error; });
      if (errors.length) {
        // Surface the first error honestly. RLS denial stops the view.
        handleRpcError(errors[0].error, 'crmOrgDetailBody', 'org detail children');
        return;
      }

      renderCrmOrgDetail({
        org: orgRes.data,
        segments: (segRes.data || []).map(function (s) { return s.segment; }),
        sites: sitesRes.data || [],
        contacts: contactsRes.data || [],
        opportunities: oppRes.data || [],
        activities: actRes.data || [],
        devis: devisRes.data || [],
        missions: missRes.data || []
      });
      // Cache entity rows for ID-based edit lookup (avoids serializing
      // full database objects into inline onclick handlers).
      _siteMap = {};
      (sitesRes.data || []).forEach(function (s) { _siteMap[s.id] = s; });
      _contactMap = {};
      (contactsRes.data || []).forEach(function (c) { _contactMap[c.id] = c; });
      _orgSegments = (segRes.data || []).map(function (s) { return s.segment; });
      (oppRes.data || []).forEach(function (op) { _oppMap[op.id] = op; });
      (actRes.data || []).forEach(function (a) { _actMap[a.id] = a; });

      // Timeline (cursor-paginated)
      _orgDetailTimelineCursor = { eventAt: null, eventKey: null, hasMore: false, loading: false };
      await loadCrmOrgTimeline(id, true);
    } catch (e) { handleRpcError(e, 'crmOrgDetailBody', 'loadCrmOrgDetail'); }
  }

  function renderCrmOrgDetail(ctx) {
    var o = ctx.org;
    var html = '';

    // Back button + actions
    html += '<div class="crm-detail-actions"><button class="btn-outline crm-back" onclick="CrmAdmin.closeOrgDetail()"><i class="fas fa-arrow-left"></i> Retour</button>' +
      '<button class="btn-sm btn-red" onclick="CrmAdmin.openEditOrgForm(\'' + o.id + '\')"><i class="fas fa-edit"></i> Modifier</button>' +
      '<button class="btn-sm btn-outline" onclick="CrmAdmin.openSegmentManager(\'' + o.id + '\')"><i class="fas fa-tags"></i> Segments</button>' +
      '<button class="btn-sm btn-outline" onclick="CrmAdmin.archiveOrg(\'' + o.id + '\')"><i class="fas fa-archive"></i> Archiver</button></div>';

    // Identity
    html += '<div class="crm-detail-head"><h2 class="sec-h">' + esc(o.trade_name || o.legal_name) + '</h2>' +
      pill(ORG_STATUS_LABELS[o.status] || o.status, ORG_STATUS_PILL[o.status]) + '</div>';
    if (o.trade_name) html += '<div class="crm-muted" style="margin-bottom:8px;">Raison sociale : ' + esc(o.legal_name) + '</div>';

    var idRows = [
      ['Email', o.email], ['Téléphone', o.phone], ['Site web', o.website],
      ['Source', o.source ? (o.source + (o.source_detail ? ' (' + o.source_detail + ')' : '')) : null],
      ['Référence externe', o.external_reference]
    ];
    // Legal IDs (SIRET/SIREN/VAT) are operator-redacted in the summary RPC but
    // the organizations table itself is readable by internal users (RLS), so
    // they are shown here for the admin context.
    idRows.push(['SIRET', o.siret], ['SIREN', o.siren], ['TVA', o.vat_number]);
    html += '<div class="crm-info-grid">';
    idRows.forEach(function (r) {
      html += '<div class="crm-info-item"><span class="crm-info-lbl">' + r[0] + '</span><span class="crm-info-val">' + esc(r[1] || '—') + '</span></div>';
    });
    html += '</div>';
    if (o.notes) html += '<div class="crm-notes"><span class="crm-info-lbl">Notes</span><div>' + esc(o.notes) + '</div></div>';

    // Segments
    html += '<div class="sec-title"><h3 class="crm-sub-h">Segments</h3></div>';
    if (ctx.segments.length) {
      html += '<div class="crm-tags">' + ctx.segments.map(function (s) {
        return '<span class="crm-tag">' + esc(SEGMENT_LABELS[s] || s) + '</span>';
      }).join('') + '</div>';
    } else {
      html += '<div class="crm-muted">Aucun segment.</div>';
    }

    // Sites
    html += '<div class="sec-title"><h3 class="crm-sub-h">Sites (' + ctx.sites.length + ')</h3>' +
      '<button class="btn-sm btn-outline crm-sec-btn" onclick="CrmAdmin.openCreateSiteForm(\'' + o.id + '\')"><i class="fas fa-plus"></i> Site</button></div>';
    if (ctx.sites.length) {
      html += '<div class="crm-card-grid">';
      ctx.sites.forEach(function (s) {
        var addr = [s.address_line1, s.address_line2, s.postal_code, s.city, s.country]
          .filter(Boolean).map(esc).join(', ');
        html += '<div class="crm-card">' +
          '<div class="crm-card-h"><span class="crm-card-t">' + esc(s.name) + '</span>' +
          (s.active ? pill('Actif', 'sp-ok') : pill('Inactif', 'sp-att')) + '</div>' +
          '<div class="crm-muted">' + esc(s.site_type) + '</div>' +
          (addr ? '<div class="crm-muted">' + addr + '</div>' : '') +
          (s.phone || s.email ? '<div class="crm-muted">' + esc(s.phone || '') + ' ' + esc(s.email || '') + '</div>' : '') +
          '<button class="btn-sm btn-outline crm-card-btn" onclick="CrmAdmin.openEditSiteForm(\'' + o.id + '\',\'' + s.id + '\')"><i class="fas fa-edit"></i></button>' +
          '</div>';
      });
      html += '</div>';
    } else {
      html += '<div class="crm-muted">Aucun site.</div>';
    }

    // Contacts
    html += '<div class="sec-title"><h3 class="crm-sub-h">Contacts (' + ctx.contacts.length + ')</h3>' +
      '<button class="btn-sm btn-outline crm-sec-btn" onclick="CrmAdmin.openCreateContactForm(\'' + o.id + '\')"><i class="fas fa-plus"></i> Contact</button></div>';
    if (ctx.contacts.length) {
      html += '<div class="table-scroll"><table class="data-table"><thead><tr>' +
        '<th>Nom</th><th>Fonction</th><th>Email</th><th>Téléphone</th><th>Canal</th><th>Rôle</th><th>Statut</th></tr></thead><tbody>';
      ctx.contacts.forEach(function (c) {
        var roles = [];
        if (c.primary_contact) roles.push('Principal');
        if (c.decision_maker) roles.push('Décideur');
        html += '<tr><td>' + esc(contactName(c)) + '</td><td>' + esc(c.job_title || '—') + '</td>' +
          '<td>' + esc(c.email || '—') + '</td><td>' + esc(c.phone || c.mobile || '—') + '</td>' +
          '<td>' + esc(c.preferred_channel || '—') + '</td><td>' + (roles.length ? roles.join(', ') : '—') + '</td>' +
          '<td>' + (c.active ? pill('Actif', 'sp-ok') : pill('Inactif', 'sp-att')) + '</td>' +
          '<td><button class="btn-sm btn-outline" onclick="CrmAdmin.openEditContactForm(\'' + o.id + '\',\'' + c.id + '\')"><i class="fas fa-edit"></i></button></td></tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<div class="crm-muted">Aucun contact.</div>';
    }

    // Opportunities
    html += '<div class="sec-title"><h3 class="crm-sub-h">Opportunités (' + ctx.opportunities.length + ')</h3></div>';
    if (ctx.opportunities.length) {
      html += '<div class="table-scroll"><table class="data-table"><thead><tr>' +
        '<th>Titre</th><th>Étape</th><th>Valeur</th><th>Prob.</th><th>Prochaine action</th><th>Dernier contact</th><th>Actions</th></tr></thead><tbody>';
      ctx.opportunities.forEach(function (op) {
        html += '<tr><td>' + esc(op.title) + '</td>' +
          '<td>' + pill(STAGE_LABELS[op.stage] || op.stage, STAGE_PILL[op.stage]) + '</td>' +
          '<td class="td-price">' + fmtEur(op.estimated_value) + '</td>' +
          '<td>' + (op.probability != null ? op.probability + '%' : '—') + '</td>' +
          '<td>' + (op.next_action ? esc(op.next_action) + ' <span class="crm-muted">(' + fmtDate(op.next_action_at) + ')</span>' : '—') + '</td>' +
          '<td>' + fmtDate(op.last_contact_at) + '</td>' +
          '<td><button class="btn-sm btn-outline" onclick="CrmAdmin.openEditOpportunityForm(\'' + op.id + '\')"><i class="fas fa-edit"></i></button> ' +
          '<button class="btn-sm btn-outline" onclick="CrmAdmin.openTransitionForm(\'' + op.id + '\',\'' + op.stage + '\')"><i class="fas fa-exchange-alt"></i></button></td></tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<div class="crm-muted">Aucune opportunité.</div>';
    }

    // Activities
    html += '<div class="sec-title"><h3 class="crm-sub-h">Activités (' + ctx.activities.length + ')</h3></div>';
    if (ctx.activities.length) {
      html += '<div class="table-scroll"><table class="data-table"><thead><tr>' +
        '<th>Sujet</th><th>Type</th><th>Statut</th><th>Échéance</th><th>Effectuée le</th><th>Actions</th></tr></thead><tbody>';
      ctx.activities.slice(0, 20).forEach(function (a) {
        html += '<tr><td>' + esc(a.subject) + '</td>' +
          '<td>' + pill(ACTIVITY_TYPE_LABELS[a.activity_type] || a.activity_type, 'sp-cours', ACTIVITY_TYPE_ICON[a.activity_type]) + '</td>' +
          '<td>' + pill(ACTIVITY_STATUS_LABELS[a.status] || a.status, ACTIVITY_STATUS_PILL[a.status]) + '</td>' +
          '<td>' + fmtDate(a.due_at) + '</td><td>' + fmtDate(a.occurred_at) + '</td>' +
          '<td><button class="btn-sm btn-outline" onclick="CrmAdmin.openEditActivityForm(\'' + a.id + '\')"><i class="fas fa-edit"></i></button></td></tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<div class="crm-muted">Aucune activité.</div>';
    }

    // Linked devis
    html += '<div class="sec-title"><h3 class="crm-sub-h">Devis liés (' + ctx.devis.length + ')</h3></div>';
    if (ctx.devis.length) {
      html += '<div class="table-scroll"><table class="data-table"><thead><tr>' +
        '<th>Référence</th><th>Statut</th><th>Montant HT</th><th>Créé le</th></tr></thead><tbody>';
      ctx.devis.forEach(function (d) {
        html += '<tr><td>' + esc(d.reference || '—') + '</td><td>' + esc(d.status || '—') + '</td>' +
          '<td class="td-price">' + fmtEur(d.total_ht) + '</td><td>' + fmtDate(d.created_at) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<div class="crm-muted">Aucun devis lié.</div>';
    }

    // Linked missions
    html += '<div class="sec-title"><h3 class="crm-sub-h">Missions liées (' + ctx.missions.length + ')</h3></div>';
    if (ctx.missions.length) {
      html += '<div class="table-scroll"><table class="data-table"><thead><tr>' +
        '<th>Référence</th><th>Statut</th><th>Créée le</th></tr></thead><tbody>';
      ctx.missions.forEach(function (m) {
        html += '<tr><td>' + esc(m.reference || '—') + '</td><td>' + esc(m.status || '—') + '</td><td>' + fmtDate(m.created_at) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<div class="crm-muted">Aucune mission liée.</div>';
    }

    // Timeline
    html += '<div class="sec-title"><h3 class="crm-sub-h">Timeline CRM</h3></div>';
    html += '<div id="crmOrgTimeline"></div>';
    html += '<div id="crmOrgTimelineMore" style="text-align:center;margin:12px 0;"></div>';

    var body = document.getElementById('crmOrgDetailBody');
    if (body) body.innerHTML = html;
  }

  async function loadCrmOrgTimeline(orgId, reset) {
    var client = sb();
    if (!client) return;
    var container = document.getElementById('crmOrgTimeline');
    if (!container) return;
    if (reset) {
      _orgDetailTimelineCursor = { eventAt: null, eventKey: null, hasMore: false, loading: false };
      setLoading(container.id, 'Chargement de la timeline…');
    }
    _orgDetailTimelineCursor.loading = true;
    try {
      // RM01A-012: ensure internal user map is loaded for actor attribution.
      await ensureInternalUsers();
      var params = buildTimelineParams({ organizationId: orgId }, _orgDetailTimelineCursor, TIMELINE_DEFAULT_LIMIT);
      var res = await client.rpc('crm_timeline_read', params);
      if (res.error) { handleRpcError(res.error, container.id, 'crm_timeline_read (org)'); _orgDetailTimelineCursor.loading = false; return; }
      var rows = res.data || [];
      var hasMore = rows.length >= TIMELINE_DEFAULT_LIMIT;
      if (rows.length) {
        var last = rows[rows.length - 1];
        _orgDetailTimelineCursor.eventAt = last.event_at;
        _orgDetailTimelineCursor.eventKey = last.event_key;
      }
      _orgDetailTimelineCursor.hasMore = hasMore;
      appendTimelineRows(container.id, rows, reset);
      renderMoreButton('crmOrgTimelineMore', hasMore, 'CrmAdmin.nextOrgTimelinePage()', _orgDetailTimelineCursor.loading);
    } catch (e) { handleRpcError(e, container.id, 'crm_timeline_read (org)'); }
    _orgDetailTimelineCursor.loading = false;
  }
  function nextOrgTimelinePage() {
    if (!_currentOrgId || _orgDetailTimelineCursor.loading || !_orgDetailTimelineCursor.hasMore) return;
    loadCrmOrgTimeline(_currentOrgId, false);
  }

  // ---------------------------------------------------------
  // OPPORTUNITIES
  // ---------------------------------------------------------
  async function loadCrmOpportunities() {
    var client = sb();
    if (!client) { setError('crmOppBody', 'Client Supabase indisponible.'); return; }
    setLoading('crmOppBody', 'Chargement des opportunités…');
    try {
      var res = await client.from('crm_opportunities')
        .select('id,title,stage,estimated_value,probability,source,source_detail,next_action,next_action_at,last_contact_at,organization_id,contact_id,created_at,lost_reason')
        .order('created_at', { ascending: false });
      if (res.error) { handleRpcError(res.error, 'crmOppBody', 'crm_opportunities select'); return; }
      _oppData = res.data || [];
      _oppMap = {};
      _oppData.forEach(function (op) { _oppMap[op.id] = op; });
      // Ensure org map is populated for name lookups.
      if (!_orgMap || Object.keys(_orgMap).length === 0) {
        try {
          var sum = await client.rpc('crm_organizations_summary');
          if (!sum.error && sum.data) {
            _orgSummary = sum.data;
            _orgMap = {};
            sum.data.forEach(function (r) { _orgMap[r.organization_id] = r; });
            populateOrgSelects();
          }
        } catch (_) {}
      }
      // Resolve contact names for the opportunities list. Only populate
      // _contactMap if it is empty (the org detail loader populates it
      // with full contact objects needed for editing).
      if (_oppData.length && Object.keys(_contactMap).length === 0) {
        try {
          var ct = await client.from('organization_contacts')
            .select('id,first_name,last_name').limit(1000);
          if (!ct.error && ct.data) {
            ct.data.forEach(function (c) { _contactMap[c.id] = c; });
          }
        } catch (_) {}
      }
      renderCrmOpportunities();
    } catch (e) { handleRpcError(e, 'crmOppBody', 'loadCrmOpportunities'); }
  }

  function renderCrmOpportunities() {
    var rows = _oppData.slice();
    if (_oppFilters.stage !== 'all') {
      rows = rows.filter(function (r) { return r.stage === _oppFilters.stage; });
    }
    var q = (_oppFilters.q || '').trim().toLowerCase();
    if (q) {
      rows = rows.filter(function (r) {
        return ((r.title || '').toLowerCase().indexOf(q) !== -1) ||
               (orgName(r.organization_id).toLowerCase().indexOf(q) !== -1);
      });
    }

    var countEl = document.getElementById('crmOppCount');
    if (countEl) countEl.innerHTML = rows.length + ' opportunité' + (rows.length > 1 ? 's' : '');

    var body = document.getElementById('crmOppBody');
    if (!body) return;
    var html = '<button class="btn-red btn-sm" style="margin-bottom:12px;" onclick="CrmAdmin.openCreateOpportunityForm()"><i class="fas fa-plus"></i> Nouvelle opportunité</button>';
    if (!rows.length) {
      html += '<div class="crm-state crm-empty"><i class="fas fa-inbox"></i> Aucune opportunité.</div>';
      body.innerHTML = html;
      return;
    }

    // Table view with action buttons.
    html += '<div class="table-scroll"><table class="data-table"><thead><tr>' +
      '<th>Titre</th><th>Organisation</th><th>Contact</th><th>Étape</th><th>Valeur</th>' +
      '<th>Prob.</th><th>Prochaine action</th><th>Date</th><th>Dernier contact</th><th>Source</th><th>Actions</th></tr></thead><tbody>';
    rows.forEach(function (op) {
      var c = _contactMap[op.contact_id];
      // Rows without organization_id are not navigable (RM01A-006).
      var rowAttr = op.organization_id
        ? ' style="cursor:pointer;" onclick="CrmAdmin.openOrgDetail(\'' + op.organization_id + '\')"'
        : '';
      html += '<tr' + rowAttr + '>' +
        '<td>' + esc(op.title) + (op.stage === 'lost' && op.lost_reason ? ' <span class="crm-muted">(' + esc(op.lost_reason) + ')</span>' : '') + '</td>' +
        '<td>' + orgName(op.organization_id) + '</td>' +
        '<td>' + esc(c ? contactName(c) : '—') + '</td>' +
        '<td>' + pill(STAGE_LABELS[op.stage] || op.stage, STAGE_PILL[op.stage]) + '</td>' +
        '<td class="td-price">' + fmtEur(op.estimated_value) + '</td>' +
        '<td>' + (op.probability != null ? op.probability + '%' : '—') + '</td>' +
        '<td>' + esc(op.next_action || '—') + '</td>' +
        '<td>' + fmtDate(op.next_action_at) + '</td>' +
        '<td>' + fmtDate(op.last_contact_at) + '</td>' +
        '<td>' + esc(op.source || '—') + '</td>' +
        '<td onclick="event.stopPropagation();"><button class="btn-sm btn-outline" onclick="CrmAdmin.openEditOpportunityForm(\'' + op.id + '\')"><i class="fas fa-edit"></i></button> ' +
        '<button class="btn-sm btn-outline" onclick="CrmAdmin.openTransitionForm(\'' + op.id + '\',\'' + op.stage + '\')"><i class="fas fa-exchange-alt"></i></button></td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    body.innerHTML = html;
  }
  function setOppFilter(key, val) { _oppFilters[key] = val; renderCrmOpportunities(); }

  // ---------------------------------------------------------
  // ACTIVITIES
  // ---------------------------------------------------------
  async function loadCrmActivities() {
    var client = sb();
    if (!client) { setError('crmActBody', 'Client Supabase indisponible.'); return; }
    setLoading('crmActBody', 'Chargement des activités…');
    try {
      var res = await client.from('crm_activities')
        .select('id,activity_type,subject,status,organization_id,opportunity_id,occurred_at,due_at,completed_at,assigned_to,created_by,created_at')
        .order('created_at', { ascending: false }).limit(200);
      if (res.error) { handleRpcError(res.error, 'crmActBody', 'crm_activities select'); return; }
      _actData = res.data || [];
      _actMap = {};
      _actData.forEach(function (a) { _actMap[a.id] = a; });
      if (!_orgMap || Object.keys(_orgMap).length === 0) {
        try {
          var sum = await client.rpc('crm_organizations_summary');
          if (!sum.error && sum.data) {
            _orgSummary = sum.data; _orgMap = {};
            sum.data.forEach(function (r) { _orgMap[r.organization_id] = r; });
            populateOrgSelects();
          }
        } catch (_) {}
      }
      renderCrmActivities();
    } catch (e) { handleRpcError(e, 'crmActBody', 'loadCrmActivities'); }
  }

  function renderCrmActivities() {
    var rows = _actData.slice();
    if (_actFilters.type !== 'all') rows = rows.filter(function (r) { return r.activity_type === _actFilters.type; });
    if (_actFilters.status !== 'all') rows = rows.filter(function (r) { return r.status === _actFilters.status; });
    if (_actFilters.org !== 'all') rows = rows.filter(function (r) { return r.organization_id === _actFilters.org; });
    var q = (_actFilters.q || '').trim().toLowerCase();
    if (q) rows = rows.filter(function (r) { return (r.subject || '').toLowerCase().indexOf(q) !== -1; });

    var countEl = document.getElementById('crmActCount');
    if (countEl) countEl.innerHTML = rows.length + ' activité' + (rows.length > 1 ? 's' : '');

    var body = document.getElementById('crmActBody');
    if (!body) return;
    var html = '<button class="btn-red btn-sm" style="margin-bottom:12px;" onclick="CrmAdmin.openCreateActivityForm()"><i class="fas fa-plus"></i> Nouvelle activité</button>';
    if (!rows.length) {
      html += '<div class="crm-state crm-empty"><i class="fas fa-inbox"></i> Aucune activité.</div>';
      body.innerHTML = html;
      return;
    }
    html += '<div class="table-scroll"><table class="data-table"><thead><tr>' +
      '<th>Sujet</th><th>Type</th><th>Statut</th><th>Organisation</th><th>Opportunité</th>' +
      '<th>Assigné à</th><th>Effectuée le</th><th>Échéance</th><th>Terminée le</th><th>Actions</th></tr></thead><tbody>';
    rows.forEach(function (a) {
      // auth.users is not readable via RLS, so the assigned user name cannot
      // be resolved. We show a neutral placeholder rather than a raw UUID.
      var assigned = a.assigned_to ? 'Utilisateur interne' : '—';
      // Rows without organization_id are not navigable (RM01A-006).
      var rowAttr = a.organization_id
        ? ' style="cursor:pointer;" onclick="CrmAdmin.openOrgDetail(\'' + a.organization_id + '\')"'
        : '';
      html += '<tr' + rowAttr + '>' +
        '<td>' + esc(a.subject) + '</td>' +
        '<td>' + pill(ACTIVITY_TYPE_LABELS[a.activity_type] || a.activity_type, 'sp-cours', ACTIVITY_TYPE_ICON[a.activity_type]) + '</td>' +
        '<td>' + pill(ACTIVITY_STATUS_LABELS[a.status] || a.status, ACTIVITY_STATUS_PILL[a.status]) + '</td>' +
        '<td>' + orgName(a.organization_id) + '</td>' +
        '<td>' + (a.opportunity_id ? '<i class="fas fa-link crm-muted"></i>' : '—') + '</td>' +
        '<td>' + esc(assigned) + '</td>' +
        '<td>' + fmtDate(a.occurred_at) + '</td>' +
        '<td>' + fmtDate(a.due_at) + '</td>' +
        '<td>' + fmtDate(a.completed_at) + '</td>' +
        '<td onclick="event.stopPropagation();"><button class="btn-sm btn-outline" onclick="CrmAdmin.openEditActivityForm(\'' + a.id + '\')"><i class="fas fa-edit"></i></button></td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    body.innerHTML = html;
  }
  function setActFilter(key, val) { _actFilters[key] = val; renderCrmActivities(); }

  // ---------------------------------------------------------
  // GLOBAL CRM TIMELINE
  // ---------------------------------------------------------
  function readTimelineFilters() {
    var f = { organizationId: null, missionId: null, opportunityId: null, clientId: null };
    var orgSel = document.getElementById('crmTlOrgFilter');
    if (orgSel && orgSel.value) f.organizationId = orgSel.value;
    var m = document.getElementById('crmTlMissionInput');
    if (m && m.value.trim()) f.missionId = m.value.trim();
    var o = document.getElementById('crmTlOppInput');
    if (o && o.value.trim()) f.opportunityId = o.value.trim();
    var c = document.getElementById('crmTlClientInput');
    if (c && c.value.trim()) f.clientId = c.value.trim();
    _tlFilters = f;
    return f;
  }

  async function loadCrmTimeline(reset) {
    var client = sb();
    if (!client) { setError('crmTimelineBody', 'Client Supabase indisponible.'); return; }
    var container = document.getElementById('crmTimelineBody');
    if (!container) return;
    var filters = readTimelineFilters();
    if (reset) {
      _tlCursor = { eventAt: null, eventKey: null, hasMore: false, loading: false };
      setLoading(container.id, 'Chargement de la timeline…');
    }
    _tlCursor.loading = true;
    try {
      // RM01A-012: ensure internal user map is loaded for actor attribution.
      await ensureInternalUsers();
      var params = buildTimelineParams(filters, _tlCursor, TIMELINE_DEFAULT_LIMIT);
      var res = await client.rpc('crm_timeline_read', params);
      if (res.error) { handleRpcError(res.error, container.id, 'crm_timeline_read'); _tlCursor.loading = false; return; }
      var rows = res.data || [];
      var hasMore = rows.length >= TIMELINE_DEFAULT_LIMIT;
      if (rows.length) {
        var last = rows[rows.length - 1];
        _tlCursor.eventAt = last.event_at;
        _tlCursor.eventKey = last.event_key;
      }
      _tlCursor.hasMore = hasMore;
      appendTimelineRows(container.id, rows, reset);
      renderMoreButton('crmTimelineMore', hasMore, 'CrmAdmin.nextTimelinePage()', _tlCursor.loading);
    } catch (e) { handleRpcError(e, container.id, 'crm_timeline_read'); }
    _tlCursor.loading = false;
  }
  function nextTimelinePage() {
    if (_tlCursor.loading || !_tlCursor.hasMore) return;
    loadCrmTimeline(false);
  }

  function appendTimelineRows(containerId, rows, reset) {
    var el = document.getElementById(containerId);
    if (!el) return;
    if (reset && !rows.length) {
      el.innerHTML = '<div class="crm-state crm-empty"><i class="fas fa-inbox"></i> Aucun événement dans la timeline.</div>';
      return;
    }
    var html = reset ? '' : el.innerHTML;
    html += rows.map(renderTimelineRow).join('');
    el.innerHTML = html;
  }

  // ---------------------------------------------------------
  // RM01A-012: Timeline actor attribution
  // ---------------------------------------------------------
  // Resolves actor_user_id to a human-readable label using the cached
  // internal user map (built once from crm_list_internal_users, no N+1).
  // Display priority:
  //   1. user display name (from _internalUserMap)
  //   2. role-based label (Administrateur/Opérateur) when actor_role is set
  //   3. "Système" for system-generated state projections (no actor)
  //   4. "Acteur inconnu" as last-resort diagnostic fallback
  // Actor UUIDs are never shown in the normal UI when a readable identity exists.
  function actorLabel(r) {
    // 1. Resolve actor_user_id to display name via cached internal users.
    if (r.actor_user_id && _internalUserMap[r.actor_user_id]) {
      return _internalUserMap[r.actor_user_id].display_name || 'Utilisateur interne';
    }
    // 2. actor exists but cannot be resolved — don't falsely label as system.
    if (r.actor_user_id) {
      if (r.actor_role === 'admin') return 'Administrateur';
      if (r.actor_role === 'operator') return 'Opérateur';
      return 'Utilisateur interne';
    }
    // 3. No actor_user_id. If role is set, use role-based label.
    if (r.actor_role === 'admin') return 'Administrateur';
    if (r.actor_role === 'operator') return 'Opérateur';
    // 4. No actor at all — system-generated state projection (devis/mission/activity).
    if (r.record_kind === 'state_projection') return 'Système';
    // 5. Last-resort fallback.
    return 'Acteur inconnu';
  }

  function renderTimelineRow(r) {
    var kindCls = r.record_kind === 'immutable_event' ? 'crm-tl-immutable' : 'crm-tl-projection';
    var kindLbl = RECORD_KIND_LABELS[r.record_kind] || r.record_kind;
    var srcLbl = SOURCE_LABELS[r.event_source] || r.event_source;
    var srcIc = SOURCE_ICON[r.event_source] || 'fa-circle';
    var desc = r.description ? esc(r.description) : '';
    // Present user-relevant metadata only. Avoid dumping raw technical fields.
    var metaBits = [];
    if (r.metadata && typeof r.metadata === 'object') {
      var m = r.metadata;
      if (m.from_stage && m.to_stage) metaBits.push(esc(STAGE_LABELS[m.from_stage] || m.from_stage) + ' → ' + esc(STAGE_LABELS[m.to_stage] || m.to_stage));
      else if (m.to_stage) metaBits.push('Étape : ' + esc(STAGE_LABELS[m.to_stage] || m.to_stage));
      if (m.status) metaBits.push('Statut : ' + esc(m.status));
      if (m.reference) metaBits.push('Réf : ' + esc(m.reference));
      if (m.reason) metaBits.push('Raison : ' + esc(m.reason));
      if (m.due_at) metaBits.push('Échéance : ' + fmtDate(m.due_at));
    }
    var metaHtml = metaBits.length ? '<div class="crm-tl-meta">' + metaBits.join(' · ') + '</div>' : '';
    // RM01A-012: human-readable actor label instead of raw role/UUID.
    var actor = '<span class="crm-tl-actor">' + esc(actorLabel(r)) + '</span>';
    return '<div class="crm-tl-row ' + kindCls + '">' +
      '<div class="crm-tl-ico"><i class="fas ' + srcIc + '"></i></div>' +
      '<div class="crm-tl-body">' +
      '<div class="crm-tl-h"><span class="crm-tl-src">' + esc(srcLbl) + '</span>' +
      '<span class="crm-tl-kind ' + kindCls + '">' + esc(kindLbl) + '</span>' + actor + '</div>' +
      '<div class="crm-tl-title">' + esc(r.title || '—') + '</div>' +
      (desc ? '<div class="crm-tl-desc">' + desc + '</div>' : '') + metaHtml +
      '<div class="crm-tl-date">' + fmtDateTime(r.event_at) + '</div>' +
      '</div></div>';
  }

  function renderMoreButton(containerId, hasMore, onclick, loading) {
    var el = document.getElementById(containerId);
    if (!el) return;
    if (!hasMore) { el.innerHTML = ''; return; }
    el.innerHTML = '<button class="btn-outline" onclick="' + onclick + '" ' + (loading ? 'disabled' : '') + '>' +
      (loading ? '<i class="fas fa-spinner fa-spin"></i> Chargement…' : '<i class="fas fa-arrow-down"></i> Charger plus') + '</button>';
  }

  // ---------------------------------------------------------
  // Shared: populate organization <select> filters
  // ---------------------------------------------------------
  function populateOrgSelects() {
    var opts = '<option value="all">Toutes les organisations</option>' +
      _orgSummary.map(function (r) {
        var nm = esc(r.trade_name || r.legal_name || '—');
        return '<option value="' + r.organization_id + '">' + nm + '</option>';
      }).join('');
    ['crmActOrgFilter', 'crmTlOrgFilter'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = opts;
    });
  }

  // =========================================================
  // P3C2 — CRM MUTATION LAYER
  // =========================================================
  // Centralized write operations. All frontend CRM writes pass
  // through these functions. No scattered .insert()/.update()
  // calls in rendering code.
  //
  // Paths:
  //   DIRECT_RLS_CRUD: organizations, organization_segments,
  //     organization_sites, organization_contacts,
  //     crm_opportunities (business fields only),
  //     crm_activities (business fields only)
  //   EXISTING_RPC: crm_transition_opportunity,
  //     crm_link_client_organization, crm_link_devis_crm,
  //     crm_link_mission_devis
  //   NEW_RPC: crm_set_primary_contact, crm_list_internal_users
  // =========================================================

  // ---------------------------------------------------------
  // Mutation state
  // ---------------------------------------------------------
  var _mutating = false; // prevents duplicate submit
  var _internalUsers = []; // crm_list_internal_users() cache
  var _internalUsersLoaded = false;
  var _internalUserMap = {}; // user_id -> { display_name, role } for actor attribution (RM01A-012)

  // ---------------------------------------------------------
  // Transition map — mirrors the DB RPC validation exactly.
  // The UI uses this to show valid candidate transitions. The
  // RPC is the real validator; this is UX guidance only.
  // ---------------------------------------------------------
  var TRANSITION_MAP = {
    lead:           ['qualified', 'contacted', 'lost', 'dormant'],
    qualified:      ['contacted', 'meeting', 'quote_requested', 'lost', 'dormant'],
    contacted:      ['meeting', 'quote_requested', 'lost', 'dormant'],
    meeting:        ['quote_requested', 'quote_sent', 'lost', 'dormant'],
    quote_requested: ['quote_sent', 'lost', 'dormant'],
    quote_sent:     ['negotiating', 'won', 'lost', 'dormant'],
    negotiating:    ['won', 'lost', 'dormant'],
    dormant:        ['contacted', 'qualified', 'lost'],
    won:            [],
    lost:           []
  };

  // ---------------------------------------------------------
  // Modal management — generic CRM modal for all forms
  // ---------------------------------------------------------
  function openCrmModal(title, bodyHtml, footerHtml) {
    var overlay = document.getElementById('crmModalOverlay');
    if (!overlay) return;
    var titleEl = document.getElementById('crmModalTitle');
    var bodyEl = document.getElementById('crmModalBody');
    var footerEl = document.getElementById('crmModalFooter');
    if (titleEl) titleEl.innerHTML = esc(title);
    if (bodyEl) bodyEl.innerHTML = bodyHtml;
    if (footerEl) footerEl.innerHTML = footerHtml || '';
    overlay.classList.add('open');
  }
  function closeCrmModal() {
    var overlay = document.getElementById('crmModalOverlay');
    if (overlay) overlay.classList.remove('open');
  }
  function setModalError(msg) {
    var el = document.getElementById('crmModalError');
    if (el) el.innerHTML = '<div class="crm-state crm-error"><i class="fas fa-exclamation-triangle"></i> ' + esc(msg) + '</div>';
  }
  function clearModalError() {
    var el = document.getElementById('crmModalError');
    if (el) el.innerHTML = '';
  }
  function setModalBusy(busy) {
    _mutating = busy;
    var btn = document.getElementById('crmModalSubmit');
    if (!btn) return;
    if (busy) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enregistrement…';
    } else {
      btn.disabled = false;
      btn.innerHTML = 'Enregistrer';
    }
  }

  // ---------------------------------------------------------
  // Internal user loading (for assigned_to picker)
  // ---------------------------------------------------------
  async function ensureInternalUsers() {
    if (_internalUsersLoaded) return _internalUsers;
    var client = sb();
    if (!client) return [];
    try {
      var res = await client.rpc('crm_list_internal_users');
      if (res.error) { console.error('[CRM] crm_list_internal_users:', res.error); return []; }
      _internalUsers = res.data || [];
      _internalUsersLoaded = true;
      // Build actor-resolution map (RM01A-012): user_id -> display info.
      _internalUserMap = {};
      _internalUsers.forEach(function (u) {
        _internalUserMap[u.user_id] = { display_name: u.display_name, role: u.role };
      });
    } catch (e) { console.error('[CRM] crm_list_internal_users:', e); }
    return _internalUsers;
  }

  function internalUserOptions(selectedId) {
    return _internalUsers.map(function (u) {
      var sel = (selectedId && u.user_id === selectedId) ? ' selected' : '';
      return '<option value="' + esc(u.user_id) + '"' + sel + '>' +
        esc(u.display_name) + ' (' + esc(u.role) + ')</option>';
    }).join('');
  }

  // =========================================================
  // P3C2-A: ORGANIZATION MUTATIONS
  // =========================================================

  // Organization form fields (schema-aligned, no invented fields)
  function orgFormFields(o) {
    o = o || {};
    var statusOpts = ['active', 'inactive', 'archived'].map(function (s) {
      return '<option value="' + s + '"' + (o.status === s ? ' selected' : '') + '>' +
        esc(ORG_STATUS_LABELS[s] || s) + '</option>';
    }).join('');
    return [
      field('org_legal_name', 'Raison sociale *', 'text', o.legal_name, '', true),
      field('org_trade_name', 'Nom commercial', 'text', o.trade_name),
      field('org_siret', 'SIRET (14 chiffres)', 'text', o.siret),
      field('org_siren', 'SIREN (9 chiffres)', 'text', o.siren),
      field('org_vat_number', 'N° TVA', 'text', o.vat_number),
      field('org_email', 'Email', 'email', o.email),
      field('org_phone', 'Téléphone', 'tel', o.phone),
      field('org_website', 'Site web', 'url', o.website),
      field('org_source', 'Source', 'text', o.source),
      field('org_source_detail', 'Détail source', 'text', o.source_detail),
      field('org_external_reference', 'Référence externe', 'text', o.external_reference),
      '<div class="f-grp"><label>Statut</label><select id="org_status" class="crm-select">' + statusOpts + '</select></div>',
      '<div class="f-grp"><label>Notes</label><textarea id="org_notes" rows="3">' + esc(o.notes || '') + '</textarea></div>'
    ].join('');
  }

  function openCreateOrgForm() {
    var body = '<div class="f-row">' + orgFormFields({}) + '</div><div id="crmModalError"></div>';
    var footer = '<button class="btn-outline" onclick="CrmAdmin.closeModal()">Annuler</button>' +
      '<button class="btn-red" id="crmModalSubmit" onclick="CrmAdmin.submitCreateOrg()">Créer</button>';
    openCrmModal('Nouvelle organisation', body, footer);
  }

  function openEditOrgForm(orgId) {
    var client = sb();
    if (!client) return;
    client.from('organizations').select('*').eq('id', orgId).maybeSingle()
      .then(function (res) {
        if (res.error || !res.data) { setModalError('Organisation introuvable.'); return; }
        var o = res.data;
        var body = '<div class="f-row">' + orgFormFields(o) + '</div><div id="crmModalError"></div>';
        var footer = '<button class="btn-outline" onclick="CrmAdmin.closeModal()">Annuler</button>' +
          '<button class="btn-red" id="crmModalSubmit" onclick="CrmAdmin.submitEditOrg(\'' + orgId + '\')">Enregistrer</button>';
        openCrmModal('Modifier l\'organisation', body, footer);
      });
  }

  // DIRECT_RLS_CRUD: organizations INSERT
  async function submitCreateOrg() {
    if (_mutating) return;
    clearModalError();
    var payload = collectOrgForm();
    if (!payload) return;
    setModalBusy(true);
    try {
      var client = sb();
      var res = await client.from('organizations').insert(payload).select().single();
      setModalBusy(false);
      if (res.error) { setModalError(crmUserError(res.error, 'Erreur lors de la création.')); return; }
      closeCrmModal();
      await refreshOrgSummary();
      openCrmOrgDetail(res.data.id);
    } catch (e) { setModalBusy(false); setModalError(crmUserError(e, 'Erreur inattendue.')); }
  }

  // DIRECT_RLS_CRUD: organizations UPDATE (no stage/lost_reason/created_by)
  async function submitEditOrg(orgId) {
    if (_mutating) return;
    clearModalError();
    var payload = collectOrgForm();
    if (!payload) return;
    setModalBusy(true);
    try {
      var client = sb();
      var res = await client.from('organizations').update(payload).eq('id', orgId).select().single();
      setModalBusy(false);
      if (res.error) { setModalError(crmUserError(res.error, 'Erreur lors de la modification.')); return; }
      closeCrmModal();
      await refreshOrgSummary();
      loadCrmOrgDetail(orgId);
    } catch (e) { setModalBusy(false); setModalError(crmUserError(e, 'Erreur inattendue.')); }
  }

  // DIRECT_RLS_CRUD: organizations UPDATE status='archived'
  async function archiveOrg(orgId) {
    if (_mutating) return;
    if (!confirm('Archiver cette organisation ? Elle ne sera plus visible dans les listes actives.')) return;
    setModalBusy(true);
    try {
      var client = sb();
      var res = await client.from('organizations').update({ status: 'archived' }).eq('id', orgId);
      setModalBusy(false);
      if (res.error) { alert(crmUserError(res.error, 'Erreur lors de l\'archivage.')); return; }
      await refreshOrgSummary();
      closeCrmOrgDetail();
      renderCrmOrganizations();
    } catch (e) { setModalBusy(false); alert(crmUserError(e, 'Erreur inattendue.')); }
  }

  function collectOrgForm() {
    var legalName = (document.getElementById('org_legal_name') || {}).value;
    if (!legalName || !legalName.trim()) { setModalError('La raison sociale est obligatoire.'); return null; }
    var siret = (document.getElementById('org_siret') || {}).value;
    if (siret && !/^\d{14}$/.test(siret)) { setModalError('SIRET : 14 chiffres requis.'); return null; }
    var siren = (document.getElementById('org_siren') || {}).value;
    if (siren && !/^\d{9}$/.test(siren)) { setModalError('SIREN : 9 chiffres requis.'); return null; }
    return {
      legal_name: legalName.trim(),
      trade_name: val('org_trade_name'),
      siret: siret || null,
      siren: siren || null,
      vat_number: val('org_vat_number'),
      email: val('org_email'),
      phone: val('org_phone'),
      website: val('org_website'),
      source: val('org_source'),
      source_detail: val('org_source_detail'),
      external_reference: val('org_external_reference'),
      status: val('org_status') || 'active',
      notes: val('org_notes')
    };
  }

  // =========================================================
  // P3C2-A: SEGMENT MUTATIONS
  // =========================================================

  // DIRECT_RLS_CRUD: organization_segments INSERT
  async function addSegment(orgId, segment) {
    var client = sb();
    if (!client) return;
    try {
      var res = await client.from('organization_segments')
        .insert({ organization_id: orgId, segment: segment });
      if (res.error) { alert(crmUserError(res.error, 'Une erreur est survenue.')); return; }
      loadCrmOrgDetail(orgId);
    } catch (e) { alert(crmUserError(e, 'Une erreur est survenue.')); }
  }

  // DIRECT_RLS_CRUD: organization_segments DELETE
  async function removeSegment(orgId, segment) {
    var client = sb();
    if (!client) return;
    try {
      var res = await client.from('organization_segments')
        .delete().eq('organization_id', orgId).eq('segment', segment);
      if (res.error) { alert(crmUserError(res.error, 'Une erreur est survenue.')); return; }
      loadCrmOrgDetail(orgId);
    } catch (e) { alert(crmUserError(e, 'Une erreur est survenue.')); }
  }

  function openSegmentManager(orgId) {
    var currentSegments = _orgSegments || [];
    var allSegs = SEGMENTS.map(function (s) {
      var has = currentSegments.indexOf(s) !== -1;
      return '<label class="crm-seg-toggle"><input type="checkbox" value="' + s + '"' +
        (has ? ' checked' : '') + '> ' + esc(SEGMENT_LABELS[s] || s) + '</label>';
    }).join('');
    var body = '<div class="crm-seg-list">' + allSegs + '</div><div id="crmModalError"></div>';
    var footer = '<button class="btn-outline" onclick="CrmAdmin.closeModal()">Annuler</button>' +
      '<button class="btn-red" id="crmModalSubmit" onclick="CrmAdmin.submitSegments(\'' + orgId + '\')">Enregistrer</button>';
    openCrmModal('Gérer les segments', body, footer);
  }

  async function submitSegments(orgId) {
    if (_mutating) return;
    clearModalError();
    setModalBusy(true);
    try {
      var client = sb();
      var checkboxes = document.querySelectorAll('.crm-seg-toggle input[type=checkbox]');
      var desired = [];
      checkboxes.forEach(function (cb) { if (cb.checked) desired.push(cb.value); });
      // Fetch current
      var curRes = await client.from('organization_segments').select('segment').eq('organization_id', orgId);
      if (curRes.error) { setModalBusy(false); setModalError(crmUserError(curRes.error, 'Une erreur est survenue. Veuillez réessayer.')); return; }
      var current = (curRes.data || []).map(function (r) { return r.segment; });
      var toAdd = desired.filter(function (s) { return current.indexOf(s) === -1; });
      var toRemove = current.filter(function (s) { return desired.indexOf(s) === -1; });
      // Add new
      for (var i = 0; i < toAdd.length; i++) {
        var addRes = await client.from('organization_segments')
          .insert({ organization_id: orgId, segment: toAdd[i] });
        if (addRes.error) { setModalBusy(false); setModalError(crmUserError(addRes.error, 'Une erreur est survenue. Veuillez réessayer.')); return; }
      }
      // Remove old
      for (var j = 0; j < toRemove.length; j++) {
        var delRes = await client.from('organization_segments')
          .delete().eq('organization_id', orgId).eq('segment', toRemove[j]);
        if (delRes.error) { setModalBusy(false); setModalError(crmUserError(delRes.error, 'Une erreur est survenue. Veuillez réessayer.')); return; }
      }
      setModalBusy(false);
      closeCrmModal();
      loadCrmOrgDetail(orgId);
    } catch (e) { setModalBusy(false); setModalError(crmUserError(e, 'Une erreur inattendue est survenue.')); }
  }

  // =========================================================
  // P3C2-B: SITE MUTATIONS
  // =========================================================

  function siteFormFields(s) {
    s = s || {};
    var typeOpts = ['headquarters', 'showroom', 'workshop', 'depot', 'warehouse',
      'office', 'pickup', 'delivery', 'auction_site', 'other'].map(function (t) {
      return '<option value="' + t + '"' + (s.site_type === t ? ' selected' : '') + '>' + esc(t) + '</option>';
    }).join('');
    return [
      field('site_name', 'Nom *', 'text', s.name, '', true),
      '<div class="f-grp"><label>Type</label><select id="site_site_type" class="crm-select">' + typeOpts + '</select></div>',
      field('site_address1', 'Adresse ligne 1', 'text', s.address_line1),
      field('site_address2', 'Adresse ligne 2', 'text', s.address_line2),
      field('site_postal_code', 'Code postal', 'text', s.postal_code),
      field('site_city', 'Ville', 'text', s.city),
      field('site_country', 'Pays (code ISO)', 'text', s.country || 'FR'),
      field('site_phone', 'Téléphone', 'tel', s.phone),
      field('site_email', 'Email', 'email', s.email),
      '<div class="f-grp"><label class="crm-chk-lbl"><input type="checkbox" id="site_active"' +
        (s.active !== false ? ' checked' : '') + '> Site actif</label></div>'
    ].join('');
  }

  function openCreateSiteForm(orgId) {
    var body = '<div class="f-row">' + siteFormFields({}) + '</div><div id="crmModalError"></div>';
    var footer = '<button class="btn-outline" onclick="CrmAdmin.closeModal()">Annuler</button>' +
      '<button class="btn-red" id="crmModalSubmit" onclick="CrmAdmin.submitCreateSite(\'' + orgId + '\')">Créer</button>';
    openCrmModal('Nouveau site', body, footer);
  }

  function openEditSiteForm(orgId, siteId) {
    var site = _siteMap[siteId];
    if (!site) {
      Swal.fire('Erreur', 'Site introuvable dans le cache local. Rechargez le détail.', 'error');
      return;
    }
    if (String(site.organization_id || '') !== String(orgId || '')) {
      Swal.fire('Erreur', 'Ce site n\'appartient pas à cette organisation.', 'error');
      return;
    }
    var body = '<div class="f-row">' + siteFormFields(site) + '</div><div id="crmModalError"></div>';
    var footer = '<button class="btn-outline" onclick="CrmAdmin.closeModal()">Annuler</button>' +
      '<button class="btn-red" id="crmModalSubmit" onclick="CrmAdmin.submitEditSite(\'' + orgId + '\',\'' + siteId + '\')">Enregistrer</button>';
    openCrmModal('Modifier le site', body, footer);
  }

  // DIRECT_RLS_CRUD: organization_sites INSERT
  async function submitCreateSite(orgId) {
    if (_mutating) return;
    clearModalError();
    var payload = collectSiteForm(orgId);
    if (!payload) return;
    setModalBusy(true);
    try {
      var client = sb();
      var res = await client.from('organization_sites').insert(payload);
      setModalBusy(false);
      if (res.error) { setModalError(crmUserError(res.error, 'Une erreur est survenue. Veuillez réessayer.')); return; }
      closeCrmModal();
      loadCrmOrgDetail(orgId);
    } catch (e) { setModalBusy(false); setModalError(crmUserError(e, 'Une erreur inattendue est survenue.')); }
  }

  // DIRECT_RLS_CRUD: organization_sites UPDATE
  async function submitEditSite(orgId, siteId) {
    if (_mutating) return;
    clearModalError();
    var payload = collectSiteForm(orgId);
    if (!payload) return;
    setModalBusy(true);
    try {
      var client = sb();
      var res = await client.from('organization_sites').update(payload).eq('id', siteId);
      setModalBusy(false);
      if (res.error) { setModalError(crmUserError(res.error, 'Une erreur est survenue. Veuillez réessayer.')); return; }
      closeCrmModal();
      loadCrmOrgDetail(orgId);
    } catch (e) { setModalBusy(false); setModalError(crmUserError(e, 'Une erreur inattendue est survenue.')); }
  }

  function collectSiteForm(orgId) {
    var name = val('site_name');
    if (!name || !name.trim()) { setModalError('Le nom du site est obligatoire.'); return null; }
    return {
      organization_id: orgId,
      name: name.trim(),
      site_type: val('site_site_type') || 'other',
      address_line1: val('site_address1') || null,
      address_line2: val('site_address2') || null,
      postal_code: val('site_postal_code') || null,
      city: val('site_city') || null,
      country: val('site_country') || 'FR',
      phone: val('site_phone') || null,
      email: val('site_email') || null,
      active: document.getElementById('site_active').checked
    };
  }

  // =========================================================
  // P3C2-B: CONTACT MUTATIONS
  // =========================================================

  function contactFormFields(c) {
    c = c || {};
    var channelOpts = ['email', 'phone', 'mobile', 'sms', 'whatsapp', 'none'].map(function (ch) {
      return '<option value="' + ch + '"' + (c.preferred_channel === ch ? ' selected' : '') + '>' + esc(ch) + '</option>';
    }).join('');
    return [
      field('contact_first_name', 'Prénom', 'text', c.first_name),
      field('contact_last_name', 'Nom', 'text', c.last_name),
      field('contact_job_title', 'Fonction', 'text', c.job_title),
      field('contact_department', 'Département', 'text', c.department),
      field('contact_email', 'Email', 'email', c.email),
      field('contact_phone', 'Téléphone', 'tel', c.phone),
      field('contact_mobile', 'Mobile', 'tel', c.mobile),
      '<div class="f-grp"><label>Canal préféré</label><select id="contact_preferred_channel" class="crm-select"><option value="">—</option>' + channelOpts + '</select></div>',
      '<div class="f-grp"><label class="crm-chk-lbl"><input type="checkbox" id="contact_decision_maker"' + (c.decision_maker ? ' checked' : '') + '> Décideur</label></div>',
      '<div class="f-grp"><label class="crm-chk-lbl"><input type="checkbox" id="contact_primary"' + (c.primary_contact ? ' checked' : '') + '> Contact principal</label></div>',
      '<div class="f-grp"><label class="crm-chk-lbl"><input type="checkbox" id="contact_active"' + (c.active !== false ? ' checked' : '') + '> Actif</label></div>',
      '<div class="f-grp"><label>Notes</label><textarea id="contact_notes" rows="3">' + esc(c.notes || '') + '</textarea></div>'
    ].join('');
  }

  function openCreateContactForm(orgId) {
    var body = '<div class="f-row">' + contactFormFields({}) + '</div><div id="crmModalError"></div>';
    var footer = '<button class="btn-outline" onclick="CrmAdmin.closeModal()">Annuler</button>' +
      '<button class="btn-red" id="crmModalSubmit" onclick="CrmAdmin.submitCreateContact(\'' + orgId + '\')">Créer</button>';
    openCrmModal('Nouveau contact', body, footer);
  }

  function openEditContactForm(orgId, contactId) {
    var contact = _contactMap[contactId];
    if (!contact) {
      Swal.fire('Erreur', 'Contact introuvable dans le cache local. Rechargez le détail.', 'error');
      return;
    }
    if (String(contact.organization_id || '') !== String(orgId || '')) {
      Swal.fire('Erreur', 'Ce contact n\'appartient pas à cette organisation.', 'error');
      return;
    }
    var body = '<div class="f-row">' + contactFormFields(contact) + '</div><div id="crmModalError"></div>';
    var footer = '<button class="btn-outline" onclick="CrmAdmin.closeModal()">Annuler</button>' +
      '<button class="btn-red" id="crmModalSubmit" onclick="CrmAdmin.submitEditContact(\'' + orgId + '\',\'' + contactId + '\')">Enregistrer</button>';
    openCrmModal('Modifier le contact', body, footer);
  }

  // DIRECT_RLS_CRUD: organization_contacts INSERT
  // If primary_contact is checked, use the atomic RPC instead of
  // setting primary_contact=true directly (avoids unique index race).
  async function submitCreateContact(orgId) {
    if (_mutating) return;
    clearModalError();
    var payload = collectContactForm(orgId);
    if (!payload) return;
    var wantPrimary = payload.primary_contact;
    delete payload.primary_contact; // never send primary_contact on INSERT
    setModalBusy(true);
    try {
      var client = sb();
      var res = await client.from('organization_contacts').insert(payload).select().single();
      if (res.error) { setModalBusy(false); setModalError(crmUserError(res.error, 'Une erreur est survenue. Veuillez réessayer.')); return; }
      // If primary was requested, use the atomic RPC.
      if (wantPrimary) {
        var priRes = await client.rpc('crm_set_primary_contact', {
          p_organization_id: orgId, p_contact_id: res.data.id
        });
        if (priRes.error) { setModalBusy(false); setModalError(crmUserError(priRes.error, 'Une erreur est survenue. Veuillez réessayer.')); return; }
      }
      setModalBusy(false);
      closeCrmModal();
      loadCrmOrgDetail(orgId);
    } catch (e) { setModalBusy(false); setModalError(crmUserError(e, 'Une erreur inattendue est survenue.')); }
  }

  // DIRECT_RLS_CRUD: organization_contacts UPDATE
  // If primary_contact changes, use the atomic RPC.
  async function submitEditContact(orgId, contactId) {
    if (_mutating) return;
    clearModalError();
    var payload = collectContactForm(orgId);
    if (!payload) return;
    var wantPrimary = payload.primary_contact;
    delete payload.primary_contact; // handle via RPC
    setModalBusy(true);
    try {
      var client = sb();
      // Fetch current to check if primary changed
      var curRes = await client.from('organization_contacts')
        .select('primary_contact').eq('id', contactId).maybeSingle();
      if (curRes.error) { setModalBusy(false); setModalError(crmUserError(curRes.error, 'Une erreur est survenue. Veuillez réessayer.')); return; }
      var wasPrimary = curRes.data ? curRes.data.primary_contact : false;
      var res = await client.from('organization_contacts').update(payload).eq('id', contactId);
      if (res.error) { setModalBusy(false); setModalError(crmUserError(res.error, 'Une erreur est survenue. Veuillez réessayer.')); return; }
      // If primary state changed, use the atomic RPC.
      if (wantPrimary && !wasPrimary) {
        var priRes = await client.rpc('crm_set_primary_contact', {
          p_organization_id: orgId, p_contact_id: contactId
        });
        if (priRes.error) { setModalBusy(false); setModalError(crmUserError(priRes.error, 'Une erreur est survenue. Veuillez réessayer.')); return; }
      } else if (!wantPrimary && wasPrimary) {
        var unPriRes = await client.rpc('crm_set_primary_contact', {
          p_organization_id: orgId, p_contact_id: null
        });
        if (unPriRes.error) { setModalBusy(false); setModalError(crmUserError(unPriRes.error, 'Une erreur est survenue. Veuillez réessayer.')); return; }
      }
      setModalBusy(false);
      closeCrmModal();
      loadCrmOrgDetail(orgId);
    } catch (e) { setModalBusy(false); setModalError(crmUserError(e, 'Une erreur inattendue est survenue.')); }
  }

  function collectContactForm(orgId) {
    return {
      organization_id: orgId,
      first_name: val('contact_first_name') || null,
      last_name: val('contact_last_name') || null,
      job_title: val('contact_job_title') || null,
      department: val('contact_department') || null,
      email: val('contact_email') || null,
      phone: val('contact_phone') || null,
      mobile: val('contact_mobile') || null,
      preferred_channel: val('contact_preferred_channel') || null,
      decision_maker: document.getElementById('contact_decision_maker').checked,
      primary_contact: document.getElementById('contact_primary').checked,
      active: document.getElementById('contact_active').checked,
      notes: val('contact_notes') || null
    };
  }

  // =========================================================
  // P3C2-C: OPPORTUNITY MUTATIONS
  // =========================================================

  function opportunityFormFields(o) {
    o = o || {};
    return [
      field('opp_title', 'Titre *', 'text', o.title, '', true),
      '<div class="f-grp"><label>Organisation</label><select id="opp_organization_id" class="crm-select" onchange="CrmAdmin.onOppOrgChange()">' + orgOptions(o.organization_id) + '</select></div>',
      '<div class="f-grp"><label>Contact (optionnel)</label><select id="opp_contact_id" class="crm-select"><option value="">—</option></select></div>',
      field('opp_estimated_value', 'Valeur estimée (€)', 'number', o.estimated_value),
      field('opp_probability', 'Probabilité (0-100)', 'number', o.probability),
      field('opp_source', 'Source', 'text', o.source),
      field('opp_source_detail', 'Détail source', 'text', o.source_detail),
      field('opp_campaign', 'Campagne', 'text', o.campaign),
      field('opp_external_reference', 'Référence externe', 'text', o.external_reference),
      field('opp_lead_first_name', 'Prénom lead', 'text', o.lead_first_name),
      field('opp_lead_last_name', 'Nom lead', 'text', o.lead_last_name),
      field('opp_lead_email', 'Email lead', 'email', o.lead_email),
      field('opp_lead_phone', 'Téléphone lead', 'tel', o.lead_phone),
      field('opp_next_action', 'Prochaine action', 'text', o.next_action),
      field('opp_next_action_at', 'Date prochaine action', 'datetime-local', o.next_action_at ? o.next_action_at.slice(0, 16) : ''),
      field('opp_last_contact_at', 'Dernier contact', 'datetime-local', o.last_contact_at ? o.last_contact_at.slice(0, 16) : '')
    ].join('');
  }

  function orgOptions(selectedId) {
    var opts = '<option value="">—</option>';
    if (_orgSummary.length) {
      opts += _orgSummary.map(function (r) {
        var nm = esc(r.trade_name || r.legal_name || '—');
        return '<option value="' + r.organization_id + '"' +
          (r.organization_id === selectedId ? ' selected' : '') + '>' + nm + '</option>';
      }).join('');
    }
    return opts;
  }

  // ---------------------------------------------------------
  // Scoped relationship selectors (RM01A-011)
  // Replace raw UUID text inputs with controlled <select> controls
  // populated from existing data. Options are scoped to the
  // selected organization so operators cannot accidentally link
  // cross-organization records. The submitted value remains the
  // correct UUID. No new RPCs, no schema or business-rule changes.
  // ---------------------------------------------------------
  function contactOptionLabel(c) {
    var n = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || '—';
    var bits = [];
    if (c.job_title) bits.push(c.job_title);
    if (c.email) bits.push(c.email);
    return n + (bits.length ? ' (' + bits.join(' · ') + ')' : '');
  }

  function opportunityOptionLabel(op) {
    var t = op.title || '—';
    if (op.stage && STAGE_LABELS[op.stage]) t += ' (' + STAGE_LABELS[op.stage] + ')';
    return t;
  }

  // Fetch contacts for a single organization (RLS direct read).
  // Returns null on error so callers can surface an empty/error state.
  async function fetchContactsForOrg(orgId) {
    if (!orgId) return [];
    var client = sb();
    if (!client) return [];
    try {
      var res = await client.from('organization_contacts')
        .select('id,first_name,last_name,job_title,email,phone,mobile,active')
        .eq('organization_id', orgId)
        .order('primary_contact', { ascending: false });
      if (res.error) { console.error('[CRM] contacts for org:', res.error); return null; }
      return res.data || [];
    } catch (e) { console.error('[CRM] contacts for org:', e); return null; }
  }

  // Fetch opportunities for a single organization. Reuses the cached
  // _oppData when available; otherwise issues a scoped RLS read.
  async function fetchOpportunitiesForOrg(orgId) {
    if (!orgId) return [];
    if (_oppData && _oppData.length) {
      return _oppData.filter(function (op) { return op.organization_id === orgId; });
    }
    var client = sb();
    if (!client) return [];
    try {
      var res = await client.from('crm_opportunities')
        .select('id,title,stage')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false });
      if (res.error) { console.error('[CRM] opps for org:', res.error); return null; }
      return res.data || [];
    } catch (e) { console.error('[CRM] opps for org:', e); return null; }
  }

  // Populate a contact <select> scoped to an organization. Handles
  // loading, empty, error and stale-selection states. The selected
  // id is preserved only when it belongs to the org; otherwise the
  // selection is cleared deterministically.
  async function populateContactSelect(selectId, orgId, selectedId) {
    var el = document.getElementById(selectId);
    if (!el) return;
    if (!orgId) {
      el.innerHTML = '<option value="">— Sélectionnez une organisation —</option>';
      el.value = '';
      return;
    }
    el.innerHTML = '<option value="">Chargement des contacts…</option>';
    el.disabled = true;
    var contacts = await fetchContactsForOrg(orgId);
    el.disabled = false;
    if (contacts === null) {
      el.innerHTML = '<option value="">Erreur de chargement des contacts</option>';
      el.value = '';
      return;
    }
    if (!contacts.length) {
      el.innerHTML = '<option value="">Aucun contact pour cette organisation</option>';
      el.value = '';
      return;
    }
    var found = false;
    var opts = '<option value="">—</option>' + contacts.map(function (c) {
      var sel = '';
      if (selectedId && c.id === selectedId) { sel = ' selected'; found = true; }
      return '<option value="' + esc(c.id) + '"' + sel + '>' + esc(contactOptionLabel(c)) + '</option>';
    }).join('');
    el.innerHTML = opts;
    el.value = found ? selectedId : '';
  }

  // Populate an opportunity <select> scoped to an organization.
  async function populateOpportunitySelect(selectId, orgId, selectedId) {
    var el = document.getElementById(selectId);
    if (!el) return;
    if (!orgId) {
      el.innerHTML = '<option value="">— Sélectionnez une organisation —</option>';
      el.value = '';
      return;
    }
    el.innerHTML = '<option value="">Chargement des opportunités…</option>';
    el.disabled = true;
    var opps = await fetchOpportunitiesForOrg(orgId);
    el.disabled = false;
    if (opps === null) {
      el.innerHTML = '<option value="">Erreur de chargement des opportunités</option>';
      el.value = '';
      return;
    }
    if (!opps.length) {
      el.innerHTML = '<option value="">Aucune opportunité pour cette organisation</option>';
      el.value = '';
      return;
    }
    var found = false;
    var opts = '<option value="">—</option>' + opps.map(function (op) {
      var sel = '';
      if (selectedId && op.id === selectedId) { sel = ' selected'; found = true; }
      return '<option value="' + esc(op.id) + '"' + sel + '>' + esc(opportunityOptionLabel(op)) + '</option>';
    }).join('');
    el.innerHTML = opts;
    el.value = found ? selectedId : '';
  }

  // onchange handlers: when the parent organization changes, stale
  // child selections are cleared (selectedId=null forces a reset).
  // These return/await the populate promises so callers (and tests)
  // can await completion deterministically.
  function onOppOrgChange() {
    return populateContactSelect('opp_contact_id', val('opp_organization_id'), null);
  }
  async function onActOrgChange() {
    var orgId = val('act_organization_id');
    await populateOpportunitySelect('act_opportunity_id', orgId, null);
    await populateContactSelect('act_contact_id', orgId, null);
  }
  async function onLinkDevisOrgChange() {
    var orgId = val('link_devis_org');
    await populateContactSelect('link_devis_contact', orgId, null);
    await populateOpportunitySelect('link_devis_opp', orgId, null);
  }

  function openCreateOpportunityForm() {
    var body = '<div class="f-row">' + opportunityFormFields({}) + '</div>' +
      '<div class="crm-muted" style="margin:8px 0;">L\'opportunité sera créée au stade « Lead ». Utilisez le pipeline pour changer de stade.</div>' +
      '<div id="crmModalError"></div>';
    var footer = '<button class="btn-outline" onclick="CrmAdmin.closeModal()">Annuler</button>' +
      '<button class="btn-red" id="crmModalSubmit" onclick="CrmAdmin.submitCreateOpportunity()">Créer</button>';
    openCrmModal('Nouvelle opportunité', body, footer);
    populateContactSelect('opp_contact_id', '', null);
  }

  function openEditOpportunityForm(oppId) {
    var opp = _oppMap[oppId];
    if (!opp) {
      Swal.fire('Erreur', 'Opportunité introuvable dans le cache local. Rechargez la liste.', 'error');
      return;
    }
    var body = '<div class="f-row">' + opportunityFormFields(opp) + '</div>' +
      '<div class="crm-muted" style="margin:8px 0;">Stade actuel : ' + esc(STAGE_LABELS[opp.stage] || opp.stage) +
      '. Utilisez le pipeline pour changer de stade.</div>' +
      '<div id="crmModalError"></div>';
    var footer = '<button class="btn-outline" onclick="CrmAdmin.closeModal()">Annuler</button>' +
      '<button class="btn-red" id="crmModalSubmit" onclick="CrmAdmin.submitEditOpportunity(\'' + oppId + '\')">Enregistrer</button>';
    openCrmModal('Modifier l\'opportunité', body, footer);
    populateContactSelect('opp_contact_id', opp.organization_id, opp.contact_id);
  }

  // DIRECT_RLS_CRUD: crm_opportunities INSERT
  // NEVER sends stage, lost_reason, created_by — column-level grants reject them.
  async function submitCreateOpportunity() {
    if (_mutating) return;
    clearModalError();
    var payload = collectOpportunityForm();
    if (!payload) return;
    setModalBusy(true);
    try {
      var client = sb();
      var res = await client.from('crm_opportunities').insert(payload).select().single();
      setModalBusy(false);
      if (res.error) { setModalError(crmUserError(res.error, 'Une erreur est survenue. Veuillez réessayer.')); return; }
      closeCrmModal();
      loadCrmOpportunities();
    } catch (e) { setModalBusy(false); setModalError(crmUserError(e, 'Une erreur inattendue est survenue.')); }
  }

  // DIRECT_RLS_CRUD: crm_opportunities UPDATE (business fields only)
  // NEVER sends stage, lost_reason, created_by.
  async function submitEditOpportunity(oppId) {
    if (_mutating) return;
    clearModalError();
    var payload = collectOpportunityForm();
    if (!payload) return;
    setModalBusy(true);
    try {
      var client = sb();
      var res = await client.from('crm_opportunities').update(payload).eq('id', oppId);
      setModalBusy(false);
      if (res.error) { setModalError(crmUserError(res.error, 'Une erreur est survenue. Veuillez réessayer.')); return; }
      closeCrmModal();
      loadCrmOpportunities();
    } catch (e) { setModalBusy(false); setModalError(crmUserError(e, 'Une erreur inattendue est survenue.')); }
  }

  function collectOpportunityForm() {
    var title = val('opp_title');
    if (!title || !title.trim()) { setModalError('Le titre est obligatoire.'); return null; }
    var orgId = val('opp_organization_id') || null;
    var contactId = val('opp_contact_id') || null;
    // If contact is set, org must be set (DB trigger enforces, but check early)
    if (contactId && !orgId) { setModalError('Un contact nécessite une organisation.'); return null; }
    var prob = val('opp_probability');
    if (prob !== '' && prob != null) {
      prob = parseInt(prob, 10);
      if (isNaN(prob) || prob < 0 || prob > 100) { setModalError('Probabilité : 0 à 100.'); return null; }
    } else { prob = null; }
    var value = val('opp_estimated_value');
    if (value !== '' && value != null) {
      value = parseFloat(value);
      if (isNaN(value) || value < 0) { setModalError('Valeur estimée doit être positive.'); return null; }
    } else { value = null; }
    return {
      title: title.trim(),
      organization_id: orgId,
      contact_id: contactId || null,
      estimated_value: value,
      probability: prob,
      source: val('opp_source') || null,
      source_detail: val('opp_source_detail') || null,
      campaign: val('opp_campaign') || null,
      external_reference: val('opp_external_reference') || null,
      lead_first_name: val('opp_lead_first_name') || null,
      lead_last_name: val('opp_lead_last_name') || null,
      lead_email: val('opp_lead_email') || null,
      lead_phone: val('opp_lead_phone') || null,
      next_action: val('opp_next_action') || null,
      next_action_at: val('opp_next_action_at') ? val('opp_next_action_at') + ':00' : null,
      last_contact_at: val('opp_last_contact_at') ? val('opp_last_contact_at') + ':00' : null
    };
  }

  // EXISTING_RPC: crm_transition_opportunity
  async function transitionOpportunity(oppId, toStage, reason) {
    if (_mutating) return;
    setModalBusy(true);
    try {
      var client = sb();
      var params = { p_opportunity_id: oppId, p_to_stage: toStage };
      if (reason) params.p_reason = reason;
      var res = await client.rpc('crm_transition_opportunity', params);
      setModalBusy(false);
      if (res.error) { setModalError(crmUserError(res.error, 'Une erreur est survenue. Veuillez réessayer.')); return false; }
      closeCrmModal();
      loadCrmOpportunities();
      if (_currentOrgId) loadCrmOrgDetail(_currentOrgId);
      return true;
    } catch (e) { setModalBusy(false); setModalError(crmUserError(e, 'Une erreur inattendue est survenue.')); return false; }
  }

  function openTransitionForm(oppId, currentStage) {
    var candidates = TRANSITION_MAP[currentStage] || [];
    if (!candidates.length) {
      var body = '<div class="crm-state crm-empty"><i class="fas fa-info-circle"></i> Stade terminal — aucune transition possible depuis « ' +
        esc(STAGE_LABELS[currentStage] || currentStage) + ' ».</div>';
      openCrmModal('Transition de pipeline', body,
        '<button class="btn-outline" onclick="CrmAdmin.closeModal()">Fermer</button>');
      return;
    }
    var stageOpts = candidates.map(function (s) {
      return '<option value="' + s + '">' + esc(STAGE_LABELS[s] || s) + '</option>';
    }).join('');
    var body = '<div class="f-grp"><label>Stade actuel</label><div class="crm-muted">' +
      esc(STAGE_LABELS[currentStage] || currentStage) + '</div></div>' +
      '<div class="f-grp"><label>Nouveau stade *</label><select id="trans_to_stage" class="crm-select">' + stageOpts + '</select></div>' +
      '<div class="f-grp"><label>Raison (optionnel)</label><textarea id="trans_reason" rows="2"></textarea></div>' +
      '<div id="crmModalError"></div>';
    var footer = '<button class="btn-outline" onclick="CrmAdmin.closeModal()">Annuler</button>' +
      '<button class="btn-red" id="crmModalSubmit" onclick="CrmAdmin.submitTransition(\'' + oppId + '\',\'' + currentStage + '\')">Transition</button>';
    openCrmModal('Transition de pipeline', body, footer);
  }

  async function submitTransition(oppId, currentStage) {
    if (_mutating) return;
    clearModalError();
    var toStage = val('trans_to_stage');
    if (!toStage) { setModalError('Sélectionnez un stage.'); return; }
    var reason = val('trans_reason') || null;
    await transitionOpportunity(oppId, toStage, reason);
  }

  // =========================================================
  // P3C2-D: ACTIVITY MUTATIONS
  // =========================================================

  function activityFormFields(a) {
    a = a || {};
    var typeOpts = ACTIVITY_TYPES.map(function (t) {
      return '<option value="' + t + '"' + (a.activity_type === t ? ' selected' : '') + '>' +
        esc(ACTIVITY_TYPE_LABELS[t] || t) + '</option>';
    }).join('');
    var statusOpts = ACTIVITY_STATUS.map(function (s) {
      return '<option value="' + s + '"' + (a.status === s ? ' selected' : '') + '>' +
        esc(ACTIVITY_STATUS_LABELS[s] || s) + '</option>';
    }).join('');
    var dirOpts = ['inbound', 'outbound', 'internal'].map(function (d) {
      return '<option value="' + d + '"' + (a.direction === d ? ' selected' : '') + '>' + esc(d) + '</option>';
    }).join('');
    return [
      field('act_subject', 'Sujet *', 'text', a.subject, '', true),
      '<div class="f-grp"><label>Type *</label><select id="act_activity_type" class="crm-select">' + typeOpts + '</select></div>',
      '<div class="f-grp"><label>Direction</label><select id="act_direction" class="crm-select"><option value="">—</option>' + dirOpts + '</select></div>',
      '<div class="f-grp"><label>Statut</label><select id="act_status" class="crm-select">' + statusOpts + '</select></div>',
      '<div class="f-grp"><label>Organisation</label><select id="act_organization_id" class="crm-select" onchange="CrmAdmin.onActOrgChange()">' + orgOptions(a.organization_id) + '</select></div>',
      '<div class="f-grp"><label>Opportunité (optionnel)</label><select id="act_opportunity_id" class="crm-select"><option value="">—</option></select></div>',
      '<div class="f-grp"><label>Contact (optionnel)</label><select id="act_contact_id" class="crm-select"><option value="">—</option></select></div>',
      '<div class="f-grp"><label>Assigné à</label><select id="act_assigned_to" class="crm-select"><option value="">—</option>' + internalUserOptions(a.assigned_to) + '</select></div>',
      field('act_occurred_at', 'Date d\'occurrence', 'datetime-local', a.occurred_at ? a.occurred_at.slice(0, 16) : ''),
      field('act_due_at', 'Échéance', 'datetime-local', a.due_at ? a.due_at.slice(0, 16) : ''),
      field('act_completed_at', 'Date de complétion', 'datetime-local', a.completed_at ? a.completed_at.slice(0, 16) : ''),
      '<div class="f-grp"><label>Description</label><textarea id="act_body" rows="3">' + esc(a.body || '') + '</textarea></div>'
    ].join('');
  }

  function openCreateActivityForm() {
    var body = '<div class="f-row">' + activityFormFields({}) + '</div><div id="crmModalError"></div>';
    var footer = '<button class="btn-outline" onclick="CrmAdmin.closeModal()">Annuler</button>' +
      '<button class="btn-red" id="crmModalSubmit" onclick="CrmAdmin.submitCreateActivity()">Créer</button>';
    openCrmModal('Nouvelle activité', body, footer);
    populateOpportunitySelect('act_opportunity_id', '', null);
    populateContactSelect('act_contact_id', '', null);
  }

  function openEditActivityForm(actId) {
    var activity = _actMap[actId];
    if (!activity) {
      Swal.fire('Erreur', 'Activité introuvable dans le cache local. Rechargez la liste.', 'error');
      return;
    }
    var body = '<div class="f-row">' + activityFormFields(activity) + '</div><div id="crmModalError"></div>';
    var footer = '<button class="btn-outline" onclick="CrmAdmin.closeModal()">Annuler</button>' +
      '<button class="btn-red" id="crmModalSubmit" onclick="CrmAdmin.submitEditActivity(\'' + actId + '\')">Enregistrer</button>';
    openCrmModal('Modifier l\'activité', body, footer);
    populateOpportunitySelect('act_opportunity_id', activity.organization_id, activity.opportunity_id);
    populateContactSelect('act_contact_id', activity.organization_id, activity.contact_id);
  }

  // DIRECT_RLS_CRUD: crm_activities INSERT
  // NEVER sends created_by — server-derived via trigger.
  async function submitCreateActivity() {
    if (_mutating) return;
    clearModalError();
    var payload = collectActivityForm();
    if (!payload) return;
    setModalBusy(true);
    try {
      var client = sb();
      var res = await client.from('crm_activities').insert(payload);
      setModalBusy(false);
      if (res.error) { setModalError(crmUserError(res.error, 'Une erreur est survenue. Veuillez réessayer.')); return; }
      closeCrmModal();
      loadCrmActivities();
    } catch (e) { setModalBusy(false); setModalError(crmUserError(e, 'Une erreur inattendue est survenue.')); }
  }

  // DIRECT_RLS_CRUD: crm_activities UPDATE
  async function submitEditActivity(actId) {
    if (_mutating) return;
    clearModalError();
    var payload = collectActivityForm();
    if (!payload) return;
    setModalBusy(true);
    try {
      var client = sb();
      var res = await client.from('crm_activities').update(payload).eq('id', actId);
      setModalBusy(false);
      if (res.error) { setModalError(crmUserError(res.error, 'Une erreur est survenue. Veuillez réessayer.')); return; }
      closeCrmModal();
      loadCrmActivities();
    } catch (e) { setModalBusy(false); setModalError(crmUserError(e, 'Une erreur inattendue est survenue.')); }
  }

  function collectActivityForm() {
    var subject = val('act_subject');
    if (!subject || !subject.trim()) { setModalError('Le sujet est obligatoire.'); return null; }
    var orgId = val('act_organization_id') || null;
    var contactId = val('act_contact_id') || null;
    var oppId = val('act_opportunity_id') || null;
    // If contact is set, org must be set (DB trigger enforces)
    if (contactId && !orgId) { setModalError('Un contact nécessite une organisation.'); return null; }
    return {
      subject: subject.trim(),
      activity_type: val('act_activity_type') || 'note',
      direction: val('act_direction') || null,
      status: val('act_status') || 'completed',
      organization_id: orgId,
      contact_id: contactId || null,
      opportunity_id: oppId || null,
      assigned_to: val('act_assigned_to') || null,
      occurred_at: val('act_occurred_at') ? val('act_occurred_at') + ':00' : null,
      due_at: val('act_due_at') ? val('act_due_at') + ':00' : null,
      completed_at: val('act_completed_at') ? val('act_completed_at') + ':00' : null,
      body: val('act_body') || null
    };
  }

  // =========================================================
  // P3C2-E: CRM LINK MUTATIONS
  // =========================================================

  // EXISTING_RPC: crm_link_client_organization
  async function linkClientOrganization(clientId, organizationId) {
    if (_mutating) return;
    setModalBusy(true);
    try {
      var client = sb();
      var res = await client.rpc('crm_link_client_organization', {
        p_client_id: clientId, p_organization_id: organizationId || null
      });
      setModalBusy(false);
      if (res.error) { setModalError(crmUserError(res.error, 'Une erreur est survenue. Veuillez réessayer.')); return false; }
      closeCrmModal();
      return true;
    } catch (e) { setModalBusy(false); setModalError(crmUserError(e, 'Une erreur inattendue est survenue.')); return false; }
  }

  // EXISTING_RPC: crm_link_devis_crm
  async function linkDevisCrm(devisId, organizationId, contactId, opportunityId) {
    if (_mutating) return;
    setModalBusy(true);
    try {
      var client = sb();
      var res = await client.rpc('crm_link_devis_crm', {
        p_devis_id: devisId,
        p_organization_id: organizationId || null,
        p_contact_id: contactId || null,
        p_opportunity_id: opportunityId || null
      });
      setModalBusy(false);
      if (res.error) { setModalError(crmUserError(res.error, 'Une erreur est survenue. Veuillez réessayer.')); return false; }
      closeCrmModal();
      return true;
    } catch (e) { setModalBusy(false); setModalError(crmUserError(e, 'Une erreur inattendue est survenue.')); return false; }
  }

  // EXISTING_RPC: crm_link_mission_devis
  async function linkMissionDevis(missionId, devisId, organizationId) {
    if (_mutating) return;
    setModalBusy(true);
    try {
      var client = sb();
      var res = await client.rpc('crm_link_mission_devis', {
        p_mission_id: missionId,
        p_devis_id: devisId || null,
        p_organization_id: organizationId || null
      });
      setModalBusy(false);
      if (res.error) { setModalError(crmUserError(res.error, 'Une erreur est survenue. Veuillez réessayer.')); return false; }
      closeCrmModal();
      return true;
    } catch (e) { setModalBusy(false); setModalError(crmUserError(e, 'Une erreur inattendue est survenue.')); return false; }
  }

  function openLinkClientForm(clientId, currentOrgId) {
    var body = '<div class="f-grp"><label>Client ID</label><input type="text" value="' + esc(clientId) + '" readonly></div>' +
      '<div class="f-grp"><label>Organisation</label><select id="link_org_id" class="crm-select">' + orgOptions(currentOrgId) + '</select></div>' +
      '<div id="crmModalError"></div>';
    var footer = '<button class="btn-outline" onclick="CrmAdmin.closeModal()">Annuler</button>' +
      '<button class="btn-red" id="crmModalSubmit" onclick="CrmAdmin.submitLinkClient(\'' + esc(clientId) + '\')">Lier</button>';
    openCrmModal('Lier client → organisation', body, footer);
  }

  async function submitLinkClient(clientId) {
    if (_mutating) return;
    clearModalError();
    var orgId = val('link_org_id') || null;
    await linkClientOrganization(clientId, orgId);
  }

  function openLinkDevisForm(devisId, currentLinks) {
    currentLinks = currentLinks || {};
    var body = '<div class="f-grp"><label>Devis ID</label><input type="text" value="' + esc(devisId) + '" readonly></div>' +
      '<div class="f-grp"><label>Organisation</label><select id="link_devis_org" class="crm-select" onchange="CrmAdmin.onLinkDevisOrgChange()">' + orgOptions(currentLinks.organization_id) + '</select></div>' +
      '<div class="f-grp"><label>Contact (optionnel)</label><select id="link_devis_contact" class="crm-select"><option value="">—</option></select></div>' +
      '<div class="f-grp"><label>Opportunité (optionnel)</label><select id="link_devis_opp" class="crm-select"><option value="">—</option></select></div>' +
      '<div id="crmModalError"></div>';
    var footer = '<button class="btn-outline" onclick="CrmAdmin.closeModal()">Annuler</button>' +
      '<button class="btn-red" id="crmModalSubmit" onclick="CrmAdmin.submitLinkDevis(\'' + esc(devisId) + '\')">Lier</button>';
    openCrmModal('Lier devis → CRM', body, footer);
    populateContactSelect('link_devis_contact', currentLinks.organization_id, currentLinks.contact_id);
    populateOpportunitySelect('link_devis_opp', currentLinks.organization_id, currentLinks.opportunity_id);
  }

  async function submitLinkDevis(devisId) {
    if (_mutating) return;
    clearModalError();
    var orgId = val('link_devis_org') || null;
    var contactId = val('link_devis_contact') || null;
    var oppId = val('link_devis_opp') || null;
    await linkDevisCrm(devisId, orgId, contactId, oppId);
  }

  function openLinkMissionForm(missionId, currentLinks) {
    currentLinks = currentLinks || {};
    var body = '<div class="f-grp"><label>Mission ID</label><input type="text" value="' + esc(missionId) + '" readonly></div>' +
      '<div class="f-grp"><label>Devis (UUID)</label><input type="text" id="link_mission_devis" class="crm-input" value="' + esc(currentLinks.devis_id || '') + '"></div>' +
      '<div class="f-grp"><label>Organisation</label><select id="link_mission_org" class="crm-select">' + orgOptions(currentLinks.organization_id) + '</select></div>' +
      '<div id="crmModalError"></div>';
    var footer = '<button class="btn-outline" onclick="CrmAdmin.closeModal()">Annuler</button>' +
      '<button class="btn-red" id="crmModalSubmit" onclick="CrmAdmin.submitLinkMission(\'' + esc(missionId) + '\')">Lier</button>';
    openCrmModal('Lier mission → devis + organisation', body, footer);
  }

  async function submitLinkMission(missionId) {
    if (_mutating) return;
    clearModalError();
    var devisId = val('link_mission_devis') || null;
    var orgId = val('link_mission_org') || null;
    await linkMissionDevis(missionId, devisId, orgId);
  }

  // =========================================================
  // Shared form helpers
  // =========================================================
  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value : '';
  }
  function field(id, label, type, value, placeholder, required) {
    return '<div class="f-grp"><label>' + esc(label) + '</label>' +
      '<input type="' + type + '" id="' + id + '" class="crm-input" value="' + esc(value || '') + '"' +
      (placeholder ? ' placeholder="' + esc(placeholder) + '"' : '') +
      (required ? ' required' : '') + '></div>';
  }

  // =========================================================
  // Data refresh helpers
  // =========================================================
  async function refreshOrgSummary() {
    var client = sb();
    if (!client) return;
    try {
      var res = await client.rpc('crm_organizations_summary');
      if (!res.error && res.data) {
        _orgSummary = res.data;
        _orgMap = {};
        res.data.forEach(function (r) { _orgMap[r.organization_id] = r; });
        populateOrgSelects();
      }
    } catch (_) {}
  }

  // ---------------------------------------------------------
  // Init
  // ---------------------------------------------------------
  function initAll() {
    // Preload dashboard + lists. Tabs load their own data on first open too.
    loadCrmDashboard();
    // Preload internal users for the activity assigned_to picker.
    ensureInternalUsers();
  }

  // ---------------------------------------------------------
  // Public API
  // ---------------------------------------------------------
  window.CrmAdmin = {
    initAll: initAll,
    loadDashboard: loadCrmDashboard,
    loadOrganizations: loadCrmOrganizations,
    loadOpportunities: loadCrmOpportunities,
    loadActivities: loadCrmActivities,
    loadTimeline: loadCrmTimeline,
    openOrgDetail: openCrmOrgDetail,
    closeOrgDetail: closeCrmOrgDetail,
    nextTimelinePage: nextTimelinePage,
    nextOrgTimelinePage: nextOrgTimelinePage,
    setOrgFilter: setOrgFilter,
    setOrgSort: setOrgSort,
    setOppFilter: setOppFilter,
    setActFilter: setActFilter,
    // P3C2 mutations
    closeModal: closeCrmModal,
    openCreateOrgForm: openCreateOrgForm,
    openEditOrgForm: openEditOrgForm,
    submitCreateOrg: submitCreateOrg,
    submitEditOrg: submitEditOrg,
    archiveOrg: archiveOrg,
    openSegmentManager: openSegmentManager,
    submitSegments: submitSegments,
    openCreateSiteForm: openCreateSiteForm,
    openEditSiteForm: openEditSiteForm,
    submitCreateSite: submitCreateSite,
    submitEditSite: submitEditSite,
    openCreateContactForm: openCreateContactForm,
    openEditContactForm: openEditContactForm,
    submitCreateContact: submitCreateContact,
    submitEditContact: submitEditContact,
    openCreateOpportunityForm: openCreateOpportunityForm,
    openEditOpportunityForm: openEditOpportunityForm,
    submitCreateOpportunity: submitCreateOpportunity,
    submitEditOpportunity: submitEditOpportunity,
    openTransitionForm: openTransitionForm,
    submitTransition: submitTransition,
    openCreateActivityForm: openCreateActivityForm,
    openEditActivityForm: openEditActivityForm,
    submitCreateActivity: submitCreateActivity,
    submitEditActivity: submitEditActivity,
    openLinkClientForm: openLinkClientForm,
    submitLinkClient: submitLinkClient,
    openLinkDevisForm: openLinkDevisForm,
    submitLinkDevis: submitLinkDevis,
    openLinkMissionForm: openLinkMissionForm,
    submitLinkMission: submitLinkMission,
    // RM-01C scoped relationship selectors (onchange handlers)
    onOppOrgChange: onOppOrgChange,
    onActOrgChange: onActOrgChange,
    onLinkDevisOrgChange: onLinkDevisOrgChange,
    // Exposed for static tests (no secrets, no privileged paths).
    _buildTimelineParams: buildTimelineParams,
    _STAGE_LABELS: STAGE_LABELS,
    _ACTIVITY_TYPE_LABELS: ACTIVITY_TYPE_LABELS,
    _ACTIVITY_STATUS_LABELS: ACTIVITY_STATUS_LABELS,
    _ORG_STATUS_LABELS: ORG_STATUS_LABELS,
    _SOURCE_LABELS: SOURCE_LABELS,
    _RECORD_KIND_LABELS: RECORD_KIND_LABELS,
    _TIMELINE_DEFAULT_LIMIT: TIMELINE_DEFAULT_LIMIT,
    _TIMELINE_MAX_LIMIT: TIMELINE_MAX_LIMIT,
    _TRANSITION_MAP: TRANSITION_MAP,
    // RM-01C test helpers
    _collectOrgForm: collectOrgForm,
    _populateContactSelect: populateContactSelect,
    _populateOpportunitySelect: populateOpportunitySelect,
    _fetchContactsForOrg: fetchContactsForOrg,
    _fetchOpportunitiesForOrg: fetchOpportunitiesForOrg,
    // RM-01D test helpers
    _crmUserError: crmUserError,
    _CRM_ERROR_MAP: CRM_ERROR_MAP,
    _actorLabel: actorLabel,
    _setInternalUserMapForTest: function (m) { _internalUserMap = m || {}; },
    _renderTimelineRow: renderTimelineRow
  };
})();
