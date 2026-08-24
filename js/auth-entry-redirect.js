(function redirectAuthEntry() {
  'use strict';

  if (window.location.pathname !== '/' && !window.location.pathname.endsWith('/index.html')) return;

  const hash = window.location.hash || '';
  const search = window.location.search || '';
  const hashType = new URLSearchParams(hash.slice(1)).get('type');
  const queryType = new URLSearchParams(search).get('type');
  const authType = hashType || queryType;

  if (authType !== 'invite' && authType !== 'recovery') return;

  window.location.replace(`/reset-password.html${search}${hash}`);
})();
