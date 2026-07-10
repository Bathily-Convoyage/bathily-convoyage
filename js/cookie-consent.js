(function () {
  if (localStorage.getItem('bathily_cookie_consent') === 'accepted') return;

  var banner = document.createElement('div');
  banner.id = 'cookie-banner';
  banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#063244;color:#fff;padding:16px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;box-shadow:0 -4px 20px rgba(0,0,0,0.15);font-family:Inter,sans-serif;font-size:0.85rem;';

  var text = document.createElement('span');
  text.style.flex = '1 1 300px';
  text.innerHTML = 'Nous utilisons des cookies pour améliorer votre expérience et analyser le trafic. En continuant, vous acceptez notre <a href="mentions-legales.html" style="color:#F5A623;text-decoration:underline;">politique de confidentialité</a>.';

  var btnAccept = document.createElement('button');
  btnAccept.textContent = 'Accepter';
  btnAccept.style.cssText = 'background:#F5A623;color:#063244;border:none;padding:8px 24px;border-radius:30px;font-weight:700;cursor:pointer;font-size:0.85rem;white-space:nowrap;';

  var btnRefuse = document.createElement('button');
  btnRefuse.textContent = 'Refuser';
  btnRefuse.style.cssText = 'background:transparent;color:#fff;border:1px solid rgba(255,255,255,0.3);padding:8px 20px;border-radius:30px;font-weight:600;cursor:pointer;font-size:0.85rem;white-space:nowrap;';

  btnAccept.addEventListener('click', function () {
    localStorage.setItem('bathily_cookie_consent', 'accepted');
    banner.remove();
  });

  btnRefuse.addEventListener('click', function () {
    localStorage.setItem('bathily_cookie_consent', 'refused');
    banner.remove();
  });

  banner.appendChild(text);
  banner.appendChild(btnRefuse);
  banner.appendChild(btnAccept);
  document.body.appendChild(banner);
})();
