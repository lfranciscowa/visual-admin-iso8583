// js/auth.js — Adjunta el token de sesión a todas las llamadas /api/
// y redirige a login si la sesión expira (401). Incluir en cada página
// protegida ANTES de los demás scripts:  <script src="/js/auth.js"></script>
(function () {
  'use strict';

  function getToken() { return localStorage.getItem('token'); }

  function irALogin() {
    ['rol_actual', 'usuario_actual', 'username', 'token', 'modulos'].forEach(k => localStorage.removeItem(k));
    if (!location.pathname.endsWith('/login.html')) location.href = '/login.html';
  }

  // ── Envolver fetch para inyectar el header Authorization ──
  const _fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    const url = (typeof input === 'string') ? input : (input && input.url) || '';
    const esApi = url.indexOf('/api/') !== -1;
    const esLogin = url.indexOf('/api/login') !== -1;

    if (esApi && !esLogin) {
      const token = getToken();
      if (token) {
        const headers = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
        if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
        init.headers = headers;
      }
    }

    return _fetch(input, init).then(function (res) {
      if (res.status === 401 && esApi && !esLogin) {
        irALogin();
      }
      return res;
    });
  };

  // ── Envolver EventSource (SSE) para pasar el token por query ──
  if (window.EventSource) {
    const _ES = window.EventSource;
    window.EventSource = function (url, config) {
      try {
        const token = getToken();
        if (token && url.indexOf('/api/') !== -1 && url.indexOf('token=') === -1) {
          url += (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
        }
      } catch (e) {}
      return new _ES(url, config);
    };
    window.EventSource.prototype = _ES.prototype;
  }
})();
