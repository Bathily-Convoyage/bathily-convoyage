/**
 * Bathily Convoyage — Sélecteur de langue
 * Utilise Google Translate en arrière-plan, sélecteur custom intégré à la navbar
 */
(function () {
  const LANGS = [
    { code: 'fr', label: 'FR', flag: '🇫🇷', name: 'Français' },
    { code: 'en', label: 'EN', flag: '🇬🇧', name: 'English' },
    { code: 'es', label: 'ES', flag: '🇪🇸', name: 'Español' },
    { code: 'de', label: 'DE', flag: '🇩🇪', name: 'Deutsch' },
    { code: 'it', label: 'IT', flag: '🇮🇹', name: 'Italiano' },
    { code: 'pt', label: 'PT', flag: '🇵🇹', name: 'Português' },
    { code: 'nl', label: 'NL', flag: '🇳🇱', name: 'Nederlands' },
    { code: 'pl', label: 'PL', flag: '🇵🇱', name: 'Polski' }
  ];

  function getCurrentLang() {
    const cookie = document.cookie.match(/googtrans=\/fr\/([a-z]+)/);
    if (cookie) return cookie[1];
    return 'fr';
  }

  function setLang(code) {
    if (code === 'fr') {
      document.cookie = 'googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
      document.cookie = 'googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=' + location.hostname;
    } else {
      document.cookie = 'googtrans=/fr/' + code + '; path=/';
      document.cookie = 'googtrans=/fr/' + code + '; path=/; domain=' + location.hostname;
    }
    location.reload();
  }

  function injectGoogleTranslate() {
    if (document.getElementById('google_translate_element')) return;
    const div = document.createElement('div');
    div.id = 'google_translate_element';
    div.style.display = 'none';
    document.body.appendChild(div);

    window.googleTranslateElementInit = function () {
      new google.translate.TranslateElement({
        pageLanguage: 'fr',
        includedLanguages: 'fr,en,es,de,it,pt,nl,pl',
        layout: google.translate.TranslateElement.InlineLayout.SIMPLE,
        autoDisplay: false
      }, 'google_translate_element');
    };

    const script = document.createElement('script');
    script.src = '//translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
    script.async = true;
    document.head.appendChild(script);
  }

  function buildSwitcher() {
    const current = getCurrentLang();
    const currentLang = LANGS.find(l => l.code === current) || LANGS[0];

    const style = document.createElement('style');
    style.textContent = `
      .lang-switcher { position: relative; display: inline-flex; align-items: center; margin-left: 16px; z-index: 99999; }
      .lang-btn { display: flex; align-items: center; gap: 5px; background: #0a4d68; border: 1px solid #0a4d68; color: #fff; padding: 6px 12px; border-radius: 20px; cursor: pointer; font-size: 13px; font-weight: 600; font-family: inherit; transition: all 0.2s; white-space: nowrap; box-shadow: 0 2px 8px rgba(10,77,104,0.25); }
      .lang-btn:hover { background: #073d54; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(10,77,104,0.35); }
      .lang-dropdown { display: none; position: absolute; top: calc(100% + 8px); right: 0; background: #fff; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.2); overflow: hidden; z-index: 99999; min-width: 160px; border: 1px solid #e8e1d9; }
      .lang-dropdown.open { display: block; }
      .lang-option { display: flex; align-items: center; gap: 10px; padding: 10px 16px; cursor: pointer; font-size: 14px; color: #2d2a24; font-family: inherit; transition: background 0.15s; border: none; background: none; width: 100%; text-align: left; }
      .lang-option:hover { background: #f5f0ea; }
      .lang-option.active { background: #e6f0f4; color: #0a4d68; font-weight: 700; }
      .lang-option .flag { font-size: 18px; }
      .goog-te-banner-frame, .goog-te-balloon-frame { display: none !important; }
      body { top: 0 !important; }
      .skiptranslate { display: none !important; }
    `;
    document.head.appendChild(style);

    const wrapper = document.createElement('div');
    wrapper.className = 'lang-switcher';

    const btn = document.createElement('button');
    btn.className = 'lang-btn';
    btn.setAttribute('aria-label', 'Changer de langue');
    btn.innerHTML = `<span class="flag">${currentLang.flag}</span> ${currentLang.label} <svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

    const dropdown = document.createElement('div');
    dropdown.className = 'lang-dropdown';
    LANGS.forEach(lang => {
      const opt = document.createElement('button');
      opt.className = 'lang-option' + (lang.code === current ? ' active' : '');
      opt.innerHTML = `<span class="flag">${lang.flag}</span> ${lang.name}`;
      opt.addEventListener('click', () => setLang(lang.code));
      dropdown.appendChild(opt);
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
    });
    document.addEventListener('click', () => dropdown.classList.remove('open'));

    wrapper.appendChild(btn);
    wrapper.appendChild(dropdown);
    return wrapper;
  }

  function inject() {
    const navLinks = document.querySelector('.nav-links');
    if (!navLinks) return;
    const switcher = buildSwitcher();
    navLinks.appendChild(switcher);
    injectGoogleTranslate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
