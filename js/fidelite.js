/**
 * Fidélité & Parrainage — Bathily-Convoyage
 */

(function () {
  'use strict';

  function getSB() {
    if (window._sbClient) return window._sbClient;
    if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY || !window.supabase) return null;
    window._sbClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    return window._sbClient;
  }

  // ── Générer un code de parrainage ──
  function generateCode(email) {
    var prefix = (email || 'BC').substring(0, 3).toUpperCase();
    var random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return prefix + '-' + random;
  }

  // ── Charger les infos fidélité ──
  async function loadFidelite(container) {
    var sb = getSB();
    if (!sb) return;

    try {
      var _auth = await sb.auth.getSession();
      if (!_auth.data || !_auth.data.session) {
        container.innerHTML = '<p style="color:var(--gray-mid);font-size:0.85rem;">Connectez-vous pour voir vos points.</p>';
        return;
      }
      var userId = _auth.data.session.user.id;
      var userEmail = _auth.data.session.user.email;

      // Solde de points
      var _solde = await sb.from('solde_fidelite').select('*').eq('user_id', userId).maybeSingle();
      var solde = (_solde.data && _solde.data.solde_points) || 0;
      var nbTransactions = (_solde.data && _solde.data.nb_transactions) || 0;

      // Historique
      var _hist = await sb.from('points_fidelite').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(10);
      var historique = _hist.data || [];

      // Code de parrainage existant
      var _parr = await sb.from('parrainages').select('*').eq('parrain_id', userId).limit(1);
      var codeParrainage = '';
      if (_parr.data && _parr.data.length > 0) {
        codeParrainage = _parr.data[0].code_parrain;
      } else {
        codeParrainage = generateCode(userEmail);
        await sb.from('parrainages').insert({
          parrain_id: userId,
          parrain_email: userEmail,
          filleul_email: '',
          code_parrain: codeParrainage
        });
      }

      // Stats parrainage
      var _parrStats = await sb.from('parrainages').select('*').eq('parrain_id', userId);
      var nbParrainages = _parrStats.data ? _parrStats.data.length : 0;
      var nbCompletes = _parrStats.data ? _parrStats.data.filter(function(p) { return p.statut === 'complete' || p.statut === 'paye'; }).length : 0;

      // Afficher
      var html = '<div class="fidelite-grid">';

      // Carte solde
      html += '<div class="fidelite-card">';
      html += '<div class="fidelite-icon"><i class="fas fa-coins"></i></div>';
      html += '<div class="fidelite-value">' + solde + '</div>';
      html += '<div class="fidelite-label">Points fidélité</div>';
      html += '</div>';

      // Carte parrainages
      html += '<div class="fidelite-card">';
      html += '<div class="fidelite-icon"><i class="fas fa-user-plus"></i></div>';
      html += '<div class="fidelite-value">' + nbCompletes + '/' + nbParrainages + '</div>';
      html += '<div class="fidelite-label">Parrainages validés</div>';
      html += '</div>';

      html += '</div>';

      // Code de parrainage
      html += '<div class="parrainage-section">';
      html += '<h4 style="font-family:Montserrat,sans-serif;font-size:1rem;margin-bottom:12px;color:var(--bordeaux);"><i class="fas fa-gift" style="margin-right:8px;"></i>Programme de parrainage</h4>';
      html += '<p style="font-size:0.85rem;color:var(--gray-mid);margin-bottom:16px;">Partagez votre code avec un ami. Vous recevez chacun <strong>10€ de réduction</strong> dès sa première mission.</p>';
      html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">';
      html += '<input type="text" id="codeParrainage" value="' + codeParrainage + '" readonly style="flex:1;min-width:200px;padding:10px 16px;border:2px dashed var(--bordeaux);border-radius:12px;font-weight:700;color:var(--bordeaux);background:var(--bordeaux-light);text-align:center;font-size:1.1rem;letter-spacing:2px;">';
      html += '<button onclick="BathilyFidelite.copyCode()" style="background:var(--bordeaux);color:white;border:none;padding:10px 20px;border-radius:12px;cursor:pointer;font-weight:600;font-size:0.85rem;"><i class="fas fa-copy"></i> Copier</button>';
      html += '</div>';
      html += '<div style="margin-top:12px;">';
      html += '<a href="mailto:?subject=Rejoins%20Bathily-Convoyage&body=Bonjour,%0A%0AJe%20te%20recommande%20Bathily-Convoyage%20pour%20le%20convoyage%20de%20ton%20véhicule.%0A%0AUtilise%20mon%20code%20' + codeParrainage + '%20pour%20obtenir%2010%E2%82%AC%20de%20r%C3%A9duction%20sur%20ta%20premi%C3%A8re%20mission%20!%0A%0Ahttps://www.bathily-convoyage.fr%0A" style="display:inline-block;margin-top:8px;color:var(--bordeaux);font-size:0.85rem;text-decoration:none;font-weight:600;"><i class="fas fa-envelope" style="margin-right:6px;"></i>Envoyer à un ami</a>';
      html += '</div>';
      html += '</div>';

      // Historique
      if (historique.length > 0) {
        html += '<div class="histo-section">';
        html += '<h4 style="font-family:Montserrat,sans-serif;font-size:1rem;margin-bottom:12px;color:var(--bordeaux);"><i class="fas fa-history" style="margin-right:8px;"></i>Historique des points</h4>';
        html += '<div class="histo-list">';
        historique.forEach(function(h) {
          var dateStr = new Date(h.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
          var sign = h.points > 0 ? '+' : '';
          var color = h.points > 0 ? 'var(--success)' : '#c0392b';
          html += '<div class="histo-item">';
          html += '<span style="font-size:0.85rem;color:var(--gray-dark);">' + escapeHTML(h.motif) + '</span>';
          html += '<span style="font-size:0.75rem;color:var(--gray-mid);">' + dateStr + '</span>';
          html += '<span style="font-weight:700;color:' + color + ';">' + sign + h.points + ' pts</span>';
          html += '</div>';
        });
        html += '</div>';
        html += '</div>';
      }

      container.innerHTML = html;
    } catch (err) {
      console.error('Erreur loadFidelite:', err);
      container.innerHTML = '<p style="color:var(--gray-mid);font-size:0.85rem;">Erreur lors du chargement.</p>';
    }
  }

  // ── Copier le code ──
  function copyCode() {
    var input = document.getElementById('codeParrainage');
    if (!input) return;
    input.select();
    input.setSelectionRange(0, 99999);
    try {
      document.execCommand('copy');
      if (typeof Swal !== 'undefined') {
        Swal.fire({ title: 'Copié !', text: 'Code de parrainage copié dans le presse-papier.', icon: 'success', timer: 1500, showConfirmButton: false });
      }
    } catch (e) {}
  }

  // ── Appliquer un code filleul ──
  async function applyCodeFilleul(code) {
    var sb = getSB();
    if (!sb) return false;

    try {
      var _auth = await sb.auth.getSession();
      if (!_auth.data || !_auth.data.session) return false;

      var { data, error } = await sb.rpc('apply_parrainage_code', { code_input: code });
      if (error) throw error;

      return data === true;
    } catch (err) {
      console.error('Erreur applyCodeFilleul:', err);
      return false;
    }
  }

  function escapeHTML(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  document.addEventListener('DOMContentLoaded', function () {
    var container = document.getElementById('fideliteContainer');
    if (container) loadFidelite(container);
  });

  window.BathilyFidelite = {
    load: loadFidelite,
    copyCode: copyCode,
    applyCodeFilleul: applyCodeFilleul,
    generateCode: generateCode
  };
})();
