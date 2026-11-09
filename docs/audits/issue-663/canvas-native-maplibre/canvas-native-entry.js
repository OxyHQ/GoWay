// Private verification entry: real GoWay routes and renderer; no business writes.
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.__canvasLabBlockedWrites = [];
globalThis.fetch = (input, init) => {
  const method = String(init?.method ?? (typeof input === 'object' ? input.method : 'GET') ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (!['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname)) {
      const record = `${method} ${url.origin}${url.pathname}`;
      globalThis.__canvasLabBlockedWrites.push(record);
      console.warn('[CanvasLab blocked write]', record);
      return Promise.reject(new Error('Canvas lab blocks external writes'));
    }
  }
  return originalFetch(input, init);
};
// Axios and other native clients may use XHR instead of fetch.
if (globalThis.XMLHttpRequest) {
  const requests = new WeakMap();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    requests.set(this, { method: String(method).toUpperCase(), url: String(url) });
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    const request = requests.get(this);
    if (request && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const url = new URL(request.url);
      if (!['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname)) {
        const record = `${request.method} ${url.origin}${url.pathname}`;
        globalThis.__canvasLabBlockedWrites.push(record);
        console.warn('[CanvasLab blocked XHR write]', record);
        throw new Error('Canvas lab blocks external XHR writes');
      }
    }
    return originalSend.apply(this, args);
  };
}
require('expo-router/entry');
