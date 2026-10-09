/* Arko local preview bridge */
(() => {
  if (window.parent === window || !['localhost','127.0.0.1'].includes(location.hostname)) return;
  let parentOrigin = '', enabled = false, checking = false;
  const versions = new Map(), drafts = new Set();
  const key = 'arko-preview-position';
  const hmr = [...document.scripts].some(script => script.src.includes('/@vite/client')) || Object.keys(window).some(name => name.startsWith('webpackHotUpdate'));
  function report(type = 'arko-preview-ready') {
    if (parentOrigin) parent.postMessage({type, href:location.href, hmr}, parentOrigin);
  }
  function selector(element) {
    if (element === document.documentElement) return 'html';
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    while (element && element !== document.documentElement) {
      const parent = element.parentElement;
      if (!parent) break;
      parts.unshift(element.tagName.toLowerCase() + ':nth-child(' + ([...parent.children].indexOf(element) + 1) + ')');
      element = parent;
    }
    return parts.join(' > ');
  }
  function safeInput(element) {
    return element.matches('input,textarea,select') && !['password','file','hidden'].includes(element.type);
  }
  document.addEventListener('input', event => {if (safeInput(event.target)) drafts.add(event.target);}, true);
  document.addEventListener('change', event => {if (safeInput(event.target)) drafts.add(event.target);}, true);
  function remember() {
    const state = {href:location.href, x:scrollX, y:scrollY,
      scroll:[...document.querySelectorAll('*')].filter(element => element.scrollTop || element.scrollLeft).map(element => ({selector:selector(element), x:element.scrollLeft, y:element.scrollTop})),
      fields:[...drafts].filter(element => element.isConnected).map(element => ({selector:selector(element), value:element.value, checked:element.checked, name:element.name, inputType:element.type}))};
    try { sessionStorage.setItem(key, JSON.stringify(state)); } catch {}
  }
  let restored;
  try { restored = JSON.parse(sessionStorage.getItem(key) || 'null'); sessionStorage.removeItem(key); } catch {}
  if (restored?.href === location.href) {
    const restore = () => {
      for (const field of restored.fields) {
        const element = document.querySelector(field.selector);
        if (element && safeInput(element) && element.name === field.name && element.type === field.inputType) {element.value = field.value; if (typeof field.checked === 'boolean') element.checked = field.checked; drafts.add(element);}
      }
      for (const saved of restored.scroll) {const element = document.querySelector(saved.selector); if (element) {element.scrollLeft = saved.x; element.scrollTop = saved.y;}}
      scrollTo(restored.x, restored.y);
    };
    const observer = new MutationObserver(restore);
    observer.observe(document.documentElement, {childList:true, subtree:true});
    addEventListener('DOMContentLoaded', restore, {once:true});
    requestAnimationFrame(restore);
    const stop = () => observer.disconnect();
    document.addEventListener('pointerdown', stop, {once:true});
    document.addEventListener('keydown', stop, {once:true});
    setTimeout(stop, 2000);
  }
  function assets() {
    return [...document.querySelectorAll('script[src],link[rel="stylesheet"][href]')].map(element => {
      const url = new URL(element.src || element.href, location.href);
      url.searchParams.delete('_arko_live');
      return {url:url.href, element, css:element.tagName === 'LINK'};
    }).filter(asset => new URL(asset.url).origin === location.origin && !asset.url.includes('arko-preview.js'));
  }
  async function check() {
    if (checking || hmr) return;
    checking = true;
    try {
      const files = [...assets(), {url:location.origin + location.pathname + location.search, html:true}];
      const results = await Promise.all(files.map(async asset => {
        try {
          const response = await fetch(asset.url, {cache:'no-store'});
          if (!response.ok) return null;
          return {...asset, content:await response.text()};
        } catch { return null; }
      }));
      const changed = [];
      for (const result of results.filter(Boolean)) {
        if (versions.has(result.url) && versions.get(result.url) !== result.content) changed.push(result);
        versions.set(result.url, result.content);
      }
      if (!enabled || !changed.length) return;
      if (changed.every(asset => asset.css)) {
        for (const asset of changed) {
          const replacement = asset.element.cloneNode();
          const url = new URL(asset.url); url.searchParams.set('_arko_live', Date.now()); replacement.href = url.href;
          replacement.onload = () => asset.element.remove();
          replacement.onerror = () => replacement.remove();
          asset.element.after(replacement);
        }
      } else {remember(); location.reload();}
    } finally { checking = false; }
  }
  addEventListener('message', event => {
    if (event.source !== parent || !['http:','https:'].includes(new URL(event.origin).protocol) || !['localhost','127.0.0.1'].includes(new URL(event.origin).hostname)) return;
    if (event.data?.type === 'arko-preview-connect') {parentOrigin = event.origin; enabled = Boolean(event.data.live); report(); check();}
    if (event.origin !== parentOrigin) return;
    if (event.data?.type === 'arko-preview-live') {enabled = Boolean(event.data.live); if (enabled) check();}
    if (event.data?.type === 'arko-preview-refresh') {remember(); location.reload();}
    if (event.data?.type === 'arko-preview-update' && enabled) check();
  });
  addEventListener('hashchange', () => report('arko-preview-location'));
  addEventListener('popstate', () => report('arko-preview-location'));
  let previousHref = location.href;
  setInterval(() => {if (previousHref !== location.href) {previousHref = location.href; report('arko-preview-location');} if (enabled) check();}, 1000);
})();
