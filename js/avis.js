/**
 * Système d'avis — Bathily-Convoyage
 * Affichage + dépôt d'avis clients/convoyeurs
 */

(function () {
  'use strict';

  // ── Helpers Supabase ──
  function getSB() {
    if (window._sbClient) return window._sbClient;
    if (window.BathilyAuth && window.BathilyAuth.getSB) return window.BathilyAuth.getSB();
    if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY || !window.supabase) return null;
    window._sbClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    return window._sbClient;
  }

  // ── Étoiles HTML ──
  function starsHTML(note) {
    var html = '';
    for (var i = 1; i <= 5; i++) {
      html += '<i class="fas fa-star' + (i <= note ? '' : '-far') + '" style="color:#F5A623;font-size:0.85rem;"></i>';
    }
    return html;
  }

  // ── Avis de démonstration (fallback si base vide) ──
    // ── Charger les avis approuvés ──
  async function loadAvis(container, limit) {
    var sb = getSB();
    if (!sb) {
      renderAvis(container, [], limit);
      return;
    }

    try {
      var query = sb.from('avis_public').select('auteur_nom,note,titre,commentaire,ville,created_at').order('created_at', { ascending: false });
      if (limit) query = query.limit(limit);

      var _ref = await query;
      var data = _ref.data;
      var error = _ref.error;

      if (error) throw error;
      if (!data || data.length === 0) {
        renderAvis(container, [], limit);
        return;
      }

      renderAvis(container, data, limit);
    } catch (err) {
      console.error('Erreur loadAvis:', err && err.message ? err.message : JSON.stringify(err));
      renderAvis(container, [], limit);
    }
  }

  // ── Rendre les avis dans le container ──
  var VISIBLE_COUNT = 3;

  function buildAvisCard(a) {
    var dateStr = new Date(a.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    var initial = escapeHTML((a.auteur_nom || 'A')[0].toUpperCase());

    var html = '<div class="avis-card" style="background:white;border:1px solid var(--border-light);border-radius:16px;padding:20px;margin-bottom:16px;">';
    html += '<div style="display:flex;align-items:flex-start;gap:14px;">';
    html += '<div style="width:44px;height:44px;border-radius:50%;background:var(--bordeaux-light);color:var(--bordeaux);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1.1rem;flex-shrink:0;">' + initial + '</div>';
    html += '<div style="flex:1;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">';
    html += '<strong style="font-size:0.9rem;color:var(--gray-dark);">' + escapeHTML(a.auteur_nom) + '</strong>';
    html += '<span style="font-size:0.72rem;color:var(--gray-mid);">' + dateStr + '</span>';
    html += '</div>';
    html += '<div style="margin:4px 0 8px;">' + starsHTML(a.note) + '</div>';
    if (a.titre) html += '<div style="font-weight:700;font-size:0.88rem;color:var(--gray-dark);margin-bottom:4px;">' + escapeHTML(a.titre) + '</div>';
    html += '<p style="font-size:0.85rem;color:var(--gray-mid);line-height:1.5;">' + escapeHTML(a.commentaire) + '</p>';
    if (a.ville) html += '<span style="display:inline-block;margin-top:8px;font-size:0.72rem;color:var(--bordeaux);background:var(--bordeaux-light);padding:3px 10px;border-radius:20px;">📍 ' + escapeHTML(a.ville) + '</span>';
    html += '</div></div></div>';
    return html;
  }

  function renderAvis(container, data, limit) {
    if (limit) data = data.slice(0, limit);

    if (!data || data.length === 0) {
      container.innerHTML = '<p style="color:var(--gray-mid);font-size:0.85rem;text-align:center;">Aucun avis client publié pour le moment.</p>';
      return;
    }

      // Calculer la note moyenne
      var total = data.reduce(function (s, a) { return s + a.note; }, 0);
      var moyenne = (total / data.length).toFixed(1);

      var html = '<div class="avis-summary" style="margin-bottom:24px;text-align:center;">';
      html += '<div style="font-size:2rem;font-weight:800;color:var(--bordeaux);font-family:Montserrat,sans-serif;">' + moyenne + '/5</div>';
      html += '<div style="margin:4px 0;">' + starsHTML(Math.round(moyenne)) + '</div>';
      html += '<div style="font-size:0.8rem;color:var(--gray-mid);">Basé sur ' + data.length + ' avis</div>';
      html += '</div>';

      html += '<div class="avis-list" id="avisList">';
      for (var i = 0; i < data.length; i++) {
        var card = buildAvisCard(data[i]);
        if (i >= VISIBLE_COUNT) {
          card = card.replace('class="avis-card"', 'class="avis-card avis-hidden"');
        }
        html += card;
      }
      html += '</div>';

      if (data.length > VISIBLE_COUNT) {
        html += '<div style="text-align:center;margin-top:20px;">';
        html += '<button id="btnToggleAvis">';
        html += 'Voir les ' + (data.length - VISIBLE_COUNT) + ' autres avis';
        html += ' <i class="fas fa-chevron-down" id="toggleAvisIcon" style="font-size:0.75rem;transition:transform 0.3s;"></i>';
        html += '</button>';
        html += '</div>';
      }

      container.innerHTML = html;

      var btnToggle = document.getElementById('btnToggleAvis');
      if (btnToggle) {
        btnToggle.addEventListener('click', function () {
          var hiddenCards = container.querySelectorAll('.avis-hidden');
          var expanded = hiddenCards[0] && hiddenCards[0].style.display !== 'none' ? false : true;

          if (expanded) {
            hiddenCards.forEach(function (c) { c.style.display = 'none'; });
            btnToggle.innerHTML = 'Voir les ' + hiddenCards.length + ' autres avis <i class="fas fa-chevron-down" id="toggleAvisIcon" style="font-size:0.75rem;transition:transform 0.3s;"></i>';
          } else {
            hiddenCards.forEach(function (c) { c.style.display = 'block'; });
            btnToggle.innerHTML = 'Réduire les avis <i class="fas fa-chevron-up" id="toggleAvisIcon" style="font-size:0.75rem;transition:transform 0.3s;"></i>';
          }
        });
      }
  }

  // ── Ouvrir modal dépôt d'avis ──
  function openAvisModal() {
    if (typeof Swal === 'undefined') {
      alert('SweetAlert2 non chargé');
      return;
    }

    Swal.fire({
      title: 'Laisser un avis',
      html: '' +
        '<div style="text-align:left;">' +
        '<label style="display:block;font-size:0.85rem;font-weight:600;margin-bottom:6px;">Votre nom *</label>' +
        '<input type="text" id="avisNom" class="swal2-input" placeholder="Jean Dupont" style="width:100%;margin:0 0 16px;">' +

        '<label style="display:block;font-size:0.85rem;font-weight:600;margin-bottom:6px;">Votre email (optionnel)</label>' +
        '<input type="email" id="avisEmail" class="swal2-input" placeholder="jean@email.com" style="width:100%;margin:0 0 16px;">' +

        '<label style="display:block;font-size:0.85rem;font-weight:600;margin-bottom:6px;">Vous êtes *</label>' +
        '<select id="avisType" class="swal2-select" style="width:100%;margin:0 0 16px;">' +
        '<option value="client">Client</option>' +
        '<option value="convoyeur">Convoyeur</option>' +
        '<option value="visiteur">Visiteur</option>' +
        '</select>' +

        '<label style="display:block;font-size:0.85rem;font-weight:600;margin-bottom:6px;">Note *</label>' +
        '<div id="avisStars" style="display:flex;gap:6px;margin-bottom:16px;font-size:1.8rem;cursor:pointer;">' +
        '<i class="fas fa-star" data-val="1" style="color:#ddd;"></i>' +
        '<i class="fas fa-star" data-val="2" style="color:#ddd;"></i>' +
        '<i class="fas fa-star" data-val="3" style="color:#ddd;"></i>' +
        '<i class="fas fa-star" data-val="4" style="color:#ddd;"></i>' +
        '<i class="fas fa-star" data-val="5" style="color:#ddd;"></i>' +
        '</div>' +

        '<label style="display:block;font-size:0.85rem;font-weight:600;margin-bottom:6px;">Titre (optionnel)</label>' +
        '<input type="text" id="avisTitre" class="swal2-input" placeholder="Excellent service" style="width:100%;margin:0 0 16px;">' +

        '<label style="display:block;font-size:0.85rem;font-weight:600;margin-bottom:6px;">Votre commentaire *</label>' +
        '<textarea id="avisCommentaire" class="swal2-textarea" placeholder="Décrivez votre expérience..." style="width:100%;margin:0 0 16px;min-height:80px;"></textarea>' +

        '<label style="display:block;font-size:0.85rem;font-weight:600;margin-bottom:6px;">Ville (optionnel)</label>' +
        '<input type="text" id="avisVille" class="swal2-input" placeholder="Paris" style="width:100%;margin:0 0 8px;">' +
        '</div>',
      showCancelButton: true,
      confirmButtonText: 'Publier mon avis',
      confirmButtonColor: '#0A4D68',
      cancelButtonText: 'Annuler',
      preConfirm: function () {
        var nom = document.getElementById('avisNom').value.trim();
        var email = document.getElementById('avisEmail').value.trim();
        var type = document.getElementById('avisType').value;
        var titre = document.getElementById('avisTitre').value.trim();
        var commentaire = document.getElementById('avisCommentaire').value.trim();
        var ville = document.getElementById('avisVille').value.trim();
        var note = parseInt(document.getElementById('avisStars').dataset.selected || '0');

        if (!nom) { Swal.showValidationMessage('Veuillez saisir votre nom'); return false; }
        if (!commentaire) { Swal.showValidationMessage('Veuillez saisir un commentaire'); return false; }
        if (note < 1 || note > 5) { Swal.showValidationMessage('Veuillez attribuer une note'); return false; }

        return { nom: nom, email: email, type: type, titre: titre, commentaire: commentaire, ville: ville, note: note };
      }
    }).then(function (result) {
      if (result.isConfirmed) submitAvis(result.value);
    });

    // Gestion des étoiles
    var starEls = document.querySelectorAll('#avisStars .fa-star');
    var selectedNote = 0;

    starEls.forEach(function (s) {
      s.addEventListener('mouseenter', function () {
        var val = parseInt(s.dataset.val);
        starEls.forEach(function (s2) {
          var v2 = parseInt(s2.dataset.val);
          s2.style.color = v2 <= val ? '#F5A623' : '#ddd';
        });
      });
      s.addEventListener('click', function () {
        selectedNote = parseInt(s.dataset.val);
        document.getElementById('avisStars').dataset.selected = selectedNote;
        starEls.forEach(function (s2) {
          var v2 = parseInt(s2.dataset.val);
          s2.style.color = v2 <= selectedNote ? '#F5A623' : '#ddd';
        });
      });
    });

    document.getElementById('avisStars').addEventListener('mouseleave', function () {
      starEls.forEach(function (s2) {
        var v2 = parseInt(s2.dataset.val);
        s2.style.color = v2 <= selectedNote ? '#F5A623' : '#ddd';
      });
    });
  }

  // ── Soumettre l'avis ──
  async function submitAvis(data) {
    var sb = getSB();
    if (!sb) {
      Swal.fire('Erreur', 'Configuration manquante.', 'error');
      return;
    }

    try {
      // Call the SECURITY DEFINER RPC — user_id is derived server-side
      // from auth.uid(); the caller cannot inject privileged fields.
      var _res = await sb.rpc('submit_public_avis', {
        p_auteur_type: data.type,
        p_auteur_nom: data.nom,
        p_auteur_email: data.email || null,
        p_note: data.note,
        p_titre: data.titre || null,
        p_commentaire: data.commentaire,
        p_ville: data.ville || null
      });
      if (_res.error) throw _res.error;

      Swal.fire({
        title: 'Merci !',
        text: 'Votre avis a été déposé. Il sera visible après validation par notre équipe (généralement sous 24h).',
        icon: 'success',
        confirmButtonColor: '#0A4D68'
      });

      // Recharger les avis
      var container = document.getElementById('avisContainer');
      if (container) loadAvis(container);
    } catch (err) {
      console.error('Erreur submitAvis:', err && err.message ? err.message : JSON.stringify(err));
      Swal.fire('Erreur', 'Une erreur est survenue lors de la publication de votre avis.', 'error');
    }
  }

  // ── Échapper le HTML ──
  function escapeHTML(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Auto-init ──
  document.addEventListener('DOMContentLoaded', function () {
    var container = document.getElementById('avisContainer');
    if (container) loadAvis(container);

    var btn = document.getElementById('btnLaisserAvis');
    if (btn) btn.addEventListener('click', openAvisModal);
  });

  // Exposer publiquement
  window.BathilyAvis = {
    load: loadAvis,
    openModal: openAvisModal,
    submit: submitAvis
  };
})();
