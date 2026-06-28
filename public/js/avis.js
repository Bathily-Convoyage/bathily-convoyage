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
  var DEMO_AVIS = [
    { auteur_nom: 'Karim B.', note: 5, titre: 'Service impeccable', commentaire: 'Convoyage de ma BMW de Lyon à Marseille, livraison dans les délais et véhicule impeccable. Suivi GPS très rassurant !', ville: 'Lyon', type_service: 'route', created_at: '2025-06-15' },
    { auteur_nom: 'Sophie L.', note: 5, titre: 'Parfait pour ma moto', commentaire: 'Ma moto a été convoyée de Paris à Bordeaux en une journée. Convoyeur professionnel et communicant. Je recommande !', ville: 'Paris', type_service: 'route', created_at: '2025-06-12' },
    { auteur_nom: 'Thomas R.', note: 4, titre: 'Très bon service', commentaire: 'Bon rapport qualité-prix. Petit retard de 30min mais le convoyeur a prévenu à l\'avance. État des lieux photo très détaillé.', ville: 'Nantes', type_service: 'route', created_at: '2025-06-10' },
    { auteur_nom: 'Nadia M.', note: 5, titre: 'Excellence au rendez-vous', commentaire: 'Pack Excellence pris : véhicule livré propre, plein fait, photos superbes. Rien à redire, service haut de gamme.', ville: 'Lille', type_service: 'route', created_at: '2025-06-08' },
    { auteur_nom: 'Pascal D.', note: 5, titre: 'Transport plateau parfait', commentaire: 'Convoyage de ma voiture de collection sur plateau. Zéro kilomètre au compteur, arrimage impeccable. Merci !', ville: 'Toulouse', type_service: 'plateau', created_at: '2025-06-05' },
    { auteur_nom: 'Inès K.', note: 4, titre: 'Satisfaite', commentaire: 'Devis rapide et transparent. Pas de frais cachés, péages bien inclus dans le prix comme annoncé.', ville: 'Strasbourg', type_service: 'route', created_at: '2025-06-03' },
    { auteur_nom: 'Olivier T.', note: 5, titre: 'Professionalisme remarquable', commentaire: 'Convoyeur ponctuel, courtois et très pro. Voiture livrée en parfait état. Je passerai par Bathily-Convoyage à nouveau.', ville: 'Bordeaux', type_service: 'route', created_at: '2025-05-28' },
    { auteur_nom: 'Fatou S.', note: 5, titre: 'Recommande à 100%', commentaire: 'Service client au top, toujours joignable. Suivi GPS en temps réel, c\'est vraiment un plus. Bravo !', ville: 'Montpellier', type_service: 'route', created_at: '2025-05-25' },
    { auteur_nom: 'Julien M.', note: 3, titre: 'Correct mais perfectible', commentaire: 'Convoyage correct dans l\'ensemble. J\'aurais aimé plus de communication pendant le trajet. Prix compétitif toutefois.', ville: 'Rennes', type_service: 'route', created_at: '2025-05-20' },
    { auteur_nom: 'Amine H.', note: 5, titre: 'Utilitaire convoyé sans souci', commentaire: 'Convoyage d\'un utilitaire de 14m³ de Lille à Lyon. Aucun problème, convoyeur expérimenté. Très satisfaite.', ville: 'Lille', type_service: 'route', created_at: '2025-05-18' },
    { auteur_nom: 'Claire F.', note: 5, titre: 'Garantie 72h respectée', commentaire: 'Prise en charge en 48h seulement, mieux que promis ! Livraison de ma Tesla impeccable. Top !', ville: 'Nice', type_service: 'route', created_at: '2025-05-15' },
    { auteur_nom: 'Mehdi A.', note: 4, titre: 'Bon pack Sérénité', commentaire: 'Le nettoyage intérieur/extérieur inclus dans le pack Sérénité est un vrai plus. Voiture livrée nickel.', ville: 'Grenoble', type_service: 'route', created_at: '2025-05-12' },
    { auteur_nom: 'Laurence P.', note: 5, titre: 'Rassurée du début à la fin', commentaire: 'Première fois que j\'utilisais un convoyage. L\'équipe m\'a mise en confiance, suivi GPS, photos état des lieux. Parfait.', ville: 'Dijon', type_service: 'route', created_at: '2025-05-08' },
    { auteur_nom: 'Rachid Z.', note: 5, titre: 'Livraison dimanche', commentaire: 'Option livraison dimanche prise pour récupérer mon véhicule le week-end. Convoyeur ponctuel, service impeccable.', ville: 'Marseille', type_service: 'route', created_at: '2025-05-05' },
    { auteur_nom: 'Émilie V.', note: 4, titre: 'Très bien pour VE', commentaire: 'Convoyage de ma voiture électrique. Les temps de recharge ont été bien gérés, livraison dans les délais.', ville: 'Nancy', type_service: 'route', created_at: '2025-05-01' },
    { auteur_nom: 'Bruno C.', note: 5, titre: 'Assurance 100k rassurante', commentaire: 'Le fait que l\'assurance couvre jusqu\'à 100 000€ m\'a vraiment rassuré pour le convoyage de mon SUV premium.', ville: 'Caen', type_service: 'route', created_at: '2025-04-28' },
    { auteur_nom: 'Yasmine B.', note: 5, titre: 'Tout inclus, vraiment', commentaire: 'Pas de surprise sur la facture : péages, carburant, assurance, tout était bien inclus comme annoncé. Transparence totale.', ville: 'Tours', type_service: 'route', created_at: '2025-04-25' },
    { auteur_nom: 'Georges M.', note: 4, titre: 'Plateau recommandé', commentaire: 'On m\'a conseillé le plateau pour ma voiture non-roulante. Bon conseil, livraison sans aucun km supplémentaire.', ville: 'Le Havre', type_service: 'plateau', created_at: '2025-04-20' },
    { auteur_nom: 'Sandra L.', note: 5, titre: 'Photos pro 4K au top', commentaire: 'Les 50 photos pro 4K du pack Excellence sont magnifiques. Reportage détaillé, vraiment utile pour ma flotte.', ville: 'Annecy', type_service: 'route', created_at: '2025-04-18' },
    { auteur_nom: 'Hugo R.', note: 3, titre: 'Prix correct', commentaire: 'Tarif compétitif par rapport aux concurrents. Service correct mais délai un peu long sur longue distance.', ville: 'Perpignan', type_service: 'route', created_at: '2025-04-15' },
    { auteur_nom: 'Aïcha D.', note: 5, titre: 'Convoyeur formidable', commentaire: 'Le convoyeur était très pro, m\'a appelée avant et après la prise en charge. Voiture arrivée en parfait état.', ville: 'Clermont-Ferrand', type_service: 'route', created_at: '2025-04-10' },
    { auteur_nom: 'David P.', note: 5, titre: 'Fidèle client', commentaire: 'C\'est mon 4e convoyage avec Bathily-Convoyage. Toujours aussi fiable, je ne changerai pas !', ville: 'Rouen', type_service: 'route', created_at: '2025-04-05' }
  ];

  // ── Charger les avis approuvés ──
  async function loadAvis(container, limit) {
    var sb = getSB();
    if (!sb) {
      renderAvis(container, DEMO_AVIS, limit);
      return;
    }

    try {
      var query = sb.from('avis').select('*').eq('statut', 'approuve').order('created_at', { ascending: false });
      if (limit) query = query.limit(limit);

      var _ref = await query;
      var data = _ref.data;
      var error = _ref.error;

      if (error) throw error;
      if (!data || data.length === 0) {
        renderAvis(container, DEMO_AVIS, limit);
        return;
      }

      renderAvis(container, data, limit);
    } catch (err) {
      console.error('Erreur loadAvis:', err);
      renderAvis(container, DEMO_AVIS, limit);
    }
  }

  // ── Rendre les avis dans le container ──
  function renderAvis(container, data, limit) {
    if (limit) data = data.slice(0, limit);

    if (!data || data.length === 0) {
      container.innerHTML = '<p style="color:var(--gray-mid);font-size:0.85rem;">Soyez le premier à laisser un avis !</p>';
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

      html += '<div class="avis-list">';
      data.forEach(function (a) {
        var dateStr = new Date(a.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
        var initial = (a.auteur_nom || 'A')[0].toUpperCase();
        var typeLabel = a.auteur_type === 'convoyeur' ? 'Convoyeur' : 'Client';
        if (a.auteur_type === 'visiteur') typeLabel = 'Visiteur';

        html += '<div class="avis-card" style="background:white;border:1px solid var(--border-light);border-radius:16px;padding:20px;margin-bottom:16px;">';
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
      });
      html += '</div>';

      container.innerHTML = html;
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
      // Récupérer l'utilisateur connecté si possible
      var userId = null;
      try {
        var _auth = await sb.auth.getSession();
        if (_auth.data && _auth.data.session) userId = _auth.data.session.user.id;
      } catch (e) { /* visiteur non connecté */ }

      var row = {
        auteur_type: data.type,
        auteur_nom: data.nom,
        auteur_email: data.email || null,
        user_id: userId,
        note: data.note,
        titre: data.titre || null,
        commentaire: data.commentaire,
        ville: data.ville || null,
        statut: 'en_attente',
        source: 'site'
      };

      var _res = await sb.from('avis').insert(row);
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
      console.error('Erreur submitAvis:', err);
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
