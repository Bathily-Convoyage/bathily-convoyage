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
  var _oppFilters = { q: '', stage: 'all' };
  var _actData = [];
  var _actFilters = { q: '', type: 'all', status: 'all', org: 'all' };
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
  function handleRpcError(error, containerId, context) {
    console.error('[CRM] ' + (context || 'RPC error') + ':', error);
    var msg = 'Erreur de chargement.';
    if (error && error.message) {
      // RLS / authorization errors are surfaced honestly, never worked around.
      if (/Non autorisé|42501|jwt|permission/i.test(error.message)) {
        msg = "Accès refusé par la base de données. Cette opération nécessite un utilisateur interne (admin/opérateur).";
      } else {
        msg = error.message;
      }
    }
    setError(containerId, msg);
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
    if (countEl) countEl.innerHTML = rows.length + ' organisation' + (rows.length > 1 ? 's' : '') + ' <em>active(s)</em>';

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

      // Timeline (cursor-paginated)
      _orgDetailTimelineCursor = { eventAt: null, eventKey: null, hasMore: false, loading: false };
      await loadCrmOrgTimeline(id, true);
    } catch (e) { handleRpcError(e, 'crmOrgDetailBody', 'loadCrmOrgDetail'); }
  }

  function renderCrmOrgDetail(ctx) {
    var o = ctx.org;
    var html = '';

    // Back button
    html += '<button class="btn-outline crm-back" onclick="CrmAdmin.closeOrgDetail()"><i class="fas fa-arrow-left"></i> Retour</button>';

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
    html += '<div class="sec-title"><h3 class="crm-sub-h">Sites (' + ctx.sites.length + ')</h3></div>';
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
          '</div>';
      });
      html += '</div>';
    } else {
      html += '<div class="crm-muted">Aucun site.</div>';
    }

    // Contacts
    html += '<div class="sec-title"><h3 class="crm-sub-h">Contacts (' + ctx.contacts.length + ')</h3></div>';
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
          '<td>' + (c.active ? pill('Actif', 'sp-ok') : pill('Inactif', 'sp-att')) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<div class="crm-muted">Aucun contact.</div>';
    }

    // Opportunities
    html += '<div class="sec-title"><h3 class="crm-sub-h">Opportunités (' + ctx.opportunities.length + ')</h3></div>';
    if (ctx.opportunities.length) {
      html += '<div class="table-scroll"><table class="data-table"><thead><tr>' +
        '<th>Titre</th><th>Étape</th><th>Valeur</th><th>Prob.</th><th>Prochaine action</th><th>Dernier contact</th></tr></thead><tbody>';
      ctx.opportunities.forEach(function (op) {
        html += '<tr><td>' + esc(op.title) + '</td>' +
          '<td>' + pill(STAGE_LABELS[op.stage] || op.stage, STAGE_PILL[op.stage]) + '</td>' +
          '<td class="td-price">' + fmtEur(op.estimated_value) + '</td>' +
          '<td>' + (op.probability != null ? op.probability + '%' : '—') + '</td>' +
          '<td>' + (op.next_action ? esc(op.next_action) + ' <span class="crm-muted">(' + fmtDate(op.next_action_at) + ')</span>' : '—') + '</td>' +
          '<td>' + fmtDate(op.last_contact_at) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<div class="crm-muted">Aucune opportunité.</div>';
    }

    // Activities
    html += '<div class="sec-title"><h3 class="crm-sub-h">Activités (' + ctx.activities.length + ')</h3></div>';
    if (ctx.activities.length) {
      html += '<div class="table-scroll"><table class="data-table"><thead><tr>' +
        '<th>Sujet</th><th>Type</th><th>Statut</th><th>Échéance</th><th>Effectuée le</th></tr></thead><tbody>';
      ctx.activities.slice(0, 20).forEach(function (a) {
        html += '<tr><td>' + esc(a.subject) + '</td>' +
          '<td>' + pill(ACTIVITY_TYPE_LABELS[a.activity_type] || a.activity_type, 'sp-cours', ACTIVITY_TYPE_ICON[a.activity_type]) + '</td>' +
          '<td>' + pill(ACTIVITY_STATUS_LABELS[a.status] || a.status, ACTIVITY_STATUS_PILL[a.status]) + '</td>' +
          '<td>' + fmtDate(a.due_at) + '</td><td>' + fmtDate(a.occurred_at) + '</td></tr>';
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
      // Resolve contact names (separate light query would need per-id; instead
      // fetch all contacts once for the lookup map).
      if (_oppData.length) {
        try {
          var ct = await client.from('organization_contacts')
            .select('id,first_name,last_name').limit(1000);
          if (!ct.error && ct.data) {
            _contactMap = {};
            ct.data.forEach(function (c) { _contactMap[c.id] = c; });
          }
        } catch (_) {}
      }
      renderCrmOpportunities();
    } catch (e) { handleRpcError(e, 'crmOppBody', 'loadCrmOpportunities'); }
  }
  var _contactMap = {};

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
    if (!rows.length) {
      body.innerHTML = '<div class="crm-state crm-empty"><i class="fas fa-inbox"></i> Aucune opportunité.</div>';
      return;
    }

    // Read-only table view (Kanban deferred — table fits the existing arch cleanly).
    var html = '<div class="table-scroll"><table class="data-table"><thead><tr>' +
      '<th>Titre</th><th>Organisation</th><th>Contact</th><th>Étape</th><th>Valeur</th>' +
      '<th>Prob.</th><th>Prochaine action</th><th>Date</th><th>Dernier contact</th><th>Source</th></tr></thead><tbody>';
    rows.forEach(function (op) {
      var c = _contactMap[op.contact_id];
      html += '<tr style="cursor:pointer;" onclick="CrmAdmin.openOrgDetail(\'' + (op.organization_id || '') + '\')">' +
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
    if (!rows.length) {
      body.innerHTML = '<div class="crm-state crm-empty"><i class="fas fa-inbox"></i> Aucune activité.</div>';
      return;
    }
    var html = '<div class="table-scroll"><table class="data-table"><thead><tr>' +
      '<th>Sujet</th><th>Type</th><th>Statut</th><th>Organisation</th><th>Opportunité</th>' +
      '<th>Assigné à</th><th>Effectuée le</th><th>Échéance</th><th>Terminée le</th></tr></thead><tbody>';
    rows.forEach(function (a) {
      // auth.users is not readable via RLS, so the assigned user name cannot
      // be resolved. We show a neutral placeholder rather than a raw UUID.
      var assigned = a.assigned_to ? 'Utilisateur interne' : '—';
      html += '<tr style="cursor:pointer;" onclick="CrmAdmin.openOrgDetail(\'' + (a.organization_id || '') + '\')">' +
        '<td>' + esc(a.subject) + '</td>' +
        '<td>' + pill(ACTIVITY_TYPE_LABELS[a.activity_type] || a.activity_type, 'sp-cours', ACTIVITY_TYPE_ICON[a.activity_type]) + '</td>' +
        '<td>' + pill(ACTIVITY_STATUS_LABELS[a.status] || a.status, ACTIVITY_STATUS_PILL[a.status]) + '</td>' +
        '<td>' + orgName(a.organization_id) + '</td>' +
        '<td>' + (a.opportunity_id ? '<i class="fas fa-link crm-muted"></i>' : '—') + '</td>' +
        '<td>' + esc(assigned) + '</td>' +
        '<td>' + fmtDate(a.occurred_at) + '</td>' +
        '<td>' + fmtDate(a.due_at) + '</td>' +
        '<td>' + fmtDate(a.completed_at) + '</td>' +
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
    var actor = r.actor_role ? '<span class="crm-tl-actor">' + esc(r.actor_role) + '</span>' : '';
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

  // ---------------------------------------------------------
  // Init
  // ---------------------------------------------------------
  function initAll() {
    // Preload dashboard + lists. Tabs load their own data on first open too.
    loadCrmDashboard();
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
    // Exposed for static tests (no secrets, no privileged paths).
    _buildTimelineParams: buildTimelineParams,
    _STAGE_LABELS: STAGE_LABELS,
    _ACTIVITY_TYPE_LABELS: ACTIVITY_TYPE_LABELS,
    _ACTIVITY_STATUS_LABELS: ACTIVITY_STATUS_LABELS,
    _ORG_STATUS_LABELS: ORG_STATUS_LABELS,
    _SOURCE_LABELS: SOURCE_LABELS,
    _RECORD_KIND_LABELS: RECORD_KIND_LABELS,
    _TIMELINE_DEFAULT_LIMIT: TIMELINE_DEFAULT_LIMIT,
    _TIMELINE_MAX_LIMIT: TIMELINE_MAX_LIMIT
  };
})();
