/**
 * Newsletter — Bathily-Convoyage
 */

(function () {
  'use strict';

  function getSB() {
    if (window._sbClient) return window._sbClient;
    if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY || !window.supabase) return null;
    window._sbClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    return window._sbClient;
  }

  async function subscribe(email, nom) {
    var sb = getSB();
    if (!sb) return { success: false, error: 'Configuration manquante' };

    if (!email || !email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      return { success: false, error: 'Email invalide' };
    }

    try {
      var _res = await sb.from('newsletter_subscribers').upsert({
        email: email,
        nom: nom || null,
        source: 'homepage',
        statut: 'actif'
      }, { onConflict: 'email' });

      if (_res.error) throw _res.error;
      return { success: true };
    } catch (err) {
      console.error('Erreur newsletter:', err);
      return { success: false, error: err.message };
    }
  }

  async function unsubscribe(email) {
    var sb = getSB();
    if (!sb) return { success: false };

    try {
      await sb.from('newsletter_subscribers')
        .update({ statut: 'desinscrit', updated_at: new Date().toISOString() })
        .eq('email', email);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var form = document.getElementById('newsletterForm');
    if (!form) return;

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = form.querySelector('input[name="email"]')?.value?.trim() || '';
      var nom = form.querySelector('input[name="nom"]')?.value?.trim() || '';
      var btn = form.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;

      var res = await subscribe(email, nom);

      if (btn) btn.disabled = false;

      if (res.success) {
        if (typeof Swal !== 'undefined') {
          Swal.fire({
            title: 'Inscription confirmée !',
            text: 'Vous recevrez nos offres et actualités.',
            icon: 'success',
            timer: 2500,
            showConfirmButton: false
          });
        }
        form.reset();
      } else {
        if (typeof Swal !== 'undefined') {
          Swal.fire('Erreur', res.error || 'Inscription échouée.', 'error');
        }
      }
    });
  });

  window.BathilyNewsletter = {
    subscribe: subscribe,
    unsubscribe: unsubscribe
  };
})();
