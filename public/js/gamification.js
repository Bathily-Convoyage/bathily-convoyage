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
      html += '<div class="gamif-level-name">' + levelInfo.current.name + '</div>';
      html += '<div class="gamif-level-points">' + points + ' points</div>';
      if (levelInfo.next) {
        var progress = Math.min(100, Math.round((points - levelInfo.current.min) / (levelInfo.next.min - levelInfo.current.min) * 100));
        html += '<div class="gamif-progress-bar"><div class="gamif-progress-fill" style="width:' + progress + '%;"></div></div>';
        html += '<div class="gamif-progress-text">' + (levelInfo.next.min - points) + ' pts jusqu\'à ' + levelInfo.next.name + '</div>';
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
        html += '<div class="' + cls + '" title="' + b.description + '">';
        html += '<div class="gamif-badge-icon" style="color:' + b.couleur + ';opacity:' + opacity + ';"><i class="fas ' + b.icon + '"></i></div>';
        html += '<div class="gamif-badge-name">' + b.nom + '</div>';
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
  async function subscribePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      if (typeof Swal !== 'undefined') {
        Swal.fire('Non supporté', 'Les notifications push ne sont pas supportées par votre navigateur.', 'warning');
      }
      return;
    }

    try {
      var permission = await Notification.requestPermission();
      if (permission !== 'granted') return;

      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(window.VAPID_PUBLIC_KEY || '')
      });

      var sb = getSB();
      if (!sb) return;

      var _auth = await sb.auth.getSession();
      if (!_auth.data || !_auth.data.session) return;

      await sb.from('push_subscriptions').upsert({
        user_id: _auth.data.session.user.id,
        endpoint: sub.endpoint,
        p256dh: arrayBufferToBase64(sub.getKey('p256dh')),
        auth_key: arrayBufferToBase64(sub.getKey('auth')),
        user_agent: navigator.userAgent
      });

      if (typeof Swal !== 'undefined') {
        Swal.fire({ title: 'Activé !', text: 'Vous recevrez les notifications push.', icon: 'success', timer: 2000, showConfirmButton: false });
      }
    } catch (err) {
      console.error('Erreur subscribePush:', err);
    }
  }

  async function unsubscribePush() {
    try {
      var reg = await navigator.serviceWorker.ready;
      var sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();

      var sb = getSB();
      if (sb) {
        var _auth = await sb.auth.getSession();
        if (_auth.data && _auth.data.session) {
          await sb.from('push_subscriptions').delete().eq('user_id', _auth.data.session.user.id);
        }
      }
    } catch (err) {
      console.error('Erreur unsubscribePush:', err);
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

  document.addEventListener('DOMContentLoaded', function () {
    var container = document.getElementById('gamificationContainer');
    if (container) loadGamification(container);

    var btnSub = document.getElementById('btnEnablePush');
    if (btnSub) btnSub.addEventListener('click', subscribePush);

    var btnUnsub = document.getElementById('btnDisablePush');
    if (btnUnsub) btnUnsub.addEventListener('click', unsubscribePush);
  });

  window.BathilyGamification = {
    load: loadGamification,
    subscribePush: subscribePush,
    unsubscribePush: unsubscribePush,
    getLevel: getLevel,
    LEVELS: LEVELS
  };
})();
