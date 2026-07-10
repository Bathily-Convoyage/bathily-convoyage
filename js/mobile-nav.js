/* ============================================================
   Navigation Mobile — Bathily-Convoyage
   Logique: barre nav bas + menu slide-in + overlay
   ============================================================ */

(function () {
  'use strict';

  // ============================================================
  // 1. CREATION DYNAMIQUE DES ELEMENTS DE NAV MOBILE
  // ============================================================
  function el(tag, opts) {
    var node = document.createElement(tag);
    if (opts.className) node.className = opts.className;
    if (opts.id) node.id = opts.id;
    if (opts.href) node.setAttribute('href', opts.href);
    if (opts.dataNav) node.setAttribute('data-nav', opts.dataNav);
    if (opts.dataPage) node.setAttribute('data-page', opts.dataPage);
    if (opts.ariaLabel) node.setAttribute('aria-label', opts.ariaLabel);
    if (opts.icon) {
      var i = document.createElement('i');
      i.className = opts.icon;
      node.appendChild(i);
    }
    if (opts.text) {
      node.appendChild(document.createTextNode(opts.text));
    }
    if (opts.children) {
      opts.children.forEach(function (c) { node.appendChild(c); });
    }
    return node;
  }

  function createMobileNav() {
    // --- Barre nav fixe en bas ---
    var bottomNav = document.createElement('nav');
    bottomNav.className = 'mobile-bottom-nav';
    bottomNav.setAttribute('aria-label', 'Navigation principale mobile');

    var navItems = [
      { href: '/index.html', dataNav: 'home', icon: 'fas fa-home mobile-bottom-nav__icon', label: 'Accueil' },
      { href: '/devis.html', dataNav: 'devis', icon: 'fas fa-calculator mobile-bottom-nav__icon', label: 'Devis' },
      { href: '/dashboard-client.html', dataNav: 'client', icon: 'fas fa-user mobile-bottom-nav__icon', label: 'Espace client' },
      { href: '/dashboard-convoyeur.html', dataNav: 'convoyeur', icon: 'fas fa-truck mobile-bottom-nav__icon', label: 'Convoyeur' },
      { href: 'tel:0758362249', dataNav: 'call', icon: 'fas fa-phone mobile-bottom-nav__icon', label: 'Appeler' }
    ];

    navItems.forEach(function (item) {
      var a = el('a', { href: item.href, dataNav: item.dataNav, className: 'mobile-bottom-nav__item' });
      var icon = document.createElement('i');
      icon.className = item.icon;
      a.appendChild(icon);
      var span = el('span', { className: 'mobile-bottom-nav__label', text: item.label });
      a.appendChild(span);
      bottomNav.appendChild(a);
    });
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

    // Header
    var header = document.createElement('div');
    header.className = 'mobile-menu-header';
    header.appendChild(el('span', { className: 'mobile-menu-header__title', text: 'Menu' }));
    var closeBtn = el('button', { className: 'mobile-menu-close', id: 'mobileMenuClose', ariaLabel: 'Fermer le menu', icon: 'fas fa-times' });
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Links list
    var ul = document.createElement('ul');
    ul.className = 'mobile-menu-links';

    var menuLinks = [
      { href: '/index.html', dataPage: 'index', icon: 'fas fa-home', text: ' Accueil' },
      { href: '/devis.html', dataPage: 'devis', icon: 'fas fa-calculator', text: ' Demander un devis' },
      { href: '/formation-convoyeur.html', dataPage: 'formation', icon: 'fas fa-graduation-cap', text: ' Devenir convoyeur' },
      { href: '/espace-pro.html', dataPage: 'pro', icon: 'fas fa-briefcase', text: ' Espace Pro' },
      { href: '/dashboard-client.html', dataPage: 'client', icon: 'fas fa-user', text: ' Espace client' },
      { href: '/dashboard-convoyeur.html', dataPage: 'convoyeur', icon: 'fas fa-truck', text: ' Espace convoyeur' },
      { divider: true },
      { href: '/contact.html', dataPage: 'contact', icon: 'fas fa-envelope', text: ' Contact' },
      { href: '/mentions-legales.html', dataPage: 'legal', icon: 'fas fa-file-contract', text: ' Mentions legales' }
    ];

    menuLinks.forEach(function (item) {
      var li = document.createElement('li');
      if (item.divider) {
        var div = document.createElement('div');
        div.className = 'mobile-menu-divider';
        li.appendChild(div);
      } else {
        var a = el('a', { href: item.href, dataPage: item.dataPage, icon: item.icon, text: item.text });
        li.appendChild(a);
      }
      ul.appendChild(li);
    });
    panel.appendChild(ul);

    // Footer
    var footer = document.createElement('div');
    footer.className = 'mobile-menu-footer';
    var phoneLink = el('a', { href: 'tel:0758362249', className: 'mobile-menu-footer__phone', icon: 'fas fa-phone', text: ' 07 58 36 22 49' });
    footer.appendChild(phoneLink);
    var ctaLink = el('a', { href: '/devis.html', className: 'mobile-menu-footer__cta', text: 'Obtenir un devis gratuit' });
    footer.appendChild(ctaLink);
    panel.appendChild(footer);

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
