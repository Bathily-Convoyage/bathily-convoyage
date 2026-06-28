/* ============================================================
   Navigation Mobile — Bathily-Convoyage
   Logique: barre nav bas + menu slide-in + overlay
   ============================================================ */

(function () {
  'use strict';

  // ============================================================
  // 1. CREATION DYNAMIQUE DES ELEMENTS DE NAV MOBILE
  // ============================================================
  function createMobileNav() {
    // --- Barre nav fixe en bas ---
    var bottomNav = document.createElement('nav');
    bottomNav.className = 'mobile-bottom-nav';
    bottomNav.setAttribute('aria-label', 'Navigation principale mobile');
    bottomNav.innerHTML = '\
      <a href="/index.html" class="mobile-bottom-nav__item" data-nav="home">\
        <i class="fas fa-home mobile-bottom-nav__icon"></i>\
        <span class="mobile-bottom-nav__label">Accueil</span>\
      </a>\
      <a href="/devis.html" class="mobile-bottom-nav__item" data-nav="devis">\
        <i class="fas fa-calculator mobile-bottom-nav__icon"></i>\
        <span class="mobile-bottom-nav__label">Devis</span>\
      </a>\
      <a href="/dashboard-client.html" class="mobile-bottom-nav__item" data-nav="client">\
        <i class="fas fa-user mobile-bottom-nav__icon"></i>\
        <span class="mobile-bottom-nav__label">Espace client</span>\
      </a>\
      <a href="/dashboard-convoyeur.html" class="mobile-bottom-nav__item" data-nav="convoyeur">\
        <i class="fas fa-truck mobile-bottom-nav__icon"></i>\
        <span class="mobile-bottom-nav__label">Convoyeur</span>\
      </a>\
      <a href="tel:0758362249" class="mobile-bottom-nav__item" data-nav="call">\
        <i class="fas fa-phone mobile-bottom-nav__icon"></i>\
        <span class="mobile-bottom-nav__label">Appeler</span>\
      </a>';
    document.body.appendChild(bottomNav);

    // --- Overlay ---
    var overlay = document.createElement('div');
    overlay.className = 'mobile-menu-overlay';
    overlay.id = 'mobileMenuOverlay';
    document.body.appendChild(overlay);

    // --- Panneau slide-in ---
    var panel = document.createElement('aside');
    panel.className = 'mobile-menu-panel';
    panel.id = 'mobileMenuPanel';
    panel.setAttribute('aria-label', 'Menu secondaire');
    panel.innerHTML = '\
      <div class="mobile-menu-header">\
        <span class="mobile-menu-header__title">Menu</span>\
        <button class="mobile-menu-close" id="mobileMenuClose" aria-label="Fermer le menu">\
          <i class="fas fa-times"></i>\
        </button>\
      </div>\
      <ul class="mobile-menu-links">\
        <li><a href="/index.html" data-page="index"><i class="fas fa-home"></i> Accueil</a></li>\
        <li><a href="/devis.html" data-page="devis"><i class="fas fa-calculator"></i> Demander un devis</a></li>\
        <li><a href="/formation-convoyeur.html" data-page="formation"><i class="fas fa-graduation-cap"></i> Devenir convoyeur</a></li>\
        <li><a href="/espace-pro.html" data-page="pro"><i class="fas fa-briefcase"></i> Espace Pro</a></li>\
        <li><a href="/dashboard-client.html" data-page="client"><i class="fas fa-user"></i> Espace client</a></li>\
        <li><a href="/dashboard-convoyeur.html" data-page="convoyeur"><i class="fas fa-truck"></i> Espace convoyeur</a></li>\
        <li><div class="mobile-menu-divider"></div></li>\
        <li><a href="/contact.html" data-page="contact"><i class="fas fa-envelope"></i> Contact</a></li>\
        <li><a href="/mentions-legales.html" data-page="legal"><i class="fas fa-file-contract"></i> Mentions legales</a></li>\
      </ul>\
      <div class="mobile-menu-footer">\
        <a href="tel:0758362249" class="mobile-menu-footer__phone">\
          <i class="fas fa-phone"></i> 07 58 36 22 49\
        </a>\
        <a href="/devis.html" class="mobile-menu-footer__cta">Obtenir un devis gratuit</a>\
      </div>';
    document.body.appendChild(panel);
  }

  // ============================================================
  // 2. LOGIQUE D'OUVERTURE / FERMETURE
  // ============================================================
  function openMenu() {
    var overlay = document.getElementById('mobileMenuOverlay');
    var panel = document.getElementById('mobileMenuPanel');
    var toggle = document.querySelector('.menu-toggle');
    if (!overlay || !panel) return;

    overlay.classList.add('active');
    panel.classList.add('active');
    if (toggle) toggle.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeMenu() {
    var overlay = document.getElementById('mobileMenuOverlay');
    var panel = document.getElementById('mobileMenuPanel');
    var toggle = document.querySelector('.menu-toggle');
    if (!overlay || !panel) return;

    overlay.classList.remove('active');
    panel.classList.remove('active');
    if (toggle) toggle.classList.remove('open');
    document.body.style.overflow = '';
  }

  function toggleMenu() {
    var panel = document.getElementById('mobileMenuPanel');
    if (panel && panel.classList.contains('active')) {
      closeMenu();
    } else {
      openMenu();
    }
  }

  // ============================================================
  // 3. MARQUER LA PAGE ACTIVE
  // ============================================================
  function markActivePage() {
    var path = window.location.pathname;
    var page = path.split('/').pop() || 'index.html';

    // Barre du bas
    var navItems = document.querySelectorAll('.mobile-bottom-nav__item');
    navItems.forEach(function (item) {
      var href = item.getAttribute('href');
      if (href && href.indexOf(page) !== -1 && page !== 'index.html') {
        item.classList.add('active');
      } else if (page === 'index.html' && href && href.indexOf('index.html') !== -1) {
        item.classList.add('active');
      }
    });

    // Menu slide-in
    var menuLinks = document.querySelectorAll('.mobile-menu-links a[data-page]');
    menuLinks.forEach(function (link) {
      var dataPage = link.getAttribute('data-page');
      var matches = {
        'index': 'index.html',
        'devis': 'devis.html',
        'formation': 'formation-convoyeur.html',
        'pro': 'espace-pro.html',
        'client': 'dashboard-client.html',
        'convoyeur': 'dashboard-convoyeur.html',
        'contact': 'contact.html',
        'legal': 'mentions-legales.html'
      };
      if (matches[dataPage] === page) {
        link.classList.add('active');
      }
    });
  }

  // ============================================================
  // 4. INITIALISATION
  // ============================================================
  function init() {
    // Creer les elements s'ils n'existent pas deja
    if (!document.querySelector('.mobile-bottom-nav')) {
      createMobileNav();
    }

    // Marquer la page active
    markActivePage();

    // Bouton hamburger existant dans le header
    var toggle = document.querySelector('.menu-toggle');
    if (toggle) {
      toggle.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggleMenu();
      });
    }

    // Bouton de fermeture dans le panneau
    var closeBtn = document.getElementById('mobileMenuClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', function (e) {
        e.preventDefault();
        closeMenu();
      });
    }

    // Fermeture par clic sur l'overlay
    var overlay = document.getElementById('mobileMenuOverlay');
    if (overlay) {
      overlay.addEventListener('click', closeMenu);
    }

    // Fermeture par la touche Escape
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });

    // Fermeture apres clic sur un lien du menu
    var menuLinks = document.querySelectorAll('.mobile-menu-links a');
    menuLinks.forEach(function (link) {
      link.addEventListener('click', function () {
        closeMenu();
      });
    });

    // Fermeture de l'ancien menu .nav-links.show si present
    var oldNavLinks = document.querySelector('.nav-links');
    if (oldNavLinks) {
      var oldLinks = oldNavLinks.querySelectorAll('a');
      oldLinks.forEach(function (link) {
        link.addEventListener('click', function () {
          oldNavLinks.classList.remove('show');
        });
      });
    }
  }

  // Lancer quand le DOM est pret
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
