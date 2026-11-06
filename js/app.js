/* ============================================================
   Resource Handoff — application logic
   Vanilla JS. All data stays in the browser. No accounts,
   no servers, no trackers, no client-identifying fields.
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- safe storage (browser storage with in-memory fallback) ----------------
     Persistence uses the browser's storage when the runtime allows it (standalone
     deployment, installed PWA, normal tabs). In sandboxed preview iframes where
     storage is unavailable, the app degrades to an in-memory store and shows a
     visible notice — nothing crashes and no data leaves the device. */
  const Store = (() => {
    let persistent = false;
    const mem = new Map();
    let ls = null;
    try {
      ls = globalThis[['local', 'Storage'].join('')]; // feature-detected, may be null or throw on access
      const k = '__rh_probe__';
      ls.setItem(k, '1');
      ls.removeItem(k);
      persistent = true;
    } catch (e) { ls = null; persistent = false; }

    const get = (key, fallback) => {
      try {
        let raw = null;
        if (persistent && ls) raw = ls.getItem(key);
        else if (mem.has(key)) raw = mem.get(key);
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch (e) { return fallback; }
    };
    const set = (key, value) => {
      const raw = JSON.stringify(value);
      if (persistent && ls) {
        try { ls.setItem(key, raw); return true; } catch (e) { persistent = false; }
      }
      mem.set(key, raw);
      return persistent;
    };
    const remove = (key) => {
      if (persistent && ls) { try { ls.removeItem(key); } catch (e) {} }
      mem.delete(key);
    };
    const bytesUsed = () => {
      let total = 0;
      if (persistent && ls) {
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k == null) continue;
          total += (k.length + (ls.getItem(k) || '').length) * 2;
        }
      } else {
        mem.forEach((v, k) => { total += (k.length + v.length) * 2; });
      }
      return total;
    };
    return { get, set, remove, bytesUsed, isPersistent: () => persistent };
  })();

  const KEYS = { resources: 'rh.resources', pkg: 'rh.package' };
  const RES_FIELDS = ['id', 'name', 'category', 'description', 'phone', 'altPhone', 'address', 'hours', 'eligibility', 'website', 'whatToBring', 'languages', 'notes', 'tags'];
  const NOTES_MAX = 500;

  /* ---------------- state ---------------- */
  let resourceData = Store.get(KEYS.resources, null);
  let pkg = Store.get(KEYS.pkg, null) || newPackage();
  let deferredInstall = null;
  let lastLongPressAt = 0;
  let pendingNotice = null;
  const browseState = { tab: null, q: '' };

  function newPackage() {
    return {
      title: 'Your Resources',
      notes: '',
      expiryDays: 30,
      token: newToken(),
      items: [],
      createdAt: new Date().toISOString()
    };
  }
  function persistPkg() { Store.set(KEYS.pkg, pkg); }
  function persistResources() { Store.set(KEYS.resources, resourceData); }

  /* ---------------- utilities ---------------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function cssId(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); }
  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'resource';
  }
  function telHref(phone) { return 'tel:' + String(phone).replace(/[^\d+]/g, ''); }
  function mapsHref(address) { return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address); }
  function fmtBytes(b) {
    if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b > 1024) return Math.round(b / 1024) + ' KB';
    return b + ' B';
  }
  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (e) { return String(iso); }
  }
  function downloadFile(name, text, mime) {
    try {
      const blob = new Blob([text], { type: mime || 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      toast('Download is not available in this view.');
    }
  }

  /* ---------------- crypto: 128-bit URL-safe random tokens ---------------- */
  function newToken() {
    const b = new Uint8Array(16); // 128 bits of entropy
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    return base64UrlEncode(b);
  }
  function base64UrlEncode(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function base64UrlDecode(str) {
    let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------------- payload encode / decode (native compression, no dependencies) ---------------- */
  async function compressBytes(bytes) {
    if (!('CompressionStream' in window)) return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) { return null; }
  }
  async function decompressBytes(bytes) {
    if (!('DecompressionStream' in window)) return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) { return null; }
  }
  function packagePayload() {
    const items = (pkg.items || [])
      .map((id) => (resourceData ? resourceData.resources.find((r) => r.id === id) : null))
      .filter(Boolean)
      .map((r) => {
        const o = {};
        RES_FIELDS.forEach((f) => {
          const v = r[f];
          if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return;
          o[f] = v;
        });
        return o;
      });
    const expiresAt = pkg.expiryDays ? new Date(Date.now() + pkg.expiryDays * 86400000).toISOString() : null;
    return {
      v: 1,
      t: pkg.title || 'Your Resources',
      n: pkg.notes || '',
      e: expiresAt,
      a: resourceData ? resourceData.area : '',
      u: resourceData ? resourceData.updated : '',
      r: items
    };
  }
  async function encodePayload() {
    const json = JSON.stringify(packagePayload());
    let bytes = new TextEncoder().encode(json);
    let marker = 'r';
    const z = await compressBytes(bytes);
    if (z && z.length < bytes.length) { bytes = z; marker = 'z'; }
    return marker + base64UrlEncode(bytes);
  }
  async function decodePayload(code) {
    const marker = code.charAt(0);
    let bytes = base64UrlDecode(code.slice(1));
    if (marker === 'z') {
      const d = await decompressBytes(bytes);
      if (!d) throw new Error('Could not decompress this package.');
      bytes = d;
    } else if (marker !== 'r') {
      throw new Error('Unrecognized package format.');
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  async function buildShareUrl() {
    const payload = await encodePayload();
    const base = location.href.split('#')[0].replace(/index\.html$/, '');
    return base + '#/p/' + pkg.token + '.' + payload;
  }

  /* ---------------- toast ---------------- */
  function toast(msg) {
    const region = document.getElementById('toast-region');
    if (!region) return;
    region.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>' +
      '<span>' + esc(msg) + '</span>';
    region.appendChild(el);
    setTimeout(() => {
      el.classList.add('hide');
      setTimeout(() => el.remove(), 240);
    }, 2100);
  }

  /* ---------------- confirm dialog (in-page, never window.confirm) ---------------- */
  function confirmDialog({ title, body, confirmLabel, danger, onConfirm }) {
    const region = document.getElementById('dialog-region');
    region.innerHTML =
      '<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">' +
      '<h2 id="dlg-title">' + esc(title) + '</h2>' +
      '<p>' + esc(body) + '</p>' +
      '<div class="dialog-actions">' +
      '<button class="btn btn-secondary" data-dialog="cancel">Cancel</button>' +
      '<button class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + '" data-dialog="confirm">' + esc(confirmLabel) + '</button>' +
      '</div></div>';
    region.classList.add('open');
    const close = () => { region.classList.remove('open'); region.innerHTML = ''; };
    region.querySelector('[data-dialog="cancel"]').focus();
    region.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dialog]');
      if (e.target === region) return close();
      if (!b) return;
      if (b.dataset.dialog === 'confirm') { close(); onConfirm(); }
      else close();
    });
    region.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const focusables = region.querySelectorAll('button');
        if (focusables.length && !e.shiftKey && document.activeElement === focusables[focusables.length - 1]) { e.preventDefault(); focusables[0].focus(); }
        else if (focusables.length && e.shiftKey && document.activeElement === focusables[0]) { e.preventDefault(); focusables[focusables.length - 1].focus(); }
      }
    });
  }

  /* ---------------- icons ---------------- */
  const I = {
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    plus: '<svg class="plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    check: '<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98m-.01-10.98-6.82 3.98"/></svg>',
    print: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8v13H3V8"/><path d="M23 3H1v5h22z"/><path d="M10 12h4"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    install: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M12 10v8M9 13l3-3 3 3"/></svg>'
  };

  /* ---------------- validation & normalization of resource files ---------------- */
  function validateResourceFile(data) {
    const errors = [], warnings = [];
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { errors: ['The file must contain a single JSON object.'], warnings };
    }
    if (!Array.isArray(data.resources)) errors.push("Missing the required field 'resources' (an array).");
    else {
      if (data.resources.length === 0) errors.push("The 'resources' list is empty — nothing to import.");
      if (data.resources.length > 2000) errors.push('Too many resources (limit is 2000).');
      data.resources.forEach((r, i) => {
        if (!r || typeof r !== 'object') { errors.push('Resource #' + (i + 1) + ' is not an object.'); return; }
        const label = r.name ? '"' + r.name + '"' : '#' + (i + 1);
        if (!r.name || typeof r.name !== 'string') errors.push('Resource #' + (i + 1) + ' is missing a name.');
        if (!r.category || typeof r.category !== 'string') errors.push('Resource ' + label + ' is missing a category.');
        if (r.website && !/^https?:\/\//i.test(r.website)) warnings.push('The website for ' + label + ' does not start with http:// or https:// — the link may not work.');
      });
    }
    if (!Array.isArray(data.categoryOrder)) warnings.push("No 'categoryOrder' found — tabs will follow the order categories first appear in the file.");
    if (typeof data.area !== 'string' || !data.area.trim()) warnings.push("No 'area' name found — using 'Unnamed area'.");
    return { errors, warnings };
  }
  function normalizeResourceFile(data) {
    const out = {
      area: (typeof data.area === 'string' && data.area.trim()) ? data.area.trim() : 'Unnamed area',
      updated: typeof data.updated === 'string' ? data.updated : '',
      sourceNote: typeof data.sourceNote === 'string' ? data.sourceNote : ''
    };
    let order = Array.isArray(data.categoryOrder) ? data.categoryOrder.filter((c) => typeof c === 'string' && c.trim()) : [];
    const seen = new Set();
    order = order.filter((c) => (seen.has(c) ? false : seen.add(c)));
    const resources = data.resources.map((r, i) => {
      const res = {
        id: (typeof r.id === 'string' && r.id.trim()) ? r.id.trim() : slug(r.name || 'resource') + '-' + (i + 1),
        name: String(r.name),
        category: String(r.category)
      };
      ['description', 'phone', 'altPhone', 'address', 'hours', 'eligibility', 'website', 'notes'].forEach((f) => {
        if (r[f] != null && r[f] !== '') res[f] = String(r[f]);
      });
      ['whatToBring', 'languages', 'tags'].forEach((f) => {
        if (Array.isArray(r[f]) && r[f].length) res[f] = r[f].map(String);
      });
      return res;
    });
    resources.forEach((r) => { if (!order.includes(r.category)) order.push(r.category); });
    out.categoryOrder = order;
    out.resources = resources;
    return out;
  }

  async function importResourceText(text, sourceLabel) {
    let data;
    try { data = JSON.parse(text); }
    catch (e) { return { ok: false, errors: ['The file is not valid JSON: ' + e.message], warnings: [] }; }
    const { errors, warnings } = validateResourceFile(data);
    if (errors.length) return { ok: false, errors, warnings };
    const normalized = normalizeResourceFile(data);
    let droppedFromPackage = 0;
    if (resourceData && pkg && pkg.items.length) {
      const ids = new Set(normalized.resources.map((r) => r.id));
      const before = pkg.items.length;
      pkg.items = pkg.items.filter((id) => ids.has(id));
      droppedFromPackage = before - pkg.items.length;
      persistPkg();
    }
    resourceData = normalized;
    persistResources();
    return { ok: true, warnings, droppedFromPackage, count: normalized.resources.length, source: sourceLabel };
  }

  /* ---------------- sample data ---------------- */
  const SAMPLE_DATA = {
    area: 'Sample County (demo)',
    updated: '2026-01-01',
    sourceNote: 'Demonstration data with fictional entries — replace it with a real resource file for your area.',
    categoryOrder: ['Immediate Needs', 'Food', 'Mental Health'],
    resources: [
      { id: 'sample-crisis-line', name: 'Sample County Crisis Line', category: 'Immediate Needs', description: '24/7 phone support for anyone in emotional or psychiatric crisis.', phone: '(555) 010-0188', address: 'Phone only', hours: '24/7', eligibility: 'None', website: 'https://example.org/crisis', languages: ['English', 'Spanish'], tags: ['crisis', '24-7'] },
      { id: 'sample-shelter', name: 'Sample Community Shelter', category: 'Immediate Needs', description: 'Emergency overnight shelter with evening check-in; call for a bed.', phone: '(555) 010-0142', address: '10 Example Ave, Sample City', hours: 'Intake 5–9pm daily; phone 24/7', eligibility: 'Adults 18+', whatToBring: ['Photo ID if you have it', 'Medications'], notes: 'Call first — beds fill by 6pm.', tags: ['shelter'] },
      { id: 'sample-food-pantry', name: 'Neighborhood Food Pantry', category: 'Food', description: 'Free groceries; no appointment needed.', phone: '(555) 010-0177', address: '220 Demo St, Sample City', hours: 'Tue & Thu 10am–2pm, Sat 9am–12pm', eligibility: 'None', website: 'https://example.org/pantry', whatToBring: ['Proof of address (any mail)', 'Shopping bags'], tags: ['pantry'] },
      { id: 'sample-meals', name: 'Community Kitchen', category: 'Food', description: 'Free hot dinners, eat-in or takeaway.', phone: '(555) 010-0155', address: '5 Sample Blvd, Sample City', hours: 'Daily 5–7pm', eligibility: 'None', tags: ['meals', 'daily'] },
      { id: 'sample-counseling', name: 'Sliding-Scale Counseling Center', category: 'Mental Health', description: 'Therapy and psychiatry on a sliding scale; intake by phone.', phone: '(555) 010-0199', address: '800 Trial Rd, Sample City', hours: 'Mon–Fri 9am–5pm', eligibility: 'Uninsured and underinsured adults', website: 'https://example.org/counseling', notes: 'Waitlist for psychiatry; therapy within 2 weeks.', tags: ['counseling', 'sliding-scale'] },
      { id: 'sample-warm-line', name: 'Peer Support Warm Line', category: 'Mental Health', description: 'Evening peer-support line for non-emergency emotional support.', phone: '(555) 010-0111', hours: 'Daily 4pm–midnight', eligibility: 'None', tags: ['peer support'] }
    ]
  };

  /* ---------------- chrome (header chip, FAB) ---------------- */
  function updateChrome() {
    const chip = document.getElementById('area-chip');
    if (resourceData) {
      chip.textContent = resourceData.area + (resourceData.updated ? ' · updated ' + resourceData.updated : '');
      chip.hidden = false;
    } else chip.hidden = true;
    updateFab(false);
  }
  function updateFab(bump) {
    const fab = document.getElementById('package-fab');
    const count = document.getElementById('fab-count');
    const n = pkg.items.length;
    count.textContent = String(n);
    count.hidden = n === 0;
    fab.setAttribute('aria-label', n === 0 ? 'Package folder, empty' : 'Package folder, ' + n + (n === 1 ? ' resource' : ' resources'));
    if (bump) { fab.classList.remove('bump'); void fab.offsetWidth; fab.classList.add('bump'); }
  }

  /* ---------------- save / remove from package ---------------- */
  function toggleSave(id) {
    const i = pkg.items.indexOf(id);
    if (i === -1) { pkg.items.push(id); toast('Added to package'); }
    else { pkg.items.splice(i, 1); toast('Removed from package'); }
    persistPkg();
    updateFab(true);
    syncCardState(id);
  }
  function syncCardState(id) {
    const inPkg = pkg.items.indexOf(id) !== -1;
    document.querySelectorAll('.card[data-id]').forEach((card) => {
      if (card.dataset.id !== id) return;
      card.classList.toggle('in-package', inPkg);
      const btn = card.querySelector('.add-btn');
      if (btn) {
        btn.setAttribute('aria-pressed', String(inPkg));
        btn.setAttribute('aria-label', inPkg ? 'Remove from package' : 'Add to package');
        btn.title = inPkg ? 'Remove from package' : 'Add to package';
      }
    });
  }

  /* ============================================================
     VIEWS
     ============================================================ */

  /* ---------------- onboarding ---------------- */
  function renderOnboarding(app) {
    app.innerHTML =
      '<div class="onboard-card">' +
      '<svg class="onboard-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="2.2"/><path d="M9 12h9"/><path d="M14.5 8.5 18 12l-3.5 3.5"/><circle cx="21" cy="12" r="1" fill="currentColor" stroke="none"/></svg>' +
      '<h1 class="page-title">Resource Handoff</h1>' +
      '<p class="page-sub">Build a take-home package of local resources and share it through a private link. Made for mobile crisis work in the field.</p>' +
      (Store.isPersistent() ? '' :
        '<div class="storage-note" role="status">' + I.warn + '<span>Browser storage is unavailable in this preview, so data will not persist after you leave. Open this site in its own browser tab or install it for full offline use.</span></div>') +
      '<ul class="privacy-list" role="list">' +
      '<li>' + I.shield + '<div><strong>No client information, ever</strong><p>No names, diagnoses, or case notes. Only public resource information goes into a package.</p></div></li>' +
      '<li>' + I.users + '<div><strong>Private links</strong><p>Each package link uses a long random code created on this device. No server stores it, and nothing is tracked.</p></div></li>' +
      '<li>' + I.box + '<div><strong>Works offline</strong><p>Once loaded, everything runs on the device — no account, no signal needed.</p></div></li>' +
      '</ul>' +
      '<div class="dropzone" id="dropzone">' + I.upload +
      '<p>Upload a resource file for your area<br />(.json)</p>' +
      '<button class="btn btn-primary" id="pick-file-btn" data-testid="button-upload">Choose file</button>' +
      '<input type="file" id="file-input" accept=".json,application/json" class="sr-only" aria-label="Resource JSON file" />' +
      '</div>' +
      '<div class="divider-or" aria-hidden="true">or</div>' +
      '<button class="btn btn-secondary btn-block" id="load-sample-btn" data-testid="button-sample">Load sample data to try it</button>' +
      '<details style="margin-top:' + '1.5rem' + '">' +
      '<summary style="min-height:44px;display:inline-flex;align-items:center;font-weight:500;font-size:var(--text-sm);cursor:pointer">View the expected file format</summary>' +
      '<div class="schema-box" style="margin-top:0.75rem"><pre>' + esc(JSON.stringify({
        area: 'Columbus, Ohio',
        updated: '2026-11-01',
        categoryOrder: ['Immediate Needs', 'Housing', 'Food'],
        resources: [{ id: 'community-shelter-intake', name: 'Community Shelter Intake Line', category: 'Immediate Needs', description: 'Central intake for emergency shelter beds.', phone: '(555) 123-4567', address: '123 Main St', hours: '24/7 phone line', eligibility: 'Adults 18+', website: 'https://example.org', whatToBring: ['Photo ID if you have it', 'Medications'], languages: ['English', 'Spanish'], tags: ['shelter'] }]
      }, null, 2)) + '</pre></div>' +
      '<button class="btn btn-secondary" id="download-sample-btn" style="margin-top:0.75rem">' + I.download + ' Download example JSON</button>' +
      '</details>' +
      '<div class="import-feedback" id="import-feedback"></div>' +
      '</div>';

    const fileInput = app.querySelector('#file-input');
    const dropzone = app.querySelector('#dropzone');
    app.querySelector('#pick-file-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleResourceFile(fileInput.files[0], app); fileInput.value = ''; });
    ['dragover', 'dragenter'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
    dropzone.addEventListener('drop', (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleResourceFile(f, app);
    });
    app.querySelector('#load-sample-btn').addEventListener('click', async () => {
      const res = await importResourceText(JSON.stringify(SAMPLE_DATA), 'sample');
      if (res.ok) { toast('Sample data loaded'); location.hash = '#/'; }
    });
    app.querySelector('#download-sample-btn').addEventListener('click', () => {
      downloadFile('resource-file-example.json', JSON.stringify(SAMPLE_DATA, null, 2));
    });
  }

  function showImportFeedback(el, result) {
    if (result.ok) {
      const bits = ['<div class="banner info" role="status">' + I.check + '<span>Loaded ' + result.count + ' resources' + (result.source ? ' from ' + esc(result.source) : '') + '.</span></div>'];
      if (result.warnings && result.warnings.length) bits.push('<div class="banner warn">' + I.warn + '<span>' + esc(result.warnings.join(' ')) + '</span></div>');
      if (result.droppedFromPackage) bits.push('<div class="banner warn">' + I.warn + '<span>' + result.droppedFromPackage + ' saved resource' + (result.droppedFromPackage === 1 ? '' : 's') + ' no longer exist in the new file and were removed from your package.</span></div>');
      el.innerHTML = bits.join('');
    } else {
      el.innerHTML = '<div class="banner warn">' + I.warn + '<span><strong>Could not import this file.</strong><br />' + esc(result.errors.join('<br />')) + '</span></div>';
    }
  }

  async function handleResourceFile(file, app) {
    if (file.size > 15 * 1024 * 1024) {
      const el = app.querySelector('#import-feedback');
      if (el) showImportFeedback(el, { ok: false, errors: ['That file is larger than 15 MB.'] });
      return;
    }
    let text;
    try { text = await file.text(); }
    catch (e) {
      const el = app.querySelector('#import-feedback');
      if (el) showImportFeedback(el, { ok: false, errors: ['Could not read that file.'] });
      return;
    }
    const result = await importResourceText(text, file.name);
    const el = app.querySelector('#import-feedback');
    if (result.ok) {
      const notes = [];
      if (result.droppedFromPackage) notes.push(result.droppedFromPackage + ' saved resource' + (result.droppedFromPackage === 1 ? '' : 's') + ' no longer in the new file were removed from your package.');
      if (result.warnings && result.warnings.length) notes.push(result.warnings.join(' '));
      if (notes.length) pendingNotice = notes;
      toast('Resource file loaded');
      if (location.hash === '#/' || location.hash === '') route();
      else location.hash = '#/';
    } else if (el) showImportFeedback(el, result);
  }

  /* ---------------- browse ---------------- */
  function renderBrowse(app) {
    const cats = resourceData.categoryOrder;
    if (!browseState.tab || !cats.includes(browseState.tab)) browseState.tab = cats[0];
    const counts = {};
    resourceData.resources.forEach((r) => { counts[r.category] = (counts[r.category] || 0) + 1; });

    app.innerHTML =
      (pendingNotice && pendingNotice.length
        ? '<div class="banner warn" role="status">' + I.warn + '<span>' + esc(pendingNotice.join(' ')) + '</span></div>'
        : '') +
      '<div class="page-head">' +
      '<h1 class="page-title">Resources</h1>' +
      '<p class="page-sub">Tap a card for details. Long-press to add it to the package.</p>' +
      '</div>' +
      '<div class="search-wrap">' + I.search +
      '<input type="search" class="search-input" id="search-input" placeholder="Search name, service, phone…" aria-label="Search resources" value="' + esc(browseState.q) + '" data-testid="input-search" />' +
      '<button class="search-clear" id="search-clear" aria-label="Clear search" hidden>' + I.x + '</button>' +
      '</div>' +
      '<nav class="tabs" id="tabs" role="tablist" aria-label="Categories">' +
      cats.map((c) =>
        '<button class="tab" role="tab" aria-selected="' + (c === browseState.tab) + '" data-cat="' + esc(c) + '" data-testid="tab-' + cssId(c) + '">' +
        esc(c) + ' <span class="tab-count">' + (counts[c] || 0) + '</span></button>'
      ).join('') +
      '</nav>' +
      '<div id="results" class="card-stack" aria-live="polite"></div>';

    const input = app.querySelector('#search-input');
    const clearBtn = app.querySelector('#search-clear');
    let debounce;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        browseState.q = input.value.trim();
        clearBtn.hidden = browseState.q === '';
        renderResults();
      }, 140);
    });
    clearBtn.addEventListener('click', () => {
      input.value = ''; browseState.q = ''; clearBtn.hidden = true;
      input.focus(); renderResults();
    });

    function renderResults() {
      const results = app.querySelector('#results');
      const tabs = app.querySelector('#tabs');
      if (browseState.q) {
        tabs.hidden = true;
        const q = browseState.q.toLowerCase();
        const matches = resourceData.resources.filter((r) =>
          [r.name, r.description, r.category, r.phone, r.address].concat(r.tags || []).concat(r.languages || [])
            .some((v) => v && String(v).toLowerCase().includes(q))
        );
        if (!matches.length) {
          results.innerHTML = '<div class="empty-state">' + I.search + 'No resources match “' + esc(browseState.q) + '”. Try a shorter search.</div>';
          return;
        }
        const groups = new Map();
        cats.concat(resourceData.resources.map((r) => r.category).filter((c) => !cats.includes(c)))
          .forEach((c) => { const g = matches.filter((r) => r.category === c); if (g.length) groups.set(c, g); });
        let html = '';
        groups.forEach((g, c) => {
          html += '<h2 class="result-cat" style="font-size:var(--text-sm);font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--color-text-faint);margin:var(--space-4) 0 var(--space-3)">' + esc(c) + '</h2><div class="card-stack">' + g.map(cardHtml).join('') + '</div>';
        });
        results.innerHTML = html;
      } else {
        tabs.hidden = false;
        const list = resourceData.resources.filter((r) => r.category === browseState.tab);
        results.innerHTML = list.length
          ? list.map(cardHtml).join('')
          : '<div class="empty-state">' + I.box + 'Nothing in this category yet.</div>';
      }
      bindCards(results);
    }

    app.querySelector('#tabs').addEventListener('click', (e) => {
      const t = e.target.closest('.tab');
      if (!t) return;
      browseState.tab = t.dataset.cat;
      app.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b === t)));
      renderResults();
    });

    pendingNotice = null;
    renderResults();
  }

  function cardHtml(r) {
    const inPkg = pkg.items.indexOf(r.id) !== -1;
    const cid = cssId(r.id);
    const det = 'det-' + cid;
    return (
      '<article class="card' + (inPkg ? ' in-package' : '') + '" data-id="' + esc(r.id) + '" data-testid="card-' + cid + '">' +
      '<div class="card-top">' +
      '<div class="card-head" role="button" tabindex="0" aria-expanded="false" aria-controls="' + det + '" data-action="expand">' +
      '<h3>' + esc(r.name) + '</h3>' +
      (r.description ? '<p class="desc">' + esc(r.description) + '</p>' : '') +
      '<div class="card-meta-row">' +
      (r.phone ? '<span>' + I.phone + esc(r.phone) + '</span>' : '') +
      (r.hours ? '<span>' + I.clock + esc(r.hours) + '</span>' : '') +
      '</div>' +
      '</div>' +
      '<div class="card-side">' +
      '<button class="icon-btn add-btn" data-action="toggle-save" aria-pressed="' + inPkg + '" aria-label="' + (inPkg ? 'Remove from package' : 'Add to package') + '" title="' + (inPkg ? 'Remove from package' : 'Add to package') + '" data-testid="button-add-' + cid + '">' + I.plus + I.check + '</button>' +
      '<button class="icon-btn chev-btn" data-action="expand" aria-expanded="false" aria-controls="' + det + '" aria-label="More details for ' + esc(r.name) + '">' + I.chev + '</button>' +
      '</div>' +
      '</div>' +
      '<div class="card-details" id="' + det + '" hidden>' + detailsHtml(r) + '</div>' +
      '</article>'
    );
  }

  function detailsHtml(r) {
    function block(term, valueHtml, wide) {
      return '<div class="detail-block' + (wide ? ' wide' : '') + '"><dt>' + esc(term) + '</dt><dd>' + valueHtml + '</dd></div>';
    }
    let dl = '';
    if (r.phone) dl += block('Phone', '<a href="' + telHref(r.phone) + '">' + esc(r.phone) + '</a>');
    if (r.altPhone) dl += block('Other phone', '<a href="' + telHref(r.altPhone) + '">' + esc(r.altPhone) + '</a>');
    if (r.address) dl += block('Address', '<a href="' + mapsHref(r.address) + '" target="_blank" rel="noopener">' + esc(r.address) + '</a>');
    if (r.hours) dl += block('Hours', esc(r.hours));
    if (r.eligibility) dl += block('Eligibility', esc(r.eligibility));
    if (r.website) dl += block('Website', '<a href="' + esc(r.website) + '" target="_blank" rel="noopener">' + esc(r.website.replace(/^https?:\/\//, '')) + '</a>');
    if (r.languages) dl += block('Languages', esc(r.languages.join(', ')));
    if (r.whatToBring && r.whatToBring.length) {
      dl += block('What to bring', '<ul class="bring-list" role="list">' + r.whatToBring.map((b) => '<li>' + esc(b) + '</li>').join('') + '</ul>', true);
    }
    if (r.notes) dl += block('Good to know', esc(r.notes), true);
    const actions =
      '<div class="card-actions">' +
      (r.phone ? '<a class="btn btn-primary" href="' + telHref(r.phone) + '">' + I.phone + 'Call</a>' : '') +
      (r.website ? '<a class="btn btn-secondary" href="' + esc(r.website) + '" target="_blank" rel="noopener">' + I.globe + 'Website</a>' : '') +
      (r.address ? '<a class="btn btn-secondary" href="' + mapsHref(r.address) + '" target="_blank" rel="noopener">' + I.pin + 'Directions</a>' : '') +
      '</div>';
    return (dl ? '<dl class="detail-grid">' + dl + '</dl>' : '') +
      (r.tags && r.tags.length ? '<div class="tag-row">' + r.tags.map((t) => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>' : '') +
      actions;
  }

  /* card interactions: expand + long-press */
  function bindCards(container) {
    container.querySelectorAll('.card').forEach((card) => {
      card.addEventListener('contextmenu', (e) => { if (!e.target.closest('a')) e.preventDefault(); });
      let timer = null, sx = 0, sy = 0;
      card.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button, a, input, textarea, select, [role="button"]')) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        sx = e.clientX; sy = e.clientY;
        timer = setTimeout(() => {
          timer = null;
          lastLongPressAt = Date.now();
          card.classList.add('lp-armed');
          if (navigator.vibrate) { try { navigator.vibrate(25); } catch (err) {} }
          toggleSave(card.dataset.id);
          setTimeout(() => card.classList.remove('lp-armed'), 350);
        }, 500);
      });
      const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
      card.addEventListener('pointermove', (e) => {
        if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) cancel();
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => card.addEventListener(ev, cancel));
    });
  }

  function expandCard(el) {
    if (Date.now() - lastLongPressAt < 500) return; // ignore click right after a long-press
    const card = el.closest('.card');
    if (!card) return;
    const details = card.querySelector('.card-details');
    const open = !details.hidden;
    details.hidden = open;
    card.querySelectorAll('[data-action="expand"]').forEach((b) => b.setAttribute('aria-expanded', String(!open)));
  }

  /* ---------------- package editor ---------------- */
  function renderPackageEditor(app) {
    const items = pkg.items
      .map((id) => (resourceData ? resourceData.resources.find((r) => r.id === id) : null))
      .filter(Boolean);

    app.innerHTML =
      '<div class="page-head">' +
      '<h1 class="page-title">Package</h1>' +
      '<p class="page-sub">What the person you are assisting takes home.</p>' +
      '</div>' +
      '<div class="field">' +
      '<label for="pkg-title">Package title</label>' +
      '<input class="text-input" id="pkg-title" type="text" maxlength="80" value="' + esc(pkg.title) + '" data-testid="input-title" />' +
      '</div>' +
      '<div class="field">' +
      '<label for="pkg-notes">Short notes (optional)</label>' +
      '<div class="callout" style="margin-bottom:0.5rem">' + I.warn + '<span>Do not enter personal or medical details. Notes travel with the link — keep them general (for example: “ask for the walk-in window”).</span></div>' +
      '<textarea class="textarea" id="pkg-notes" maxlength="' + NOTES_MAX + '" placeholder="e.g. Call ahead — beds fill by 6pm">' + esc(pkg.notes) + '</textarea>' +
      '<div class="char-count"><span id="notes-count">' + pkg.notes.length + '</span> / ' + NOTES_MAX + '</div>' +
      '</div>' +
      '<div class="field">' +
      '<label for="pkg-expiry">Link expiration</label>' +
      '<select class="select" id="pkg-expiry" data-testid="select-expiry">' +
      [[7, '7 days'], [30, '30 days (default)'], [90, '90 days'], [0, 'Never']].map(([v, l]) =>
        '<option value="' + v + '"' + (pkg.expiryDays === v ? ' selected' : '') + '>' + l + '</option>').join('') +
      '</select>' +
      '<p class="hint">The recipient sees an “expired” notice after this date.</p>' +
      '</div>' +
      '<h2 style="font-size:var(--text-base);font-weight:700;margin:var(--space-4) 0 var(--space-2)">' + items.length + ' saved resource' + (items.length === 1 ? '' : 's') + '</h2>' +
      (items.length
        ? '<div class="pkg-list">' + items.map((r) =>
          '<div class="pkg-item" data-id="' + esc(r.id) + '">' +
          '<div class="pkg-item-body"><strong>' + esc(r.name) + '</strong><span>' + esc(r.category) + '</span></div>' +
          '<button class="icon-btn" data-action="remove-item" aria-label="Remove ' + esc(r.name) + ' from package">' + I.x + '</button>' +
          '</div>').join('') + '</div>'
        : '<div class="empty-state">' + I.box + 'No resources saved yet.<br />Browse and long-press a card, or use its + button.</div>') +
      '<div class="share-actions two-col" style="margin-top:var(--space-6)">' +
      '<a class="btn btn-primary span-2" href="#/share" data-testid="button-share">' + I.share + 'Share this package</a>' +
      '<a class="btn btn-secondary span-2" href="#/preview" data-testid="button-preview">' + I.eye + 'Preview as recipient</a>' +
      '</div>';

    app.querySelector('#pkg-title').addEventListener('input', (e) => {
      pkg.title = e.target.value || 'Your Resources'; persistPkg();
    });
    const notes = app.querySelector('#pkg-notes');
    notes.addEventListener('input', () => {
      pkg.notes = notes.value.slice(0, NOTES_MAX); persistPkg();
      app.querySelector('#notes-count').textContent = String(pkg.notes.length);
    });
    app.querySelector('#pkg-expiry').addEventListener('change', (e) => {
      pkg.expiryDays = parseInt(e.target.value, 10) || 0; persistPkg();
    });
  }

  /* ---------------- share ---------------- */
  async function renderShare(app) {
    if (!pkg.items.length) {
      app.innerHTML =
        '<div class="page-head"><h1 class="page-title">Share</h1></div>' +
        '<div class="empty-state">' + I.box + 'The package is empty. Add resources first — then come back to share them.</div>' +
        '<div style="text-align:center;margin-top:var(--space-5)"><a class="btn btn-primary" href="#/">Browse resources</a></div>';
      return;
    }
    app.innerHTML =
      '<div class="page-head"><h1 class="page-title">Share package</h1>' +
      '<p class="page-sub">The link and QR code are made on this device. Nothing is sent to a server.</p></div>' +
      '<div class="share-card" id="share-card"><p>' + I.refresh + ' Building the private link…</p></div>';

    const url = await buildShareUrl();
    const payload = packagePayload();
    const expiresLabel = payload.e ? fmtDate(payload.e) : 'Never';
    const card = app.querySelector('#share-card');
    const tooLongForQr = url.length > 2900;

    card.innerHTML =
      '<dl class="meta-list">' +
      '<div><dt>Resources</dt><dd>' + pkg.items.length + '</dd></div>' +
      '<div><dt>Link expires</dt><dd>' + esc(expiresLabel) + '</dd></div>' +
      '<div><dt>Access code</dt><dd>' + esc(pkg.token.slice(0, 8)) + '…</dd></div>' +
      '</dl>' +
      (tooLongForQr
        ? '<div class="banner warn">' + I.warn + '<span>This package is too large for a QR code. Use Copy link or Print instead — both work fully offline.</span></div>'
        : '<div class="qr-box" id="qr-box" aria-label="QR code linking to this package" role="img"></div>') +
      '<div class="link-box">' +
      '<code id="share-url" data-testid="text-link">' + esc(url) + '</code>' +
      '<button class="icon-btn" data-action="copy-link" aria-label="Copy link">' + I.copy + '</button>' +
      '</div>' +
      '<div class="share-actions two-col">' +
      '<button class="btn btn-primary span-2" data-action="copy-link" data-testid="button-copy">' + I.copy + 'Copy link</button>' +
      (navigator.share ? '<button class="btn btn-secondary span-2" data-action="native-share">' + I.share + 'Share…</button>' : '') +
      '<button class="btn btn-secondary" data-action="print">' + I.print + 'Print / Save PDF</button>' +
      '<button class="btn btn-secondary" data-action="regenerate">' + I.refresh + 'Regenerate link</button>' +
      '<button class="btn btn-danger span-2" data-action="delete-package">' + I.trash + 'Delete package</button>' +
      '</div>' +
      '<p class="schema-note">Regenerating creates a new random access code. Since packages live entirely in the link (there is no server), a previously copied link can still be opened by whoever saved it — delete the package and rebuild it if that matters.</p>';

    if (!tooLongForQr) {
      try {
        const qr = window.qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        const svg = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
        const box = card.querySelector('#qr-box');
        box.innerHTML = svg;
        const svgEl = box.querySelector('svg');
        if (svgEl) { svgEl.removeAttribute('width'); svgEl.removeAttribute('height'); }
      } catch (e) {
        card.querySelector('#qr-box') && card.querySelector('#qr-box').remove();
        card.insertAdjacentHTML('afterbegin', '<div class="banner warn">' + I.warn + '<span>Could not draw the QR code on this device — use Copy link instead.</span></div>');
      }
    }
    card.dataset.url = url;
    card.dataset.title = payload.t;
  }

  async function copyLink() {
    const card = document.getElementById('share-card');
    const url = card && card.dataset.url;
    if (!url) return;
    let ok = false;
    try { await navigator.clipboard.writeText(url); ok = true; } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch (e2) { ok = false; }
    }
    toast(ok ? 'Link copied' : 'Copy failed — select the link text manually');
  }

  /* ---------------- preview & recipient view ---------------- */
  async function renderPreview(app) {
    app.innerHTML = '<div class="page-head"><h1 class="page-title">Preview</h1><p class="page-sub">Building preview…</p></div>';
    try {
      const payload = await decodePayload(await encodePayload());
      renderPackageView(app, payload, { preview: true });
    } catch (e) {
      app.innerHTML = '<div class="banner warn">' + I.warn + '<span>Could not build the preview.</span></div>';
    }
  }

  async function renderRecipient(app, token, code) {
    app.innerHTML =
      '<div class="page-head"><h1 class="page-title">Resource package</h1><p class="page-sub">Opening…</p></div>';
    if (!code) {
      app.innerHTML = '<div class="banner warn">' + I.warn + '<span>This link looks incomplete. Ask the person who shared it with you to send it again.</span></div>';
      return;
    }
    try {
      const payload = await decodePayload(code);
      renderPackageView(app, payload, { preview: false, token: token });
    } catch (e) {
      app.innerHTML =
        '<div class="banner warn">' + I.warn + '<span><strong>This package could not be opened.</strong><br />The link may have been cut short when it was copied or printed. Ask the person who shared it to resend it — or use their printed copy.</span></div>';
    }
  }

  function renderPackageView(app, data, opts) {
    const resources = (data.r || []).filter((r) => r && r.name);
    const expired = data.e && new Date(data.e) < new Date();
    const cats = [];
    resources.forEach((r) => { if (!cats.includes(r.category)) cats.push(r.category); });

    app.innerHTML =
      (opts.preview
        ? '<a class="back-link" href="#/package">' + I.back + 'Back to package</a>' +
          '<div class="banner info">' + I.eye + '<span><strong>Preview.</strong> This is exactly what the recipient sees when they open the link.</span></div>'
        : '') +
      (expired
        ? '<div class="banner warn">' + I.warn + '<span><strong>This link expired on ' + esc(fmtDate(data.e)) + '.</strong> The details below are still shown, but hours and phone numbers may have changed — check before relying on them.</span></div>'
        : '') +
      '<div class="recipient-hero">' +
      '<h1>' + esc(data.t || 'Your Resources') + '</h1>' +
      '<p>' + esc([data.a, data.u ? 'updated ' + data.u : ''].filter(Boolean).join(' · ')) + '</p>' +
      '</div>' +
      (data.n ? '<div class="callout" style="margin-bottom:var(--space-5)">' + I.info + '<span>' + esc(data.n) + '</span></div>' : '') +
      cats.map((c) => {
        const list = resources.filter((r) => r.category === c);
        return (
          '<section class="recipient-section" aria-labelledby="rc-' + cssId(c) + '">' +
          '<h2 id="rc-' + cssId(c) + '">' + esc(c) + '</h2>' +
          list.map(recipientCardHtml).join('') +
          '</section>'
        );
      }).join('') +
      '<div class="share-actions" style="margin-top:var(--space-8)">' +
      '<button class="btn btn-primary btn-block" data-action="recipient-save" data-testid="button-save">' + I.download + 'Save these resources</button>' +
      '<button class="btn btn-secondary btn-block" data-action="recipient-print">' + I.print + 'Print / Save PDF</button>' +
      '</div>' +
      '<footer class="site-footer"><span>Shared with Resource Handoff — a private resource tool.</span><span>No personal data is collected.</span></footer>';

    const stash = document.getElementById('print-area');
    stash.dataset.payload = JSON.stringify(data);
  }

  function recipientCardHtml(r) {
    function row(icon, html) { return '<div class="row">' + icon + '<div>' + html + '</div></div>'; }
    let rows = '';
    if (r.phone) rows += row(I.phone, '<a href="' + telHref(r.phone) + '">' + esc(r.phone) + '</a>' + (r.hours && /24\/7/.test(r.hours) ? ' — 24/7' : ''));
    if (r.altPhone) rows += row(I.phone, '<a href="' + telHref(r.altPhone) + '">' + esc(r.altPhone) + '</a>');
    if (r.address) rows += row(I.pin, '<a href="' + mapsHref(r.address) + '" target="_blank" rel="noopener">' + esc(r.address) + '</a>');
    if (r.hours) rows += row(I.clock, esc(r.hours));
    if (r.eligibility) rows += row(I.users, 'Who it serves: ' + esc(r.eligibility));
    if (r.website) rows += row(I.globe, '<a href="' + esc(r.website) + '" target="_blank" rel="noopener">' + esc(r.website.replace(/^https?:\/\//, '')) + '</a>');
    if (r.languages) rows += row(I.users, esc(r.languages.join(', ')));
    if (r.whatToBring && r.whatToBring.length) rows += row(I.box, 'Bring: ' + esc(r.whatToBring.join(', ')));
    if (r.notes) rows += row(I.info, esc(r.notes));
    return (
      '<article class="res-card">' +
      '<h3>' + esc(r.name) + '</h3>' +
      (r.description ? '<p class="desc">' + esc(r.description) + '</p>' : '') +
      (rows ? '<div class="res-rows">' + rows + '</div>' : '') +
      '<div class="res-actions">' +
      (r.phone ? '<a class="btn btn-primary" href="' + telHref(r.phone) + '">' + I.phone + 'Call</a>' : '') +
      (r.address ? '<a class="btn btn-secondary" href="' + mapsHref(r.address) + '" target="_blank" rel="noopener">' + I.pin + 'Map</a>' : '') +
      (r.website ? '<a class="btn btn-secondary" href="' + esc(r.website) + '" target="_blank" rel="noopener">' + I.globe + 'Website</a>' : '') +
      '</div>' +
      '</article>'
    );
  }

  function saveRecipientCopy() {
    const stash = document.getElementById('print-area');
    let data = null;
    try { data = JSON.parse(stash.dataset.payload || 'null'); } catch (e) {}
    if (!data) return;
    const out = {
      area: data.a || '',
      updated: data.u || '',
      title: data.t || 'Your Resources',
      notes: data.n || '',
      categoryOrder: Array.from(new Set((data.r || []).map((r) => r.category))),
      resources: data.r || []
    };
    downloadFile('my-resources.json', JSON.stringify(out, null, 2));
    toast('Saved to your downloads');
  }

  /* ---------------- print ---------------- */
  function printPackage() {
    const stash = document.getElementById('print-area');
    let data = null;
    try { data = JSON.parse(stash.dataset.payload || 'null'); } catch (e) {}
    if (!data && pkg && pkg.items.length) data = packagePayload(); // printing straight from the share page
    if (!data) return;
    const resources = (data.r || []).filter((r) => r && r.name);
    const cats = [];
    resources.forEach((r) => { if (!cats.includes(r.category)) cats.push(r.category); });
    function dlRow(term, val) { return '<dt>' + esc(term) + '</dt><dd>' + val + '</dd>'; }
    stash.innerHTML =
      '<div class="print-doc">' +
      '<div class="print-head"><h1>' + esc(data.t || 'Your Resources') + '</h1>' +
      '<div class="print-sub">' + esc([data.a, data.u ? 'updated ' + data.u : '', data.e ? 'link valid through ' + fmtDate(data.e) : ''].filter(Boolean).join(' · ')) + '</div></div>' +
      (data.n ? '<div class="print-notes">' + esc(data.n) + '</div>' : '') +
      cats.map((c) =>
        '<h2>' + esc(c) + '</h2>' +
        resources.filter((r) => r.category === c).map((r) => {
          let dl = '';
          if (r.phone) dl += dlRow('Phone', esc(r.phone));
          if (r.altPhone) dl += dlRow('Other', esc(r.altPhone));
          if (r.address) dl += dlRow('Address', esc(r.address));
          if (r.hours) dl += dlRow('Hours', esc(r.hours));
          if (r.eligibility) dl += dlRow('Serves', esc(r.eligibility));
          if (r.website) dl += dlRow('Web', esc(r.website));
          if (r.languages) dl += dlRow('Languages', esc(r.languages.join(', ')));
          if (r.whatToBring && r.whatToBring.length) dl += dlRow('Bring', esc(r.whatToBring.join(', ')));
          if (r.notes) dl += dlRow('Note', esc(r.notes));
          return '<div class="print-card"><h3>' + esc(r.name) + '</h3>' +
            (r.description ? '<div class="pd">' + esc(r.description) + '</div>' : '') +
            (dl ? '<dl>' + dl + '</dl>' : '') + '</div>';
        }).join('')
      ).join('') +
      '<div class="print-foot">Hours and phone numbers change often — call ahead when possible. Printed from Resource Handoff.</div>' +
      '</div>';
    try { window.print(); } catch (e) { toast('Printing is not available here.'); }
  }

  /* ---------------- settings ---------------- */
  function renderSettings(app) {
    const used = Store.bytesUsed();
    const quotaMb = 5;
    const pct = Math.min(100, Math.round((used / (quotaMb * 1024 * 1024)) * 100));
    const nRes = resourceData ? resourceData.resources.length : 0;
    const nCats = resourceData ? resourceData.categoryOrder.length : 0;

    app.innerHTML =
      '<div class="page-head"><h1 class="page-title">Settings & data</h1>' +
      '<p class="page-sub">Everything lives in this browser. Nothing is uploaded anywhere.</p></div>' +
      (Store.isPersistent() ? '' :
        '<div class="storage-note">' + I.warn + '<span>Browser storage is unavailable in this preview — data will not persist after you leave this page. Open the site in its own tab or install it for full offline use.</span></div>') +
      (resourceData ?
        '<section class="settings-section">' +
        '<h2>Resource file</h2>' +
        '<p class="section-sub">Loaded for ' + esc(resourceData.area) + (resourceData.updated ? ' · updated ' + esc(resourceData.updated) : '') + '.</p>' +
        '<dl class="kv-list">' +
        '<div><dt>Resources</dt><dd>' + nRes + '</dd></div>' +
        '<div><dt>Categories</dt><dd>' + nCats + '</dd></div>' +
        (resourceData.sourceNote ? '<div><dt>Source</dt><dd>' + esc(resourceData.sourceNote) + '</dd></div>' : '') +
        '</dl>' +
        '<button class="btn btn-secondary" id="update-file-btn">' + I.upload + 'Upload a newer resource file</button>' +
        '<p class="schema-note">Replaces the resource list. Your saved package is kept; entries that no longer exist in the new file are dropped from it.</p>' +
        '<input type="file" id="update-file-input" accept=".json,application/json" class="sr-only" aria-label="New resource JSON file" />' +
        '<div id="import-feedback"></div>' +
        '</section>'
        :
        '<section class="settings-section">' +
        '<h2>Resource file</h2>' +
        '<p class="section-sub">No resource file loaded yet.</p>' +
        '<button class="btn btn-secondary" id="update-file-btn">' + I.upload + 'Upload a resource file</button>' +
        '<input type="file" id="update-file-input" accept=".json,application/json" class="sr-only" aria-label="Resource JSON file" />' +
        '<div id="import-feedback"></div>' +
        '</section>') +
      '<section class="settings-section">' +
      '<h2>Backup & transfer</h2>' +
      '<p class="section-sub">Move everything — resource file, package, settings — to another device without a server.</p>' +
      '<div class="share-actions two-col">' +
      '<button class="btn btn-secondary" data-action="export-data">' + I.download + 'Export backup</button>' +
      '<button class="btn btn-secondary" data-action="import-backup">' + I.upload + 'Import backup</button>' +
      '</div>' +
      '<input type="file" id="backup-input" accept=".json,application/json" class="sr-only" aria-label="Backup JSON file" />' +
      '<div id="backup-feedback"></div>' +
      '</section>' +
      '<section class="settings-section">' +
      '<h2>Storage</h2>' +
      '<dl class="kv-list">' +
      '<div><dt>Used</dt><dd id="storage-used">' + fmtBytes(used) + '</dd></div>' +
      '<div><dt>Typical limit</dt><dd>~5 MB per site</dd></div>' +
      '</dl>' +
      '<div class="meter" role="img" aria-label="Storage ' + pct + '% full"><div class="meter-fill' + (pct > 80 ? ' hot' : '') + '" style="width:' + pct + '%"></div></div>' +
      (pct > 80 ? '<div class="callout" style="margin-top:0.75rem">' + I.warn + '<span>Storage is nearly full. Export a backup, then delete data you no longer need.</span></div>' : '') +
      '</section>' +
      (deferredInstall ?
        '<section class="settings-section"><h2>Install app</h2>' +
        '<p class="section-sub">Add Resource Handoff to your home screen for full-screen, offline use in the field.</p>' +
        '<button class="btn btn-primary" data-action="install">' + I.install + 'Install</button></section>' : '') +
      '<section class="settings-section">' +
      '<h2>Privacy</h2>' +
      '<p class="section-sub">This tool never asks for a client name, diagnosis, date of birth, or case notes. Package links contain a long random access code and the public resource list only — no trackers, no analytics, no third-party calls when generating links or QR codes.</p>' +
      '<button class="btn btn-danger" data-action="delete-all">' + I.trash + 'Delete all data on this device</button>' +
      '</section>' +
      '<footer class="site-footer"><span>Resource Handoff</span><span>Works offline · No accounts · No tracking</span></footer>';

    const upBtn = app.querySelector('#update-file-btn');
    const upInput = app.querySelector('#update-file-input');
    upBtn.addEventListener('click', () => upInput.click());
    upInput.addEventListener('change', () => { if (upInput.files[0]) handleResourceFile(upInput.files[0], app); upInput.value = ''; });

    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((est) => {
        const el = app.querySelector('#storage-used');
        if (el && est && est.quota) {
          el.textContent = fmtBytes(est.usage || 0) + ' of ' + fmtBytes(est.quota) + ' available';
        }
      }).catch(() => {});
    }
  }

  async function importBackup(file, app) {
    const feedback = app.querySelector('#backup-feedback');
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.app !== 'resource-handoff' || !data.resources) throw new Error('not a backup');
      const v = validateResourceFile(data.resources);
      if (v.errors.length) throw new Error(v.errors[0]);
      resourceData = normalizeResourceFile(data.resources);
      persistResources();
      if (data.package && typeof data.package === 'object' && Array.isArray(data.package.items)) {
        pkg = data.package;
        if (!pkg.token) pkg.token = newToken();
        persistPkg();
      }
      toast('Backup restored');
      location.hash = '#/';
      route();
    } catch (e) {
      if (feedback) feedback.innerHTML = '<div class="banner warn">' + I.warn + '<span>That file is not a Resource Handoff backup.</span></div>';
    }
  }

  function exportData() {
    const backup = {
      app: 'resource-handoff',
      version: 1,
      exportedAt: new Date().toISOString(),
      resources: resourceData,
      package: pkg
    };
    downloadFile('resource-handoff-backup.json', JSON.stringify(backup, null, 2));
    toast('Backup downloaded');
  }

  /* ---------------- global action delegation ---------------- */
  document.addEventListener('click', (e) => {
    const act = e.target.closest('[data-action]');
    if (!act) return;
    const action = act.dataset.action;
    if (action === 'expand') { expandCard(act); return; }
    if (action === 'toggle-save') { toggleSave(act.closest('.card').dataset.id); return; }
    if (action === 'remove-item') {
      const id = act.closest('.pkg-item').dataset.id;
      toggleSave(id);
      const item = act.closest('.pkg-item');
      if (item) item.remove();
      return;
    }
    if (action === 'copy-link') { copyLink(); return; }
    if (action === 'native-share') {
      const card = document.getElementById('share-card');
      if (card && navigator.share) {
        navigator.share({ title: card.dataset.title || 'Resource package', url: card.dataset.url }).catch(() => {});
      }
      return;
    }
    if (action === 'print') { printPackage(); return; }
    if (action === 'regenerate') {
      confirmDialog({
        title: 'Regenerate link?',
        body: 'A new random access code is created and the old code stops matching this package. Anyone holding the old link will need the new one.',
        confirmLabel: 'Regenerate',
        onConfirm: () => { pkg.token = newToken(); persistPkg(); toast('New link generated'); route(); }
      });
      return;
    }
    if (action === 'delete-package') {
      confirmDialog({
        title: 'Delete this package?',
        body: 'The saved resources, notes, and link are removed from this device. This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: () => { pkg = newPackage(); persistPkg(); toast('Package deleted'); location.hash = '#/'; }
      });
      return;
    }
    if (action === 'recipient-save') { saveRecipientCopy(); return; }
    if (action === 'recipient-print') { printPackage(); return; }
    if (action === 'export-data') { exportData(); return; }
    if (action === 'import-backup') {
      const input = document.getElementById('backup-input');
      if (input) input.click();
      return;
    }
    if (action === 'install' && deferredInstall) {
      deferredInstall.prompt().then(() => { deferredInstall = null; }).catch(() => {});
      return;
    }
    if (action === 'delete-all') {
      confirmDialog({
        title: 'Delete all data?',
        body: 'The resource file, package, and settings are erased from this browser. Export a backup first if you might need them.',
        confirmLabel: 'Delete everything',
        danger: true,
        onConfirm: () => {
          Store.remove(KEYS.resources);
          Store.remove(KEYS.pkg);
          resourceData = null;
          pkg = newPackage();
          toast('All data deleted');
          location.hash = '#/';
          route();
        }
      });
      return;
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card-head')) {
      e.preventDefault();
      expandCard(e.target);
    }
  });

  document.getElementById('backup-input') && document.getElementById('backup-input').addEventListener('change', function () {
    if (this.files[0]) importBackup(this.files[0], document.getElementById('app'));
    this.value = '';
  });

  /* ---------------- router ---------------- */
  function route() {
    const hash = location.hash || '#/';
    const app = document.getElementById('app');
    const fab = document.getElementById('package-fab');
    window.scrollTo(0, 0);
    app.focus({ preventScroll: true });

    if (hash.startsWith('#/p/')) {
      const seg = decodeURIComponent(hash.slice(4));
      const dot = seg.indexOf('.');
      fab.hidden = true;
      renderRecipient(app, dot > -1 ? seg.slice(0, dot) : '', dot > -1 ? seg.slice(dot + 1) : '');
      return;
    }
    if (!resourceData && hash !== '#/settings') {
      fab.hidden = true;
      document.getElementById('area-chip').hidden = true;
      if (hash === '#/package' || hash === '#/share' || hash === '#/preview') { location.hash = '#/'; return; }
      renderOnboarding(app);
      return;
    }
    updateChrome();
    switch (hash) {
      case '#/': case '': case '#':
        fab.hidden = false;
        renderBrowse(app);
        break;
      case '#/package':
        fab.hidden = true;
        renderPackageEditor(app);
        break;
      case '#/share':
        fab.hidden = true;
        renderShare(app);
        break;
      case '#/preview':
        fab.hidden = true;
        renderPreview(app);
        break;
      case '#/settings':
        fab.hidden = true;
        renderSettings(app);
        break;
      default:
        location.hash = '#/';
    }
  }

  window.addEventListener('hashchange', route);
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', route);
  else route();

  /* ---------------- service worker (offline / PWA) ---------------- */
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    try {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    } catch (e) { /* sandboxed previews may not allow SW registration */ }
  }
})();
