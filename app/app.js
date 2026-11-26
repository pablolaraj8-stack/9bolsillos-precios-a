/* 9Bolsillos — app local. La base de datos se guarda en el navegador (IndexedDB);
   tu colección y alertas en localStorage. Nada sale de tu ordenador. */
'use strict';

const $view = document.getElementById('view');
const $tabs = document.getElementById('tabs');
let SQL = null, DB = null, PRICE_DATE = null, HAS_HISTORY = false;
const STORE_KEY = '9b.collection.v1';

/* ---------- utilidades ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = v => v == null || isNaN(v) ? '—' : v.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const pct = v => (v >= 0 ? '+' : '−') + Math.abs(v).toLocaleString('es-ES', { maximumFractionDigits: 1 }) + ' %';
const dayToStr = d => { d = String(d); return d.slice(6, 8) + '/' + d.slice(4, 6) + '/' + d.slice(0, 4); };
function q(sql, params = []) {
  const st = DB.prepare(sql); st.bind(params); const out = [];
  while (st.step()) out.push(st.getAsObject());
  st.free(); return out;
}
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2200);
}
function img(base, cls = 'thumb', alt = '', cardId = null) { return cardId && CUSTOM_IMG[cardId] ? `<img class="${cls}" alt="${esc(alt)}" src="${CUSTOM_IMG[cardId]}">` : imgTag(base, 'low', cls, alt); }
// Imágenes propias (fotos que sube el usuario), guardadas en el navegador
const CUSTOM_IMG = {};
// Logo del set: misma carpeta que las imágenes de sus cartas en TCGdex (logo.webp); español con respaldo en inglés
function setLogo(base, cls, name = '', setId = '') {
  // Logo del set: TCGdex en español → TCGdex en inglés → CollectHolo (para los sets nuevos) → distintivo con el nombre
  const dir = base ? base.replace(/\/[^/]+$/, '') : '';
  const urls = (dir ? (dir.includes('/en/') ? [dir.replace('/en/', '/es/') + '/logo.webp', dir + '/logo.webp'] : [dir + '/logo.webp']) : [])
    .concat((window.SET_LOGOS || {})[setId] || []);
  const badge = `<span class="fbn logofb ${cls === 'biglogo' ? 'big' : ''}" ${urls.length ? 'style="display:none"' : ''}>${esc(name)}</span>`;
  if (!urls.length) return badge;
  return `<img class="${cls}" loading="lazy" alt="" src="${esc(urls[0])}" data-fb="${esc(urls.slice(1).join('|'))}" onerror="${LOGO_ERR}">` + badge;
}
const LOGO_ERR = "var l=(this.dataset.fb||'').split('|').filter(Boolean);if(l.length){this.src=l.shift();this.dataset.fb=l.join('|')}else{this.style.display='none';var n=this.parentNode&&this.parentNode.querySelector('.fbn');if(n)n.style.display=''}";
// Enlace a Cardmarket: listado de singles del set de la carta, filtrado por su nombre
// Enlace a Cardmarket: la carta en su ficha, filtrada por idioma (español en sets, japonés en lo asiático) y estado mínimo
const CM_LANG = { int: 4, asia: 7 }, CM_COND = { MT: 1, NM: 2, EX: 3, GD: 4, LP: 5, PL: 6, PO: 7 };
const cmCond = () => { try { return localStorage.getItem('cm_cond') || 'NM'; } catch (e) { return 'NM'; } };
const cmFilter = region => `language=${CM_LANG[region] || 4}&minCondition=${CM_COND[cmCond()] || 2}`;
// Cardmarket solo acepta sin sesión la dirección "bonita" de la carta (…/Singles/Set/Carta-V3-CRI116). 9B la aprende del Atajo.
const toSafari = u => (/iPad|iPhone|iPod/.test(navigator.userAgent) ? u.replace(/^https:\/\//, 'x-safari-https://') : u);   // en iPhone, abrir en Safari (donde tienes la sesión), no en el navegador interno
function cmProductLink(cm, region, rev) {
  const saved = (COL.cmurl || {})[cm];
  if (saved) return toSafari(`${saved}?${cmFilter(region)}${rev ? '&isReverseHolo=Y' : ''}`);
  // Dirección directa de la carta, montada como la forma Cardmarket: /Singles/<Set>/<Nombre>-V<n>-<CÓDIGO><número>
  const slug = cmSlug(cm);
  if (slug) return toSafari(`https://www.cardmarket.com/es/Pokemon/Products/Singles/${slug}?${cmFilter(region)}${rev ? '&isReverseHolo=Y' : ''}`);
  const nm = ((q('SELECT name FROM cm_products WHERE cm_product_id = ?', [cm])[0] || {}).name || '').replace(/\s*\[.*?\]\s*/g, ' ').trim();
  if (nm) return toSafari('https://www.cardmarket.com/es/Pokemon/Products/Search?searchString=' + encodeURIComponent(nm));
  return `https://www.cardmarket.com/es/Pokemon/Products?idProduct=${cm}&${cmFilter(region)}${rev ? '&isReverseHolo=Y' : ''}`;
}
function cmSlugify(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['’`.]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function cmSlug(cm) {
  try {
    const r = q(`SELECT p.name, p.cm_expansion_id AS exp, c.local_id, s.name_en, s.abbr FROM cm_products p
      JOIN card_variants v ON v.cm_product_id = p.cm_product_id JOIN cards c ON c.card_id = v.card_id JOIN sets s ON s.set_id = c.set_id
      WHERE p.cm_product_id = ? AND s.cm_expansion_id = p.cm_expansion_id LIMIT 1`, [cm])[0];
    if (!r || !r.abbr || !r.name_en || !r.local_id) return null;
    const vers = q('SELECT cm_product_id FROM cm_products WHERE cm_expansion_id = ? AND name = ? ORDER BY cm_product_id', [r.exp, r.name]).map(x => x.cm_product_id);
    const base = cmSlugify(r.name.replace(/\s*\[.*$/, ''));
    const v = vers.length > 1 ? `-V${vers.indexOf(cm) + 1}` : '';
    return `${cmSlugify(r.name_en)}/${base}${v}-${r.abbr}${r.local_id}`;
  } catch (e) { return null; }  // base de datos antigua sin código de set
}
function cmLink(v, c) {
  const region = (c && c.region) || (c && c.card_id && (q('SELECT s.region FROM cards c JOIN sets s USING(set_id) WHERE card_id=?', [c.card_id])[0] || {}).region) || 'int';
  if (v && v.cm_product_id) return cmProductLink(v.cm_product_id, region, isRevHolo(v));
  return 'https://www.cardmarket.com/es/Pokemon/Products/Singles?searchString=' + encodeURIComponent((c && (c.name_en || c.name)) || '');
}
function cardImg(c, size, cls, alt) { return CUSTOM_IMG[c.card_id] ? `<img ${cls ? `class="${cls}"` : ''} alt="${esc(alt || '')}" src="${CUSTOM_IMG[c.card_id]}">` : imgTag(c.image_base, size, cls, alt || '', '', (window.IMG_FB || {})[c.card_id] || ''); }
async function loadCustomImgs() {
  const d = await idb();
  await new Promise(r => { const req = d.transaction('files').objectStore('files').openCursor(); req.onsuccess = () => { const cur = req.result; if (!cur) return r(); if (String(cur.key).startsWith('img:')) CUSTOM_IMG[String(cur.key).slice(4)] = cur.value; cur.continue(); }; req.onerror = () => r(); });
}
function resizeImage(file) {
  return new Promise((res, rej) => {
    const im = new Image(); im.onload = () => {
      const k = Math.min(1, 600 / im.height), cv = document.createElement('canvas');
      cv.width = Math.round(im.width * k); cv.height = Math.round(im.height * k);
      cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
      let u = cv.toDataURL('image/webp', 0.82); if (!u.startsWith('data:image/webp')) u = cv.toDataURL('image/jpeg', 0.85);
      URL.revokeObjectURL(im.src); res(u);
    }; im.onerror = () => rej(new Error('No se pudo leer la imagen')); im.src = URL.createObjectURL(file);
  });
}


// Imagen en español si existe; si no, en inglés; si tampoco, se oculta y queda el nombre
function imgUrls(base, size) {
  if (!base) return [null, null];
  const en = base + '/' + size + '.webp';
  return base.includes('/en/') ? [base.replace('/en/', '/es/') + '/' + size + '.webp', en] : [en, ''];
}
const IMG_ERR = "var l=(this.dataset.fb||'').split('|').filter(Boolean);if(l.length){this.src=l.shift();this.dataset.fb=l.join('|')}else{this.style.visibility='hidden';var n=this.parentNode&&this.parentNode.querySelector('.fbn');if(n)n.style.display=''}";
function imgTag(base, size, cls, alt, extra = '', more = '') {
  // more: otra imagen de reserva (CollectHolo) por si TCGdex aún no tiene la de esta carta
  let [src, fb] = imgUrls(base, size);
  if (!src && more) [src, fb] = [more, ''];
  else if (more) fb = [fb, more].filter(Boolean).join('|');
  if (!src) return cls ? `<div class="${cls}"></div>` : '';
  return `<img ${cls ? `class="${cls}"` : ''} loading="lazy" alt="${esc(alt)}" src="${esc(src)}" data-fb="${esc(fb)}" onerror="${IMG_ERR}" ${extra}>`;
}

/* ---------- colección (localStorage) ---------- */
function loadCol() {
  try { const c = JSON.parse(localStorage.getItem(STORE_KEY)); if (c && c.cards) return Object.assign({ sealed: {}, alerts: {}, illustrators: {}, purchases: [], sell: {}, master: {}, extra: {} }, c); } catch (e) {}
  return { cards: {}, sealed: {}, alerts: {}, illustrators: {}, purchases: [], sell: {}, master: {}, extra: {} };
}
let COL = loadCol();
function saveCol() { COL.updatedAt = Date.now(); localStorage.setItem(STORE_KEY, JSON.stringify(COL)); if (typeof schedulePush === 'function') schedulePush(); }

/* ---------- base de datos (IndexedDB) ---------- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('9bolsillos', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) { const d = await idb(); return new Promise(r => { const g = d.transaction('files').objectStore('files').get(k); g.onsuccess = () => r(g.result); g.onerror = () => r(null); }); }
async function idbPut(k, v) { const d = await idb(); return new Promise((r, j) => { const t = d.transaction('files', 'readwrite'); t.objectStore('files').put(v, k); t.oncomplete = r; t.onerror = () => j(t.error); }); }
async function idbDel(k) { const d = await idb(); return new Promise(r => { const t = d.transaction('files', 'readwrite'); t.objectStore('files').delete(k); t.oncomplete = r; }); }

function openDb(bytes) {
  const db = new SQL.Database(new Uint8Array(bytes));
  const ok = db.exec("SELECT value FROM meta WHERE key='prices_date'");
  if (!ok.length) throw new Error('No parece la base de datos de 9Bolsillos');
  DB = db; PRICE_DATE = ok[0].values[0][0];
  HAS_HISTORY = db.exec("SELECT 1 FROM sqlite_master WHERE name='history'").length > 0;
  HAS_FOIL = db.exec("SELECT 1 FROM pragma_table_info('card_variants') WHERE name='foil'").length > 0;
  HAS_EXTRA = db.exec("SELECT 1 FROM sqlite_master WHERE name='cm_extra'").length > 0;
  if (!db.exec("SELECT 1 FROM pragma_table_info('cards') WHERE name='illustrator'").length) throw new Error('Base de datos antigua: carga la versión nueva (con ilustradores)');
}

/* ---------- precios ---------- */
// Precio de referencia de una variante: reverse usa el precio holo de Cardmarket
// Modo de precio elegido en Ajustes: 'trend' (tendencia) o 'low' (oferta más baja publicada)
let PRICE_MODE = (() => { try { return localStorage.getItem('9b.priceMode') || 'trend'; } catch (e) { return 'trend'; } })();
const PRICE_LABEL = () => PRICE_MODE === 'low' ? 'Oferta más baja en Cardmarket' : 'Tendencia en Cardmarket';
/* ---------- precio real: la oferta más baja que tú has visto en Cardmarket (Atajo «Precio a 9B») ---------- */
const REAL_DAYS = 45;   // a partir de aquí se considera antiguo y se vuelve a la tendencia
const realKey = (cm, rev) => cm + (rev ? '|r' : '');
const realOf = (cm, rev) => cm ? (COL.real || {})[realKey(cm, rev)] || null : null;
const realAge = r => r ? Math.max(0, Math.round((Date.now() - new Date(r.d + 'T12:00:00')) / 864e5)) : null;
const realFresh = r => r && realAge(r) <= REAL_DAYS;
const ageTxt = n => n === 0 ? 'hoy' : n === 1 ? 'ayer' : `hace ${n} días`;
function realLabel(r) { return r ? `Oferta más baja ${r.l || 'ES'} (${r.c === 'ANY' ? 'cualquier estado' : (r.c || 'NM') + ' o mejor'}) · ${ageTxt(realAge(r))}` : ''; }
// Guardar a mano la oferta más baja que ves en Cardmarket (vacío o 0 = quitar el precio real)
function saveReal(cm, rev, lang, txt) {
  const k = realKey(cm, rev), p = parseFloat(String(txt || '').replace(/\s|€/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  COL.real ||= {};
  if (!(p > 0)) { if (COL.real[k]) { delete COL.real[k]; saveCol(); toast('Precio real quitado'); } return false; }
  COL.real[k] = { p: Math.round(p * 100) / 100, d: todayISO(), l: lang, c: 'NM' }; saveCol(); toast('Precio real guardado: ' + eur(COL.real[k].p)); return true;
}
function askRealPrice(cm, rev, lang, after) { realSheet({ cm, rev, lang, after }, false); }
// Hoja para escribir el precio. Se abre sola al volver de Cardmarket (armAskReal) o con el botón ✏️
let ASK_REAL = null;
function armAskReal(cm, rev, lang) { if (cm) ASK_REAL = { cm, rev, lang, at: Date.now(), hash: location.hash }; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !ASK_REAL) return;
  const a = ASK_REAL; ASK_REAL = null;
  if (Date.now() - a.at > 20 * 60e3 || location.hash !== a.hash) return;
  setTimeout(() => realSheet(a, true), 350);
});
function realSheet(a, back) {
  document.querySelectorAll('.rsheet').forEach(x => x.remove());
  const cur = (COL.real || {})[realKey(a.cm, a.rev)], lg = a.lang === 'JP' ? 'japonés' : 'español';
  const d = document.createElement('div'); d.className = 'rsheet';
  d.innerHTML = `<div class="rsbox" role="dialog" aria-label="Precio real"><b style="font-size:18px">${back ? '¿Cuál era la oferta más baja?' : 'Precio real'}</b>
    <span class="muted">En ${lg}${a.rev ? ', reverse holo' : ''}, la más barata que has visto en Cardmarket.</span>
    <div class="row" style="gap:8px;align-items:center"><input id="rsin" type="text" inputmode="decimal" placeholder="Ej.: 115,00" value="${cur ? String(cur.p).replace('.', ',') : ''}" style="flex:1;font-size:22px"><b style="font-size:20px">€</b></div>
    <div class="row" style="gap:8px"><button class="btn" id="rsok" style="flex:1">Guardar</button><button class="btn sec" id="rsno">${back ? 'Ahora no' : 'Cancelar'}</button></div>
    ${cur ? '<button class="pill" id="rsdel" style="align-self:flex-start;font-size:13px">Quitar mi precio real</button>' : ''}</div>`;
  document.body.appendChild(d);
  const inp = d.querySelector('#rsin'), close = () => d.remove();
  const done = () => { if (a.after) a.after(); else if (DB && location.hash === a.hash) route(); };
  d.onclick = ev => { if (ev.target === d) close(); };
  d.querySelector('#rsno').onclick = close;
  d.querySelector('#rsok').onclick = () => { if (saveReal(a.cm, a.rev, a.lang, inp.value)) { close(); done(); } else inp.focus(); };
  inp.onkeydown = ev => { if (ev.key === 'Enter') d.querySelector('#rsok').click(); };
  const del = d.querySelector('#rsdel'); if (del) del.onclick = () => { saveReal(a.cm, a.rev, a.lang, ''); close(); done(); };
  try { inp.focus(); } catch (e) {}
}
function vPrice(v) {
  if (!v) return null;
  { const r = realOf(v.cm_product_id, isRevHolo(v)); if (realFresh(r)) return r.p; }
  if (isRevHolo(v)) return PRICE_MODE === 'low' ? (v.low_holo ?? v.trend_holo ?? v.avg30_holo ?? null) : (v.trend_holo ?? v.avg30_holo ?? v.low_holo ?? null);
  return PRICE_MODE === 'low' ? (v.low ?? v.trend ?? v.avg30 ?? null) : (v.trend ?? v.avg30 ?? v.low ?? null);
}
function rPrice(r) { return !r ? null : PRICE_MODE === 'low' ? (r.low ?? r.trend ?? r.avg30 ?? null) : (r.trend ?? r.avg30 ?? r.low ?? null); }
let HAS_FOIL = false, HAS_EXTRA = false;
const VSQL_ = () => `SELECT v.card_id, v.cm_product_id, v.variant, v.subtype, v.stamp, v.ambiguous,${HAS_FOIL ? ' v.foil, v.langs,' : ''}
  p.low, p.trend, p.avg, p.avg1, p.avg7, p.avg30, p.low_holo, p.trend_holo, p.avg7_holo, p.avg30_holo
  FROM card_variants v LEFT JOIN prices p ON p.cm_product_id = v.cm_product_id`;
function variantsOf(cardIds) {
  if (!cardIds.length) return {};
  const out = {};
  for (let i = 0; i < cardIds.length; i += 400) {
    const part = cardIds.slice(i, i + 400);
    q(`${VSQL_()} WHERE v.card_id IN (${part.map(() => '?').join(',')})`, part).forEach(v => (out[v.card_id] ||= []).push(v));
  }
  Object.values(out).forEach(markPatterns);
  return out;
}
// Tipos de foil que indica TCGdex (Poké Ball, Master Ball, cosmos…)
const FOILS = { pokeball: 'Poké Ball', masterball: 'Master Ball', greatball: 'Super Ball', ultraball: 'Ultra Ball', loveball: 'Love Ball', friendball: 'Friend Ball',
  quickball: 'Quick Ball', duskball: 'Dusk Ball', cosmos: 'Cosmos', tinsel: 'Tinsel', 'cracked-ice': 'Cracked Ice', energy: 'Energía', rainbow: 'Arcoíris', gold: 'Oro',
  league: 'Liga', galaxy: 'Galaxia', starlight: 'Starlight', mirror: 'Espejo', 'team-rocket': 'Team Rocket', glitter: 'Brillo', 'player-reward': 'Player Rewards', 'professor-program': 'Professor Program' };
// Una reverse comparte producto con la carta normal (precio "reverse" de ese producto) o tiene producto propio en Cardmarket (precio principal)
const isRevHolo = v => !!v && v.variant === 'reverse' && v.ownProduct !== true;
const PATTERNS = ['Poké Ball', 'Master Ball'];
function markPatterns(vs) {
  const shared = new Set(vs.filter(v => v.variant !== 'reverse').map(v => v.cm_product_id));
  const own = vs.filter(v => v.variant === 'reverse' && !shared.has(v.cm_product_id) && shared.size);
  own.forEach(v => { v.ownProduct = true; });
  if (!HAS_FOIL || !vs.some(v => v.foil)) own.sort((a, b) => a.cm_product_id - b.cm_product_id).forEach((v, i) => { v.pattern = PATTERNS[i] || ('patrón ' + (i + 1)); });
  vs.forEach(v => { if (v.foil) v.pattern = FOILS[v.foil] || v.foil; if (v.langs && !v.langs.split(',').includes('es')) v.notEs = true; });
}
const vLabel = v => [v.pattern ? (v.variant === 'reverse' ? 'Reverse ' : v.variant === 'holo' ? 'Holo ' : '') + v.pattern : v.variant === 'normal' ? 'Normal' : v.variant === 'reverse' ? 'Reverse holo' : v.variant === 'holo' ? 'Holo' : v.variant || 'Estándar',
  v.subtype, v.stamp].filter(Boolean).join(' · ');
/* ---------- copias: idioma, estado y gradeo de cada ejemplar ---------- */
const COPY_LANGS = ['ES', 'EN', 'JP', 'FR', 'DE', 'IT', 'PT', 'KO', 'ZH'];
const CONDS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];
const GRADERS = ['PSA', 'BGS', 'CGC', 'PCA', 'GradingClub', 'Otra'];
function copiesOf(id) {
  const e = COL.cards[id]; if (!e) return [];
  if (e.copies && e.copies.length) return e.copies;
  return Array.from({ length: e.qty || 1 }, () => ({ lang: null, cond: null, buy: e.buy ?? null }));
}
// Valor de tus copias: las gradeadas con valor puesto a mano cuentan ese valor; el resto, el precio de la carta
function cardValue(id, p) { return copiesOf(id).reduce((t, c) => t + (c.grader && c.gval != null ? c.gval : (p || 0)), 0); }
function cardCost(id, p) { let cost = 0, val = 0; copiesOf(id).forEach(c => { if (c.buy != null && (p != null || c.gval != null)) { cost += c.buy; val += c.grader && c.gval != null ? c.gval : p; } }); return [cost, val]; }
function copyBadge(id) {
  const cs = copiesOf(id).filter(c => c.lang || c.grader); if (!cs.length) return '';
  const g = cs.find(c => c.grader); return g ? `${g.grader} ${g.grade || ''}`.trim() : [...new Set(cs.map(c => c.lang))].join('/');
}
function cheapest(vs) { let b = null; (vs || []).forEach(v => { const p = vPrice(v); if (p != null && (b == null || p < b)) b = p; }); return b; }
function ownedVariant(cardId, vs) {
  const e = COL.cards[cardId]; if (!e) return null;
  return (vs || []).find(v => v.cm_product_id === e.cm && (v.variant || '') === (e.variant || '')) || (vs || []).find(v => v.cm_product_id === e.cm) || (vs || [])[0] || null;
}

/* ---------- historial ---------- */
function historyFor(ids) {
  if (!ids.length || !HAS_HISTORY) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    out.push(...q(`SELECT cm_product_id, day, trend_c, trend_holo_c FROM history WHERE cm_product_id IN (${part.map(() => '?').join(',')}) ORDER BY day`, part));
  }
  return out;
}
let CHART_PTS = [];
// Las demás gráficas (ficha de carta, sellado…) se activan solas al aparecer
new MutationObserver(() => document.querySelectorAll('#view .chartwrap:not([data-w])').forEach(w => wireChart(w))).observe(document.getElementById('view') || document.body, { childList: true, subtree: true });
// Tocar o arrastrar sobre la gráfica enseña el valor de ese día
function wireChart(root, onPoint) {
  const wrap = root && (root.classList && root.classList.contains('chartwrap') ? root : root.querySelector('.chartwrap')); if (!wrap || wrap.dataset.w) return; wrap.dataset.w = 1;
  const cur = wrap.querySelector('.cursor'), lab = cur.querySelector('span'), pts = JSON.parse(wrap.dataset.pts || '[]'); if (pts.length < 2) return;
  const show = ev => { const r = wrap.getBoundingClientRect(), x = Math.max(0, Math.min(r.width, (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left));
    const i = Math.round(x / r.width * (pts.length - 1)), p = pts[i]; cur.hidden = false; cur.style.left = (i / (pts.length - 1) * 100) + '%';
    lab.textContent = dayToStr(p[0]) + (onPoint ? '' : ' · ' + eur(p[1])); if (onPoint) onPoint(p, pts[0]); };
  const hide = () => { cur.hidden = true; if (onPoint) onPoint(null); };
  wrap.addEventListener('pointerdown', show); wrap.addEventListener('pointermove', ev => { if (ev.buttons || ev.pointerType !== 'mouse' || !cur.hidden) show(ev); });
  wrap.addEventListener('pointerleave', hide); wrap.addEventListener('pointerup', () => setTimeout(hide, 1200)); wrap.addEventListener('touchmove', show, { passive: true });
}
function chartSvg(points, w = 700, h = 180) {
  if (points.length < 2) {
    return `<div class="card muted" style="height:${h}px;display:flex;align-items:center;justify-content:center;text-align:center">El gráfico se irá llenando con los precios de cada día.<br>Ahora hay ${points.length} día de historial.</div>`;
  }
  const ys = points.map(p => p[1]); const mn = Math.min(...ys), mx = Math.max(...ys);
  const pad = 10, X = i => 4 + i / (points.length - 1) * (w - 8), Y = v => pad + (1 - (v - mn) / ((mx - mn) || 1)) * (h - pad * 2);
  const line = points.map((p, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join(' ');
  const up = ys[ys.length - 1] >= ys[0], col = up ? 'var(--up)' : 'var(--down)';
  CHART_PTS = points;
  return `<div class="chartwrap" data-pts='${JSON.stringify(points.map(p => [p[0], Math.round(p[1] * 100) / 100]))}'><svg class="chart" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="Evolución del valor">
    <path d="${line} L${X(points.length - 1)} ${h} L${X(0)} ${h} Z" fill="url(#cg)"/>
    <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${up ? '#3DDC97' : '#F2A65A'}" stop-opacity=".28"/><stop offset="1" stop-color="${up ? '#3DDC97' : '#F2A65A'}" stop-opacity="0"/></linearGradient></defs>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg><div class="cursor" hidden><span></span></div></div>
    <div class="between muted"><span>${dayToStr(points[0][0])}</span><span>${dayToStr(points[points.length - 1][0])}</span></div>`;
}

/* ---------- vistas ---------- */
let homePeriod = 30, homeMoves = 'up', topN = 8;
function viewHome() {
  const ids = Object.keys(COL.cards);
  const vmap = variantsOf(ids);
  let total = 0, n = 0, intV = 0, jpV = 0, cost = 0, costVal = 0;
  const owned = [];
  const regions = {};
  if (ids.length) q(`SELECT c.card_id, CASE WHEN s.lang='es' THEN 'int' ELSE 'asia' END region FROM cards c JOIN sets s USING(set_id) WHERE c.card_id IN (${ids.map(() => '?').join(',')})`, ids).forEach(r => regions[r.card_id] = r.region);
  ids.forEach(id => {
    const e = COL.cards[id], v = ownedVariant(id, vmap[id]), p = vPrice(v), qty = e.qty || 1;
    if (p != null || copiesOf(id).some(c => c.gval != null)) { const cv = cardValue(id, p); total += cv; regions[id] === 'asia' ? jpV += cv : intV += cv; }
    const [cc, cvv] = cardCost(id, p); cost += cc; costVal += cvv;
    n += qty; owned.push({ id, v, p, qty, e });
  });
  const sealedIds = Object.keys(COL.sealed).map(Number);
  let sealedV = 0;
  if (sealedIds.length) q(`SELECT cm_product_id, trend, avg30, low FROM prices WHERE cm_product_id IN (${sealedIds.map(() => '?').join(',')})`, sealedIds)
    .forEach(r => { const p = rPrice(r); if (p != null) sealedV += p * (COL.sealed[r.cm_product_id].qty || 1); });
  // Versiones extra del máster set
  const mids = Object.keys(COL.master || {});
  if (mids.length) { const mv = variantsOf(mids); mids.forEach(id => { uniqVariants(mv[id]).forEach(v => { if (COL.master[id][vkey(v)]) { const p = vPrice(v); if (p != null) { total += p; regions[id] === 'asia' ? jpV += p : intV += p; } } }); }); }
  // Cartas extra vía Cardmarket (japonesas que faltan en la base de datos)
  const xids = Object.keys(COL.extra || {}).map(Number);
  if (HAS_EXTRA && xids.length) q(`SELECT cm_product_id, trend, avg30, low FROM prices WHERE cm_product_id IN (${xids.map(() => '?').join(',')})`, xids)
    .forEach(r => { const p = rPrice(r); if (p != null) { const v = p * (COL.extra[r.cm_product_id].qty || 1); total += v; jpV += v; } });
  xids.forEach(x => n += (COL.extra[x].qty || 1));
  total += sealedV;

  // historial del portfolio
  const hist = historyFor([...new Set(owned.filter(o => o.v).map(o => o.v.cm_product_id).concat(sealedIds, xids))]);
  const byDay = {};
  const want = {}; owned.forEach(o => { if (o.v) (want[o.v.cm_product_id] ||= []).push(o); });
  hist.forEach(h => {
    let s = 0;
    (want[h.cm_product_id] || []).forEach(o => { const c = isRevHolo(o.v) ? h.trend_holo_c : h.trend_c; if (c != null) s += c / 100 * o.qty; });
    if (COL.sealed[h.cm_product_id] && h.trend_c != null) s += h.trend_c / 100 * (COL.sealed[h.cm_product_id].qty || 1);
    if (COL.extra && COL.extra[h.cm_product_id] && h.trend_c != null) s += h.trend_c / 100 * (COL.extra[h.cm_product_id].qty || 1);
    byDay[h.day] = (byDay[h.day] || 0) + s;
  });
  let days = Object.keys(byDay).map(Number).sort();
  if (homePeriod) { const last = days[days.length - 1]; if (last) { const d = new Date(String(last).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')); d.setDate(d.getDate() - homePeriod); const lim = +d.toISOString().slice(0, 10).replace(/-/g, ''); days = days.filter(x => x >= lim); } }
  const pts = days.map(d => [d, byDay[d]]);
  let change = '';
  if (pts.length >= 2) { const a = pts[0][1], b = pts[pts.length - 1][1], d = b - a; change = `<div class="${d >= 0 ? 'up' : 'down'}" style="font-weight:600">${d >= 0 ? '+' : '−'}${eur(Math.abs(d))} (${pct(a ? d / a * 100 : 0)}) desde el ${dayToStr(pts[0][0])}</div>`; }
  else if (cost) { const d = costVal - cost; change = `<div class="${d >= 0 ? 'up' : 'down'}" style="font-weight:600">${d >= 0 ? '+' : '−'}${eur(Math.abs(d))} (${pct(d / cost * 100)}) en las cartas con precio de compra</div>`; }

  // mayores subidas: precio actual vs media de 30 días (hasta tener historial)
  // Variación de cada carta: contra su precio al inicio del periodo (si hay historial) o contra su media de 30 días
  const lim = pts.length ? pts[0][0] : 0, firstP = {};
  hist.forEach(h => { if (h.day >= lim && firstP[h.cm_product_id] == null) firstP[h.cm_product_id] = h; });
  const useHist = days.length >= 2;
  const allMoves = owned.filter(o => o.v && o.p != null).map(o => {
    const h0 = firstP[o.v.cm_product_id], hc = h0 ? (isRevHolo(o.v) ? h0.trend_holo_c : h0.trend_c) : null;
    const base = useHist && hc ? hc / 100 : (isRevHolo(o.v) ? o.v.avg30_holo : o.v.avg30);
    return Object.assign(o, { ch: base ? (o.p - base) / base * 100 : null, chE: base ? (o.p - base) * o.qty : null });
  }).filter(o => o.ch != null && o.p >= 1 && Math.abs(o.ch) >= 0.05);
  const movers = (homeMoves === 'down' ? allMoves.filter(o => o.ch < 0).sort((a, b) => a.ch - b.ch)
    : homeMoves === 'abs' ? allMoves.slice().sort((a, b) => Math.abs(b.chE) - Math.abs(a.chE))
    : allMoves.filter(o => o.ch > 0).sort((a, b) => b.ch - a.ch)).slice(0, 8);
  const moveTitle = { up: 'Mayores subidas', down: 'Mayores bajadas', abs: 'Mayor variación en €' }[homeMoves];
  const moveBase = useHist ? `desde el ${dayToStr(lim)}` : 'vs media 30 días';
  // Tus cartas más valiosas (precio × copias)
  const top = owned.filter(o => o.v && o.p != null).map(o => Object.assign({}, o, { tv: cardValue(o.id, o.p), badge: copyBadge(o.id) })).sort((a, b) => b.tv - a.tv).slice(0, topN);
  const names = {};
  const nameIds = [...new Set(movers.map(m => m.id).concat(top.map(t => t.id)))];
  if (nameIds.length) q(`SELECT c.card_id, COALESCE(c.name_es,c.name_en,c.name_ja,c.name_local) name, c.local_id, c.image_base, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name FROM cards c JOIN sets s USING(set_id) WHERE c.card_id IN (${nameIds.map(() => '?').join(',')})`, nameIds).forEach(r => names[r.card_id] = r);

  const alertsHit = alertStatus().filter(a => a.hit && !alertSeen(a)).length;   // las que ya has visto en Deseos no vuelven a avisar (salvo que bajen más)
  const periods = [[7, '1S'], [30, '1M'], [90, '3M'], [365, '1A'], [0, 'Todo']];
  $view.innerHTML = `<div class="stack">
    <div class="between"><div class="row" style="gap:10px"><img src="icon-192.png" alt="" width="34" height="34" style="border-radius:9px"><h1>9Bolsillos</h1></div><a class="iconbtn" href="#/settings" aria-label="Ajustes">${ico('gear', 20)}</a></div>
    ${calBanner()}
    ${alertsHit ? `<a class="alertbox" href="#/wish" style="color:var(--tx)"><b class="up">${alertsHit} alerta${alertsHit > 1 ? 's' : ''} de precio</b> ${alertsHit > 1 ? 'han saltado' : 'ha saltado'}. Ver →</a>` : ''}
    <div class="herocard"><div class="col"><span class="hk">Valor de tu colección</span>
      <div class="big" id="hval">${eur(total)}</div><div id="hchg">${change}</div>
      <span class="muted">${n} carta${n === 1 ? '' : 's'}${sealedIds.length ? ` · ${sealedIds.length} producto${sealedIds.length > 1 ? 's' : ''} sellado${sealedIds.length > 1 ? 's' : ''}` : ''}${cost ? ` · pagaste ${eur(cost)} por las que tienen precio de compra` : ''} · precios del ${PRICE_DATE.split('-').reverse().join('/')}</span></div>
    <div class="col" style="gap:10px" id="hchart">${chartSvg(pts)}
      <div class="seg segfull">${periods.map(([d, l]) => `<button class="${homePeriod === d ? 'on' : ''}" data-p="${d}">${l}</button>`).join('')}</div></div></div>
    <div class="quick">
      <a href="#/buy">${ico('cart', 20)}<span>Qué comprar</span></a>
      <a href="#/scan">${ico('camera', 20)}<span>Escanear</span></a>
      <a href="#/calendario">${ico('calendar', 20)}<span>Lanzamientos</span></a>
      <a href="#/stats">${ico('stats', 20)}<span>Números</span></a></div>
    ${total ? `<div class="card col" style="gap:10px"><b>Reparto</b>
      <div class="bar" style="display:flex;gap:2px;background:none">${[[intV, 'var(--up)'], [jpV, 'var(--down)'], [sealedV, 'var(--blue)']].filter(x => x[0] > 0).map(x => `<div style="width:${x[0] / total * 100}%;background:${x[1]};border-radius:3px"></div>`).join('')}</div>
      <div class="row muted" style="gap:18px;flex-wrap:wrap"><span>Español/inglés <b style="color:var(--tx)">${eur(intV)}</b></span><span>Japonés y otros <b style="color:var(--tx)">${eur(jpV)}</b></span><span>Sellado <b style="color:var(--tx)">${eur(sealedV)}</b></span></div></div>` : ''}
    ${top.length ? `<div class="col" style="gap:8px"><div class="between"><h2>Tus cartas más valiosas</h2>${owned.length > 8 ? `<button class="pill" id="topmore">${topN > 8 ? 'Ver menos' : 'Ver 25'}</button>` : ''}</div>
      <div class="list">${top.map((t, i) => { const r = names[t.id] || {}; return `<a class="item" href="#/card/${encodeURIComponent(t.id)}"><span class="muted" style="width:22px;text-align:right;font-weight:700">${i + 1}</span>${img(r.image_base, 'thumb', '', t.id)}<div class="col" style="flex:1"><b>${esc(r.name)} · ${esc(r.local_id)}</b><span class="muted">${esc(r.set_name)} · ${esc(vLabel(t.v))}${t.qty > 1 ? ' · ' + t.qty + ' uds' : ''}${t.badge ? ' · ' + esc(t.badge) : ''}</span></div><div class="col" style="align-items:flex-end"><b>${eur(t.tv)}</b>${t.qty > 1 ? `<span class="muted" style="font-size:12px">${eur(t.p)}/ud</span>` : ''}</div></a>`; }).join('')}</div></div>` : ''}
    ${allMoves.length ? `<div class="col" style="gap:8px"><div class="between" style="flex-wrap:wrap;gap:8px"><h2>${moveTitle} <span class="muted">(${moveBase})</span></h2>
      <div class="pills">${[['up', 'Subidas'], ['down', 'Bajadas'], ['abs', 'Variación €']].map(([k, l]) => `<button class="pill ${homeMoves === k ? 'on' : ''}" data-mv2="${k}">${l}</button>`).join('')}</div></div>
      <div class="list">${movers.map(m => {
      const r = names[m.id] || {}; return `<a class="item" href="#/card/${encodeURIComponent(m.id)}">${img(r.image_base, 'thumb', '', m.id)}<div class="col" style="flex:1"><b>${esc(r.name)} · ${esc(r.local_id)}</b><span class="muted">${esc(r.set_name)}${m.qty > 1 ? ' · ' + m.qty + ' uds' : ''}</span></div><div class="col" style="align-items:flex-end"><b>${eur(m.p)}</b><span class="${m.ch >= 0 ? 'up' : 'down'}" style="font-size:13px">${pct(m.ch)} · ${m.chE >= 0 ? '+' : '−'}${eur(Math.abs(m.chE))}</span></div></a>`;
    }).join('') || `<p class="muted">Ninguna carta tuya ${homeMoves === 'down' ? 'ha bajado' : 'ha subido'} en este periodo.</p>`}</div></div>` : ''}
    ${!ids.length && !sealedIds.length ? `<div class="card col" style="gap:10px"><b>Empieza tu colección</b><span class="muted">Entra en Colección, abre un set y toca el botón ＋ de cada carta que tengas.</span><a class="btn" style="display:flex;align-items:center;justify-content:center" href="#/sets">Ver sets</a></div>` : ''}
  </div>`;
  $view.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { homePeriod = +b.dataset.p; viewHome(); });
  { const hv = document.getElementById('hval'), hc = document.getElementById('hchg'), v0 = hv.textContent, c0 = hc.innerHTML;
    wireChart(document.getElementById('hchart'), (p, first) => { if (!p) { hv.textContent = v0; hc.innerHTML = c0; return; }
      const d = p[1] - first[1]; hv.textContent = eur(p[1]); hc.innerHTML = `<div class="${d >= 0 ? 'up' : 'down'}" style="font-weight:600">${d >= 0 ? '+' : '−'}${eur(Math.abs(d))} (${pct(first[1] ? d / first[1] * 100 : 0)}) · ${dayToStr(p[0])}</div>`; }); }
  $view.querySelectorAll('[data-mv2]').forEach(b => b.onclick = () => { homeMoves = b.dataset.mv2; viewHome(); });
  const tm = document.getElementById('topmore'); if (tm) tm.onclick = () => { topN = topN > 8 ? 8 : 25; viewHome(); };
}

const LANGS = { es: 'Español / inglés', ja: 'Japonés', ko: 'Coreano', 'zh-tw': 'Chino (trad.)', 'zh-cn': 'Chino (simpl.)', id: 'Indonesio', th: 'Tailandés' };
const NAME = 'COALESCE(c.name_es,c.name_en,c.name_ja,c.name_local)';

let setsFilter = 'es', setsQuery = '';
const SETS_LANG = 'es', ILL_LANG = 'ja';
const isMasterSet = id => (COL.setMode || {})[id] === 'master';
// Progreso del máster set: versiones que tienes de todas las que cuentan en ese set
function masterProgress(setId) {
  const cards = q(`SELECT c.card_id, c.set_id, (c.name_es IS NULL AND s.lang='es' AND s.release_date >= '2019') no_es FROM cards c JOIN sets s USING(set_id) WHERE c.set_id=?`, [setId]).filter(c => !hiddenCard(c));
  const vm = variantsOf(cards.map(c => c.card_id));
  let have = 0, total = 0;
  cards.forEach(c => { const ks = ownedKeys(c.card_id, vm[c.card_id]);
    uniqVariants(vm[c.card_id]).filter(v => !(v && v.stamp) && !hiddenVariant(c, v)).forEach(v => { total++; if (ks.has(vkey(v))) have++; }); });
  return { have, total };
}
function viewSets() {
  if (setsFilter !== 'mine') setsFilter = 'es';
  const rows = q(`SELECT s.set_id, s.lang, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) name, s.serie, s.release_date,
    (SELECT COUNT(*) FROM cards c WHERE c.set_id = s.set_id) n, (SELECT image_base FROM cards c WHERE c.set_id = s.set_id LIMIT 1) ib
    FROM sets s WHERE n > 0 ORDER BY s.release_date DESC, s.set_id`);
  const ownCount = {}; Object.values(COL.cards).forEach(e => ownCount[e.set] = (ownCount[e.set] || 0) + 1);
  const draw = () => {
    const ql = setsQuery.toLowerCase();
    // Colecciones por set: solo en español (SETS_LANG). Los ilustradores van en japonés (ILL_LANG).
    const okLang = r => r.lang === SETS_LANG && (setsFilter !== 'mine' || ownCount[r.set_id]);
    const list = rows.filter(r => okLang(r) && (!ql || (r.name || '').toLowerCase().includes(ql) || (r.serie || '').toLowerCase().includes(ql)));
    document.getElementById('setlist').innerHTML = list.map(r => {
      const m = isMasterSet(r.set_id), mp = m ? masterProgress(r.set_id) : null;
      const o = m ? mp.have : ownCount[r.set_id] || 0, tot = m ? mp.total : r.n, p = tot ? Math.round(o / tot * 100) : 0;
      const tag = m ? `<span class="modetag master">${ico('crown', 11)} Máster</span>` : (ownCount[r.set_id] ? '<span class="modetag">Básico</span>' : '');
      return `<a class="setrow ${m ? 'master' : ''}" href="#/set/${encodeURIComponent(r.set_id)}"><div class="logobox">${setLogo(r.ib, 'setlogo', r.name, r.set_id)}${m ? `<span class="crown">${ico('crown', 12)}</span>` : ''}</div><div class="col" style="flex:1;min-width:0;gap:3px"><div class="row" style="gap:6px;min-width:0"><b class="ell">${esc(r.name)}</b>${tag}</div><span class="muted ell">${esc(r.serie)} · ${r.release_date ? esc(r.release_date.slice(0, 4)) : ''}${setsFilter === 'otros' || setsFilter === 'mine' ? ' · ' + esc(LANGS[r.lang] || r.lang) : ''}</span>
        <div class="between" style="gap:8px;margin-top:3px"><div class="bar thin" style="flex:1"><div style="width:${p}%"></div></div><span class="cnt ${o ? 'has' : ''}">${o ? `${o}/${tot}` : tot}</span></div></div></a>`;
    }).join('') || '<p class="muted">No hay sets que coincidan.</p>';
  };
  $view.innerHTML = `<div class="stack"><div class="between"><h1>Colección</h1><a class="pill" style="display:flex;align-items:center" href="#/illustrators">Ilustradores →</a></div>
    <input type="search" id="sq" placeholder="Buscar set…" value="${esc(setsQuery)}">
    <div class="pills">${[['es', 'Todos los sets'], ['mine', 'Mis sets']].map(([k, l]) => `<button class="pill ${setsFilter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    <div class="list" id="setlist"></div></div>`;
  document.getElementById('sq').oninput = e => { setsQuery = e.target.value; draw(); };
  $view.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { setsFilter = b.dataset.f; viewSets(); });
  draw();
}

/* ---------- navegador de cartas compartido: cuadrícula o álbum de 9 bolsillos ---------- */
let browseFilter = 'all', browseMode = 'grid';
const SORT = { set: 'num', ill: 'old' };
const SORTS = { set: [['num', 'Número'], ['price_desc', 'Precio: mayor primero'], ['price_asc', 'Precio: menor primero'], ['name', 'Nombre']],
  ill: [['old', 'Lanzamiento: antiguas primero'], ['new', 'Lanzamiento: recientes primero'], ['price_desc', 'Precio: mayor primero'], ['price_asc', 'Precio: menor primero'], ['name', 'Nombre']] };
const albumPage = {}, albumAnim = {};
// Pasar páginas del álbum deslizando el dedo: a la izquierda avanza y a la derecha vuelve, como una carpeta.
// Las flechas del teclado también pasan página en el ordenador.
let pageTurn = null;
function swipePages(el, turn) {
  pageTurn = turn;
  let x0 = null, y0 = 0, t0 = 0;
  el.ontouchstart = e => { if (e.touches.length !== 1) { x0 = null; return; } x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); };
  el.ontouchend = e => {
    if (x0 == null) return; const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0; x0 = null;
    if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.4 || Date.now() - t0 > 800) return;
    const stop = ev => { ev.stopPropagation(); ev.preventDefault(); };   // que el gesto no abra la carta que tenías debajo
    el.addEventListener('click', stop, { capture: true, once: true }); setTimeout(() => el.removeEventListener('click', stop, { capture: true }), 400);
    turn(dx < 0 ? 1 : -1);
  };
}
document.addEventListener('keydown', e => {
  if (!pageTurn || !document.querySelector('.spread') || /INPUT|SELECT|TEXTAREA/.test((e.target || {}).tagName || '')) return;
  if (e.key === 'ArrowRight') pageTurn(1); else if (e.key === 'ArrowLeft') pageTurn(-1);
});
/* ---------- máster set: cada versión (normal, reverse, 1ª edición…) cuenta aparte ---------- */
let MASTER = false;
// Mostrar o no lo que no existe en español (cartas solo inglesas, versiones de otros idiomas, lo que ocultes a mano)
let SHOW_NON_ES = (() => { try { return localStorage.getItem('9b.showNonEs') === '1'; } catch (e) { return false; } })();
const hiddenCard = c => !SHOW_NON_ES && ((COL.hide || {})[c.card_id] || c.no_es);
const hiddenVariant = (c, v) => !SHOW_NON_ES && v && ((COL.hide || {})[c.card_id + '|' + vkey(v)] || v.notEs || ((COL.setHide || {})[c.set_id] || []).includes(vLabel(v)));
const vkey = v => v ? `${v.cm_product_id}|${v.variant || ''}|${v.subtype || ''}|${v.stamp || ''}` : 'std';
function uniqVariants(vs) { const seen = new Set(), out = []; (vs || []).forEach(v => { const k = vkey(v); if (!seen.has(k)) { seen.add(k); out.push(v); } }); return out.length ? out : [null]; }
function ownedKeys(id, vs) {
  const ks = new Set(Object.keys((COL.master || {})[id] || {}));
  if (COL.cards[id]) ks.add(vkey(ownedVariant(id, vs)));
  return ks;
}
function toggleVariant(id, setId, v, vs) {
  const k = vkey(v), ks = ownedKeys(id, vs), base = COL.cards[id] ? vkey(ownedVariant(id, vs)) : null;
  COL.master ||= {};
  if (ks.has(k)) {
    if (k === base) {
      delete COL.cards[id];
      const rest = Object.keys(COL.master[id] || {});
      if (rest.length) { const nv = uniqVariants(vs).find(x => vkey(x) === rest[0]); COL.cards[id] = { set: setId, cm: nv ? nv.cm_product_id : null, variant: nv ? nv.variant : null, qty: 1 }; delete COL.master[id][rest[0]]; }
    } else delete COL.master[id][k];
    if (COL.master[id] && !Object.keys(COL.master[id]).length) delete COL.master[id];
  } else if (!COL.cards[id]) COL.cards[id] = { set: setId, cm: v ? v.cm_product_id : null, variant: v ? v.variant : null, qty: 1 };
  else (COL.master[id] ||= {})[k] = 1;
  saveCol();
}
/* ---------- Archivador real: dónde va cada carta en tus páginas de 9 bolsillos ---------- */
// COL.binders[clave] = { off: bolsillos libres al principio, keys: orden de la última vez que lo recolocaste }
const binderCfg = akey => ((COL.binders ||= {})[akey] ||= { off: 0 });
function binderSpot(akey, idx) { const n = idx + (((COL.binders || {})[akey] || {}).off || 0), s = n % 9; return { page: Math.floor(n / 9) + 1, row: Math.floor(s / 3) + 1, col: s % 3 + 1 }; }
const spotTxt = s => `página ${s.page} · fila ${s.row} · bolsillo ${s.col}`;
// Orden físico de un set: por número, sin lo que tienes oculto
function setBinderIds(setId) {
  return q(`SELECT c.card_id, (c.name_es IS NULL AND s.lang='es' AND s.release_date >= '2019') no_es FROM cards c JOIN sets s USING(set_id) WHERE c.set_id=?
    ORDER BY CAST(c.local_id AS INTEGER), c.local_id`, [setId]).filter(c => !hiddenCard(c)).map(c => c.card_id);
}
function binderChanges(akey, ids, label) {
  const cfg = binderCfg(akey);
  if (!cfg.keys) { cfg.keys = ids; saveCol(); return ''; }
  const old = cfg.keys; if (old.length === ids.length && old.every((k, i) => k === ids[i])) return '';
  let f = 0; while (f < old.length && f < ids.length && old[f] === ids[f]) f++;
  const was = new Set(old), now = new Set(ids), add = ids.filter(k => !was.has(k)), gone = old.filter(k => !now.has(k)), d = ids.length - old.length, sp = binderSpot(akey, f);
  return `<div class="card col binderchg" style="gap:6px;border:1px solid var(--accent, #3DDC97)"><b>📒 Tu archivador ha cambiado</b>
    ${add.length ? `<span>Entran ${add.length}: ${add.slice(0, 6).map(k => `${esc(label(k))} → <b>${spotTxt(binderSpot(akey, ids.indexOf(k)))}</b>`).join('; ')}${add.length > 6 ? '…' : ''}</span>` : ''}
    ${gone.length ? `<span>Salen ${gone.length}: ${gone.slice(0, 6).map(k => esc(label(k))).join(', ')}${gone.length > 6 ? '…' : ''}</span>` : ''}
    <span class="muted">Desde la ${spotTxt(sp)}, ${d > 0 ? `todo avanza ${d} bolsillo${d === 1 ? '' : 's'}` : d < 0 ? `todo retrocede ${-d} bolsillo${d === -1 ? '' : 's'}` : 'cambian cartas de sitio'}.</span>
    <button class="pill" data-binderok style="align-self:flex-start">Ya lo he recolocado</button></div>`;
}
// Pinta las páginas del álbum. binder: true si es tu archivador físico (sets y Mi orden)
function renderBinder({ akey, E, tile, el, draw, ids, label }) {
  const off = ids ? (binderCfg(akey).off || 0) : 0, total = E.length + off;
  const pages = Math.max(1, Math.ceil(total / 9)), per = window.innerWidth >= 760 ? 2 : 1;
  let pg = albumPage[akey] || 0; pg = Math.min(pg - pg % per, (pages - 1) - (pages - 1) % per); albumPage[akey] = pg;
  let html = (ids ? binderChanges(akey, ids, label) : '') + `<div class="between pgnav"><button class="pill pgbtn" data-pg="-1" ${pg === 0 ? 'disabled' : ''} aria-label="Página anterior">←</button>
    <span class="pgtxt">Página ${pg + 1}${per === 2 && pg + 2 <= pages ? '–' + (pg + 2) : ''} de ${pages}</span>
    <button class="pill pgbtn" data-pg="1" ${pg + per >= pages ? 'disabled' : ''} aria-label="Página siguiente">→</button></div><div class="spread ${albumAnim[akey] || ''}">`;
  for (let k = pg; k < Math.min(pg + per, pages); k++) {
    html += `<div class="page"><div class="pgnum">Página ${k + 1}</div><div class="pockets">`;
    for (let i = 0; i < 9; i++) { const n = k * 9 + i, idx = n - off, e = E[idx];
      html += n < off ? '<div class="tile empty reserved"><div class="img"><span class="fbn">Libre</span></div></div>' : e ? tile(e, idx, `Página ${k + 1}, fila ${Math.floor(i / 3) + 1}, bolsillo ${i % 3 + 1}`) : '<div class="tile empty"><div class="img"></div></div>'; }
    html += '</div></div>';
  }
  if (ids) html += `<button class="pill" data-boff style="font-size:13px;margin-top:10px">Bolsillos libres al principio: ${off} · cambiar</button>`;
  el.innerHTML = html + '</div>';
  const turn = d => { const nx = (albumPage[akey] || 0) + d * per; if (nx < 0 || nx >= pages) return; albumPage[akey] = nx; albumAnim[akey] = d > 0 ? 'fromR' : 'fromL'; draw(); albumAnim[akey] = ''; };
  el.querySelectorAll('[data-pg]').forEach(b => b.onclick = () => turn(+b.dataset.pg));
  const ok = el.querySelector('[data-binderok]'); if (ok) ok.onclick = () => { binderCfg(akey).keys = ids; saveCol(); draw(); };
  const bo = el.querySelector('[data-boff]'); if (bo) bo.onclick = () => { const v = prompt('¿Cuántos bolsillos dejas libres al principio del archivador (portada, logo, una carta especial…)?', off); if (v === null) return;
    binderCfg(akey).off = Math.max(0, Math.min(99, parseInt(v, 10) || 0)); saveCol(); draw(); };
  swipePages(el, turn);
}
function cardBrowser(key, cards0, vmap, el, headEl, opts = {}) {
  const kind = opts.kind || 'set', mode = SORT[kind];
  const pr = c => { const p = COL.cards[c.card_id] ? vPrice(ownedVariant(c.card_id, vmap[c.card_id])) : cheapest(vmap[c.card_id]); return p ?? -1; };
  const num = c => [parseInt(c.local_id, 10) || 0, c.local_id || ''];
  const byRel = (a, b) => (a.release_date || '').localeCompare(b.release_date || '') || (a.set_id || '').localeCompare(b.set_id || '') || num(a)[0] - num(b)[0];
  const cards = cards0.filter(c => !hiddenCard(c)).sort(mode === 'new' ? (a, b) => byRel(b, a) : mode === 'old' ? byRel : mode === 'price_desc' ? (a, b) => pr(b) - pr(a) : mode === 'price_asc' ? (a, b) => (pr(a) < 0) - (pr(b) < 0) || pr(a) - pr(b) : mode === 'name' ? (a, b) => (a.name || '').localeCompare(b.name || '', 'es') : (a, b) => num(a)[0] - num(b)[0] || num(a)[1].localeCompare(num(b)[1]));
  // Entradas: una por carta (set básico) o una por versión (máster set)
  const numSort = (a, b) => num(a)[0] - num(b)[0] || num(a)[1].localeCompare(num(b)[1]);
  const physical = kind === 'set';   // un set es un archivador: en álbum siempre va por número
  const entries = (list = (physical && browseMode === 'album' ? cards.slice().sort(numSort) : cards)) => MASTER
    ? list.flatMap(c => uniqVariants(vmap[c.card_id]).filter(v => !(v && v.stamp) && !hiddenVariant(c, v)).map(v => ({ c, v, k: vkey(v) })))
    : list.map(c => ({ c, v: null, k: null }));
  const ekey = e => e.c.card_id + (e.k ? '|' + e.k : '');
  const akey = key + (MASTER ? ':m' : '');
  const owns = e => e.k ? ownedKeys(e.c.card_id, vmap[e.c.card_id]).has(e.k) : !!COL.cards[e.c.card_id];
  const priceOf = e => e.k ? vPrice(e.v) : (COL.cards[e.c.card_id] ? vPrice(ownedVariant(e.c.card_id, vmap[e.c.card_id])) : cheapest(vmap[e.c.card_id]));
  const draw = () => {
    const E = entries();
    LIST_CTX = [...new Set(E.map(e => '#/card/' + encodeURIComponent(e.c.card_id)))];
    let have = 0, missCost = 0, val = 0;
    E.forEach(e => { const p = priceOf(e) || 0; if (owns(e)) { have++; val += e.k ? p : cardValue(e.c.card_id, p); } else missCost += p; });
    const p = E.length ? have / E.length * 100 : 0;
    headEl.innerHTML = `<div class="between"><b>${MASTER ? 'Máster set: ' : ''}Tienes ${have} de ${E.length}${MASTER ? ' versiones' : ''}</b><b class="up" style="font-size:22px">${Math.round(p)} %</b></div>
      <div class="bar"><div style="width:${p}%"></div></div>
      <div class="between muted" style="flex-wrap:wrap"><span>Tu parte vale <b style="color:var(--tx)">${eur(val)}</b></span><span>Completarlo hoy: <b style="color:var(--tx)">${eur(missCost)}</b></span></div>
      ${MASTER ? '' : bulkAlertButton(key)}`;
    const bb = headEl.querySelector('[data-bulk]'); if (bb) bb.onclick = () => bulkAlerts(key, cards.filter(c => !COL.cards[c.card_id]).map(c => { const v = (vmap[c.card_id] || []).slice().sort((a, b) => (vPrice(a) ?? 1e9) - (vPrice(b) ?? 1e9))[0]; return v && vPrice(v) ? { key: v.cm_product_id + '|' + (v.variant || ''), card: c.card_id, cm: v.cm_product_id, variant: v.variant, price: vPrice(v), name: c.name } : null; }).filter(Boolean), draw);
    const tile = (e, i, pocket) => {
      const c = e.c, has = owns(e), pr = priceOf(e);
      const vl = e.k ? (e.v ? vLabel(e.v) : 'Estándar') : '';
      return `<div class="tile ${has ? 'has' : 'miss'}" data-open="${esc(c.card_id)}" title="${pocket ? esc(pocket) : ''}">
        <div class="img"><span class="fbn" ${c.image_base || CUSTOM_IMG[c.card_id] ? 'style="display:none"' : ''}>${esc(c.name)}</span>${cardImg(c, 'low', '', '')}
          ${e.v && e.v.pattern ? `<span class="vtag">${esc(e.v.pattern)}</span>` : e.v && e.v.variant === 'reverse' ? '<span class="vtag">Reverse</span>' : e.k && e.v && e.v.stamp ? `<span class="vtag">${esc(e.v.stamp)}</span>` : ''}
          <button class="own" data-own="${i}" aria-label="${has ? 'Quitar de' : 'Añadir a'} mi colección: ${esc(c.name)} ${esc(vl)}">${has ? '✓' : '＋'}</button></div>
        <span class="num">${esc(opts.sub ? opts.sub(c) : c.local_id)}</span>
        <span class="nm">${esc(c.name)}</span>${vl ? `<span class="num" style="font-weight:600">${esc(vl)}</span>` : ''}<span class="pr">${eur(pr)}</span></div>`;
    };
    if (browseMode === 'album') {
      const byKey = {}; E.forEach(e => byKey[ekey(e)] = e);
      renderBinder({ akey, E, tile, el, draw, ids: physical ? E.map(ekey) : null, label: k => { const e = byKey[k]; return e ? `${e.c.local_id} ${e.c.name}${e.k && e.v ? ' (' + vLabel(e.v) + ')' : ''}` : k; } });
    } else {
      const idx = E.map((e, i) => i).filter(i => browseFilter === 'all' || (browseFilter === 'have' ? owns(E[i]) : !owns(E[i])));
      el.innerHTML = `<div class="grid">${idx.map(i => tile(E[i], i)).join('')}</div>` + (idx.length ? '' : '<p class="muted">Nada que mostrar con este filtro.</p>');
    }
    el.querySelectorAll('[data-own]').forEach(b => b.onclick = ev => {
      ev.stopPropagation(); const e = E[+b.dataset.own], id = e.c.card_id;
      if (e.k) toggleVariant(id, e.c.set_id, e.v, vmap[id]);
      else {
        if (COL.cards[id]) { delete COL.cards[id]; if (COL.master) delete COL.master[id]; }
        else { const v = (vmap[id] || []).slice().sort((a, b) => (vPrice(a) ?? 1e9) - (vPrice(b) ?? 1e9))[0]; COL.cards[id] = { set: e.c.set_id, cm: v ? v.cm_product_id : null, variant: v ? v.variant : null, qty: 1 }; }
        saveCol();
      }
      if (physical && owns(e)) { const i = entries(cards.slice().sort(numSort)).findIndex(x => ekey(x) === ekey(e)); if (i >= 0) toast('📒 Va en la ' + spotTxt(binderSpot(akey, i))); }
      draw();
    });
    el.querySelectorAll('[data-open]').forEach(t => t.onclick = () => location.hash = '#/card/' + encodeURIComponent(t.dataset.open));
  };
  return draw;
}
// Control segmentado compacto: un grupo de opciones que se ven como una sola pieza
const seg = (attr, opts, cur) => `<div class="seg" role="group">${opts.map(([k, l]) => `<button class="${String(cur) === String(k) ? 'on' : ''}" data-${attr}="${k}" aria-pressed="${String(cur) === String(k)}">${l}</button>`).join('')}</div>`;
function browserControls(kind = 'set', extra = '') {
  return `<div class="toolbar">
    <div class="tbrow">${kind === 'none' ? '' : seg('ms', [[false, 'Básico'], [true, 'Máster']], MASTER)}${seg('bm', [['grid', 'Cuadrícula'], ['album', 'Álbum']], browseMode)}</div>
    <div class="tbrow">${browseMode === 'grid' ? seg('sf', [['all', 'Todas'], ['have', 'Tengo'], ['miss', 'Faltan']], browseFilter) : '<span></span>'}
      ${kind === 'none' ? '' : `<label class="sortsel"><span class="sr">Ordenar</span><select data-sort="${kind}" aria-label="Ordenar">${SORTS[kind].map(([k, l]) => `<option value="${k}" ${SORT[kind] === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`}${extra}</div></div>`;
}
function wireControls(rerender) {
  $view.querySelectorAll('[data-bm]').forEach(b => b.onclick = () => { browseMode = b.dataset.bm; rerender(); });
  $view.querySelectorAll('[data-sf]').forEach(b => b.onclick = () => { browseFilter = b.dataset.sf; rerender(); });
  $view.querySelectorAll('[data-sort]').forEach(s => s.onchange = () => { SORT[s.dataset.sort] = s.value; rerender(); });
  $view.querySelectorAll('[data-ms]').forEach(b => b.onclick = () => {
    MASTER = b.dataset.ms === 'true';
    // En un set, lo que eliges se recuerda: es el set que estás haciendo (básico o máster)
    const m = location.hash.match(/^#\/set\/([^?]+)/);
    if (m) { const id = decodeURIComponent(m[1]); COL.setMode ||= {}; if (MASTER) COL.setMode[id] = 'master'; else delete COL.setMode[id]; saveCol(); }
    rerender(); });
}

let SET_TAB = 'cards';
function viewSet(setId) {
  const s = q(`SELECT set_id, lang, COALESCE(name_es,name_en,name_ja,name_local) name, serie, release_date, card_count, cm_expansion_id FROM sets WHERE set_id=?`, [setId])[0];
  if (!s) { $view.innerHTML = '<p>Set no encontrado.</p>'; return; }
  const cards = q(`SELECT c.card_id, c.set_id, c.local_id, ${NAME} name, c.rarity, c.image_base,
    (c.name_es IS NULL AND s.lang='es' AND s.release_date >= '2019') no_es FROM cards c JOIN sets s USING(set_id) WHERE c.set_id=?
    ORDER BY CAST(c.local_id AS INTEGER), c.local_id`, [setId]);
  const ib = (cards.find(c => c.image_base) || {}).image_base;
  const vmap = variantsOf(cards.map(c => c.card_id));
  MASTER = isMasterSet(setId);
  const sealed = s.cm_expansion_id ? q(`SELECT p.cm_product_id, p.name, p.category, pr.trend, pr.avg30, pr.low FROM cm_products p LEFT JOIN prices pr USING(cm_product_id)
    WHERE p.kind='sealed' AND p.cm_expansion_id=? ORDER BY pr.trend DESC`, [s.cm_expansion_id]) : [];
  const vtypes = [...new Set(cards.flatMap(c => uniqVariants(vmap[c.card_id]).filter(v => v && !v.stamp).map(vLabel)))];
  const hidT = (COL.setHide || {})[setId] || [];
  const nHidden = cards.filter(c => (COL.hide || {})[c.card_id] || c.no_es).length;
  $view.innerHTML = `<div class="stack">
    <div class="row"><a href="#/sets" class="pill" style="display:flex;align-items:center">←</a></div>
    <div class="sethero ${MASTER ? 'master' : ''}"><div class="herologo">${setLogo(ib, 'biglogo', s.name, s.set_id)}${MASTER ? `<span class="mbadge">${ico('crown', 14)} Máster set</span>` : ''}</div><div class="col" style="align-items:center;text-align:center"><h1>${esc(s.name)}</h1><span class="muted">${esc(s.serie)} · ${esc(s.release_date || '')} · ${esc(LANGS[s.lang] || s.lang)}</span></div></div>
    ${sealed.length ? `<div class="tbrow">${seg('stab', [['cards', 'Cartas'], ['sealed', `Sellado · ${sealed.filter(x => { const t = cmSealedType(x); return t && t !== 'other'; }).length}`]], SET_TAB)}<span></span></div>` : ''}
    ${SET_TAB === 'sealed' && sealed.length ? `<div class="sgal sgal1">${sealedGallery(sealed.map(x => Object.assign(x, { cm_expansion_id: s.cm_expansion_id })), ib, s.name)}</div>
      <p class="muted">Fotos: WikiDex. Precio: tendencia en Cardmarket. Toca un producto para ver su evolución, poner tu foto o lo que pagaste.</p></div>` : `
    <div class="card col" style="gap:8px" id="sethead"></div>
    ${browserControls()}
    ${MASTER ? `<div class="col" style="gap:6px"><span class="muted" style="font-size:13px">Versiones que cuentan en este set (desmarca las que no existen en tu idioma):</span>
      <div class="pills">${vtypes.map(t => `<button class="pill ${hidT.includes(t) ? '' : 'on'}" data-vt="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>` : ''}
    ${!SHOW_NON_ES && nHidden ? `<span class="muted" style="font-size:13px">${nHidden} carta${nHidden > 1 ? 's' : ''} oculta${nHidden > 1 ? 's' : ''} porque no existe${nHidden > 1 ? 'n' : ''} en español. <a href="#/settings">Cambiar en Ajustes</a></span>` : ''}
    <div id="grid"></div>
    <p class="muted">Precios: ${PRICE_LABEL().toLowerCase()}${s.lang === 'es' ? ' (español e inglés juntos)' : ''}.</p></div>`}`;
  $view.querySelectorAll('[data-stab]').forEach(b => b.onclick = () => { SET_TAB = b.dataset.stab; viewSet(setId); });
  if (SET_TAB === 'sealed' && sealed.length) { wireSealedTiles(() => viewSet(setId)); return; }
  wireControls(() => viewSet(setId));
  $view.querySelectorAll('[data-vt]').forEach(b => b.onclick = () => { COL.setHide ||= {}; const l = COL.setHide[setId] ||= []; const t = b.dataset.vt; const i = l.indexOf(t); if (i >= 0) l.splice(i, 1); else l.push(t); if (!l.length) delete COL.setHide[setId]; saveCol(); viewSet(setId); });
  wireSealedTiles(() => viewSet(setId));
  cardBrowser('set:' + setId, cards, vmap, document.getElementById('grid'), document.getElementById('sethead'),
    { kind: 'set', sub: c => `${c.local_id}${s.card_count ? '/' + s.card_count : ''}${c.rarity && c.rarity !== 'None' ? ' · ' + c.rarity : ''}` })();
}


/* ---------- producto sellado: casillas con dibujo según el tipo + logo del set ---------- */
const SEALED_ORDER = ['Pokémon Booster', 'Pokémon Display', 'Pokémon Elite Trainer Boxes', 'Pokémon Box Set', 'Pokémon Tins', 'Pokémon Blisters', 'Pokémon Theme Decks', 'Pokémon Trainer Kits', 'Pokémon Coins', 'PCG Set', 'Pokémon Lot'];
const SEALED_LABEL = { 'Pokémon Booster': 'Sobre', 'Pokémon Display': 'Caja de sobres', 'Pokémon Elite Trainer Boxes': 'Elite Trainer Box', 'Pokémon Box Set': 'Caja / colección', 'Pokémon Tins': 'Lata', 'Pokémon Blisters': 'Blíster', 'Pokémon Theme Decks': 'Baraja', 'Pokémon Trainer Kits': 'Kit de entrenador', 'Pokémon Coins': 'Moneda', 'PCG Set': 'Set', 'Pokémon Lot': 'Lote' };
function sealedShape(cat) {
  const st = 'fill="#1E2630" stroke="#3B4B5C" stroke-width="2"';
  switch (cat) {
    case 'Pokémon Booster': return `<path ${st} d="M30 8 L90 8 L94 16 L90 22 L90 118 L94 124 L90 132 L30 132 L26 124 L30 118 L30 22 L26 16 Z"/><path d="M30 22 L90 22 M30 118 L90 118" stroke="#3B4B5C" stroke-width="1.5" stroke-dasharray="3 3"/>`;
    case 'Pokémon Display': return `<path ${st} d="M10 40 L60 22 L110 40 L110 116 L60 134 L10 116 Z"/><path d="M10 40 L60 58 L110 40 M60 58 L60 134" stroke="#3B4B5C" stroke-width="2" fill="none"/>`;
    case 'Pokémon Elite Trainer Boxes': return `<rect ${st} x="14" y="34" width="92" height="96" rx="4"/><rect ${st} x="10" y="24" width="100" height="22" rx="4"/>`;
    case 'Pokémon Tins': return `<rect ${st} x="16" y="20" width="88" height="110" rx="22"/><rect x="22" y="26" width="76" height="98" rx="18" fill="none" stroke="#3B4B5C" stroke-width="1.5"/>`;
    case 'Pokémon Blisters': return `<rect ${st} x="16" y="10" width="88" height="124" rx="6"/><circle cx="60" cy="22" r="5" fill="#0E1116"/><rect x="26" y="40" width="68" height="84" rx="6" fill="none" stroke="#3B4B5C" stroke-width="1.5"/>`;
    case 'Pokémon Coins': return `<circle ${st} cx="60" cy="72" r="46"/><circle cx="60" cy="72" r="36" fill="none" stroke="#3B4B5C" stroke-width="1.5"/>`;
    default: return `<rect ${st} x="10" y="28" width="100" height="92" rx="6"/><path d="M10 50 L110 50" stroke="#3B4B5C" stroke-width="2"/>`;
  }
}
function sealedArt(x, logoBase, cls = 'sealart') {
  const key = 'sealed:' + x.cm_product_id;
  if (CUSTOM_IMG[key]) return `<div class="${cls}"><img src="${CUSTOM_IMG[key]}" alt="" style="width:100%;height:100%;object-fit:contain"></div>`;
  return `<div class="${cls}"><svg viewBox="0 0 120 142" aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%">${sealedShape(x.category)}</svg>
    <div class="seallogo">${setLogo(logoBase, 'setlogo', x.set_name || '')}</div>
    <span class="sealtype">${esc(SEALED_LABEL[x.category] || x.category.replace('Pokémon ', ''))}</span></div>`;
}
/* ---------- producto sellado del set: tipos, nombres en español y fotos (WikiDex, ver sellado.py) ---------- */
const STYPE = { etb: 'Caja de Entrenador Élite', etbpc: 'Caja de Entrenador Élite', bb: 'Caja Combina y Combate', box: 'Caja de sobres', bundle: 'Lote de sobres',
  premium: 'Colección', tin: 'Lata', blister: 'Blíster', booster: 'Sobre', deck: 'Baraja', other: 'Otros' };
const STYPE_ORDER = ['etb', 'etbpc', 'box', 'bundle', 'bb', 'premium', 'tin', 'blister', 'booster', 'deck', 'other'];
function cmSealedType(x) {
  const n = x.name || '', c = x.category || '';
  if (/\bCase\b/i.test(n) || c === 'Pokémon Coins' || c === 'Pokémon Lot') return null;   // cajas de cajas, monedas y lotes: fuera
  if (c === 'Pokémon Elite Trainer Boxes') return /Pok[ée]mon Center/i.test(n) ? 'etbpc' : 'etb';
  if (/Build & Battle/i.test(n)) return /Display/i.test(n) ? null : 'bb';
  if (/Booster Bundle/i.test(n)) return 'bundle';
  if (c === 'Pokémon Display' || /Booster Box/i.test(n)) return 'box';
  if (c === 'Pokémon Blisters') return 'blister';
  if (c === 'Pokémon Tins') return 'tin';
  if (c === 'Pokémon Theme Decks' || c === 'Pokémon Trainer Kits') return 'deck';
  if (c === 'Pokémon Booster') return /Fun Pack|Code Card/i.test(n) ? 'other' : 'booster';
  if (c === 'Pokémon Box Set') return 'premium';
  return 'other';
}
let EXP_PHOTOS = null;
function photosFor(expId) {
  if (!EXP_PHOTOS) { EXP_PHOTOS = {}; const S = window.SELLADO || {}, ids = Object.keys(S);
    if (ids.length) q(`SELECT set_id, cm_expansion_id FROM sets WHERE set_id IN (${ids.map(() => '?').join(',')})`, ids).forEach(r => { if (r.cm_expansion_id) EXP_PHOTOS[r.cm_expansion_id] = (EXP_PHOTOS[r.cm_expansion_id] || []).concat(S[r.set_id] || []); }); }   // varios sets pueden compartir expansión (p. ej. 30.º Aniversario y su Colección Clásica): se juntan sus fotos
  return EXP_PHOTOS[expId] || [];
}
function photoScore(x, f) {
  const words = (x.name || '').replace(/[:()\-]/g, ' ').split(/\s+/).filter(w => w.length > 3 && /^[A-ZÉ]/.test(w) && !/^(Pack|Blister|Premium|Checklane|Booster|Elite|Trainer|Collection|Build|Battle|Sleeved|Bundle|Display)$/i.test(w)).map(w => w.toLowerCase());
  const en = (q('SELECT name_en FROM sets WHERE cm_expansion_id = ? AND name_en IS NOT NULL LIMIT 1', [x.cm_expansion_id])[0] || {}).name_en || '';
  const packs = ((x.name || '').match(/(\d+)-Pack/i) || [])[1];
  return (words.some(w => !en.toLowerCase().includes(w) && f.n.toLowerCase().includes(w)) ? 2 : 0) + (packs && new RegExp('\\b' + packs + ' sobres?\\b', 'i').test(f.n) ? 1 : 0);
}
// Busca la foto que mejor encaja: mismo tipo y, si puede, mismo Pokémon o número de sobres
function sealedPhoto(x) {
  const t = cmSealedType(x) || 'other', ph = photosFor(x.cm_expansion_id); if (!ph.length) return null;
  const score = f => photoScore(x, f);
  const strict = ['blister', 'tin', 'premium', 'deck'].includes(t);   // aquí cada producto es distinto: solo foto si coincide el Pokémon
  const pick = (ty) => ph.filter(f => f.t === ty && (!strict || ty !== t || score(f) >= 2)).sort((a, b) => score(b) - score(a) || (a.en || 0) - (b.en || 0))[0];   // a igualdad, la foto española
  return pick(t) || (t === 'etbpc' ? pick('etb') : null) || (['box', 'bundle'].includes(t) ? pick('booster') : null);
}
function sealedEsName(x, setName) {
  const t = cmSealedType(x) || 'other', n = x.name || '', ph = sealedPhoto(x);
  const specific = ['blister', 'tin', 'premium', 'booster', 'deck'].includes(t);
  if (ph && !ph.en && ph.t === t && (!specific || photoScore(x, ph) >= 2) && !/Pok[ée]mon Center|Sleeved/i.test(n)) return ph.n;
  const extra = [];
  let who = (n.includes(':') ? n.split(':').slice(1).join(':') : '').replace(/Premium Checklane|Blister|\d+-Pack|Mini Tin|Tin|Premium Collection|Collection|Box|Pok[ée]mon Center/gi, '').replace(/\s{2,}/g, ' ').trim();
  if (who) extra.push(who);
  if (/Pok[ée]mon Center/i.test(n)) extra.push('Pokémon Center');
  if (/Sleeved/i.test(n)) extra.push('con funda');
  const bx = n.match(/\((\d+) Boosters?\)/i); if (bx) extra.push(bx[1] + ' sobres');
  const pk = n.match(/(\d+)-Pack/i); if (pk) extra.push(pk[1] === '1' ? '1 sobre' : pk[1] + ' sobres');
  if (/Premium Checklane/i.test(n)) extra.push('prémium');
  const label = t === 'tin' && /Mini Tin/i.test(n) ? 'Minilata' : STYPE[t];
  return `${label}${setName ? ' ' + setName : ''}${extra.length ? ' · ' + extra.join(' · ') : ''}`;
}
function sealedPhotoTag(x, logoBase, cls = '') {
  if (CUSTOM_IMG['sealed:' + x.cm_product_id]) return `<img class="${cls}" src="${CUSTOM_IMG['sealed:' + x.cm_product_id]}" alt="">`;
  const ph = sealedPhoto(x);
  return ph ? `<img class="${cls} wdx" loading="lazy" src="${esc(ph.u)}" alt="${esc(ph.n)}">` : sealedArt(x, logoBase);
}
// Dentro del set sobra repetir su nombre: «Blíster de 1 sobre Caos Creciente Toxel» → «Blíster de 1 sobre Toxel»
const shortSealed = (n, setName) => setName ? n.replace(new RegExp('\\s*(de\\s+)?' + setName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').replace(/\s{2,}/g, ' ').replace(/^\s*·\s*|\s*·\s*$/g, '').trim() : n;
function sealedGallery(list, logoBase, setName) {
  const rows = list.map(x => ({ x, t: cmSealedType(x) })).filter(r => r.t && r.t !== 'other').sort((a, b) => STYPE_ORDER.indexOf(a.t) - STYPE_ORDER.indexOf(b.t) || (rPrice(b.x) || 0) - (rPrice(a.x) || 0));
  if (!rows.length) return '<p class="muted">No hay producto sellado de este set en Cardmarket.</p>';
  let last = null;
  return rows.map(({ x, t }) => { const own = COL.sealed[x.cm_product_id], head = STYPE[t] !== last ? (last = STYPE[t], `<h3 class="shead">${esc(STYPE[t])}</h3>`) : '';
    return `${head}<a class="scard srow" href="#/sealeditem/${x.cm_product_id}">
      <div class="sphoto">${sealedPhotoTag(x, logoBase)}${own ? `<span class="sqty">✓${own.qty > 1 ? ' ×' + own.qty : ''}</span>` : ''}</div>
      <div class="sinfo"><b class="sname">${esc(shortSealed(sealedEsName(x, ''), setName))}</b><div class="between" style="align-items:center"><b class="sprice">${eur(rPrice(x))}</b>
      <button class="sadd ${own ? 'on' : ''}" data-sealed="${x.cm_product_id}" aria-label="${own ? 'Cambiar unidades' : 'La tengo'}" onclick="event.preventDefault()">${own ? (own.qty > 1 ? own.qty : '✓') : '＋'}</button></div></div></a>`; }).join('');
}
function sealedTiles(list, logoBase) {
  const sorted = list.slice().sort((a, b) => (SEALED_ORDER.indexOf(a.category) + 1 || 99) - (SEALED_ORDER.indexOf(b.category) + 1 || 99) || (rPrice(b) || 0) - (rPrice(a) || 0));
  return `<div class="grid">${sorted.map(x => { const own = COL.sealed[x.cm_product_id];
    return `<div class="tile ${own ? 'has' : 'miss'} stile" data-sopen="${x.cm_product_id}">
      <div class="img" style="aspect-ratio:120/142">${sealedArt(x, logoBase)}
        <button class="own" data-sealed="${x.cm_product_id}" aria-label="${own ? 'Cambiar unidades de' : 'Añadir'} ${esc(x.name)}">${own ? (own.qty > 1 ? own.qty : '✓') : '＋'}</button></div>
      <span class="nm" style="white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${esc(x.name)}</span><span class="pr">${eur(rPrice(x))}</span></div>`; }).join('')}</div>`;
}
function wireSealedTiles(back) {
  $view.querySelectorAll('[data-sealed]').forEach(b => b.onclick = ev => {
    ev.stopPropagation(); const id = b.dataset.sealed, cur = COL.sealed[id];
    if (!cur) COL.sealed[id] = { qty: 1 };
    else { const n = prompt('¿Cuántas unidades tienes? (0 para quitarlo)', cur.qty || 1); if (n === null) return; const k = parseInt(n, 10); if (!k) delete COL.sealed[id]; else cur.qty = k; }
    saveCol(); back();
  });
  $view.querySelectorAll('[data-sopen]').forEach(t => t.onclick = () => location.hash = '#/sealeditem/' + t.dataset.sopen);
}
function viewSealedItem(id) {
  const x = q(`SELECT p.cm_product_id, p.name, p.category, p.cm_expansion_id, pr.trend, pr.avg30, pr.avg7, pr.low,
     s.set_id, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name,
     (SELECT image_base FROM cards c WHERE c.set_id = s.set_id LIMIT 1) ib
     FROM cm_products p LEFT JOIN prices pr USING(cm_product_id) LEFT JOIN sets s ON s.set_id = (SELECT MIN(set_id) FROM sets z WHERE z.cm_expansion_id = p.cm_expansion_id)
     WHERE p.cm_product_id = ?`, [+id])[0];
  if (!x) { $view.innerHTML = '<p>Producto no encontrado.</p>'; return; }
  const e = COL.sealed[id], p = rPrice(x);
  const h = historyFor([+id]).filter(r => r.trend_c != null).map(r => [r.day, r.trend_c / 100]);
  const gain = e && e.buy != null && p != null ? (p - e.buy) * (e.qty || 1) : null;
  const cm = 'https://www.cardmarket.com/es/Pokemon/Products/Search?searchString=' + encodeURIComponent(x.name);
  $view.innerHTML = `<div class="stack">
    <div class="row"><a href="${COL.sealed[id] ? '#/sealed' : x.set_id ? '#/set/' + encodeURIComponent(x.set_id) : '#/sealed'}" class="pill" style="display:flex;align-items:center" aria-label="Volver">←</a><span class="muted">${esc(x.set_name || '')} · ${esc(SEALED_LABEL[x.category] || x.category)}</span></div>
    <div class="row" style="align-items:flex-start;gap:16px;flex-wrap:wrap">
      <div class="col" style="gap:8px;align-items:flex-start"><div class="sdetail">${CUSTOM_IMG['sealed:' + id] ? `<img src="${CUSTOM_IMG['sealed:' + id]}" alt="" style="width:100%;height:100%;object-fit:cover">` : sealedPhoto(x) ? sealedPhotoTag(x, x.ib) : sealedArt(x, x.ib, 'sealart big')}</div>
        <div class="row" style="flex-wrap:wrap;gap:6px;max-width:180px"><label class="pill" style="display:flex;align-items:center;cursor:pointer;font-size:13px">${CUSTOM_IMG['sealed:' + id] ? 'Cambiar foto' : 'Poner mi foto'}<input type="file" id="simg" accept="image/*" hidden></label>${CUSTOM_IMG['sealed:' + id] ? '<button class="pill" id="sdel" style="font-size:13px">Quitar</button>' : ''}</div></div>
      <div class="col" style="gap:8px;flex:1;min-width:200px"><h1>${esc(x.name)}</h1>
        <div class="big">${eur(p)}</div><span class="muted">${PRICE_LABEL()}</span>
        <a target="_blank" rel="noopener" href="${cm}">Ver en Cardmarket ↗</a></div></div>
    <div class="card"><table><tr><th>Cardmarket</th><th>Mínimo</th><th>Tendencia</th><th>Media 30 d</th></tr><tr><td>Precio</td><td>${eur(x.low)}</td><td>${eur(x.trend)}</td><td>${eur(x.avg30)}</td></tr></table></div>
    <div class="col" style="gap:8px"><h2>Evolución del precio</h2>${chartSvg(h, 700, 140)}</div>
    <div class="card col" style="gap:12px"><b>${e ? 'Lo tienes' : 'No lo tienes'}</b>
      ${e ? `<div class="row" style="flex-wrap:wrap"><label class="f">Unidades<input type="number" id="sq" min="1" value="${e.qty || 1}" style="width:90px"></label>
        <label class="f">Precio de compra (€/ud)<input type="number" id="sb" step="0.01" min="0" value="${e.buy ?? ''}" style="width:150px"></label></div>
        ${gain != null ? `<span class="${gain >= 0 ? 'up' : 'down'}" style="font-weight:700">${gain >= 0 ? '+' : '−'}${eur(Math.abs(gain))} (${pct((p - e.buy) / e.buy * 100)})</span>` : ''}
        <div class="row"><button class="btn" id="ssave">Guardar</button><button class="btn warn" id="sdelc">Quitar</button></div>` : '<button class="btn" id="sadd">＋ Lo tengo</button>'}</div></div>`;
  const g = k => document.getElementById(k);
  if (g('sadd')) g('sadd').onclick = () => { COL.sealed[id] = { qty: 1 }; saveCol(); viewSealedItem(id); };
  if (g('ssave')) g('ssave').onclick = () => { COL.sealed[id].qty = Math.max(1, parseInt(g('sq').value, 10) || 1); COL.sealed[id].buy = parseNum(g('sb').value); saveCol(); toast('Guardado'); viewSealedItem(id); };
  if (g('sdelc')) g('sdelc').onclick = () => { delete COL.sealed[id]; saveCol(); viewSealedItem(id); };
  if (g('simg')) g('simg').onchange = async ev => { const f = ev.target.files[0]; if (!f) return; const u = await resizeImage(f); CUSTOM_IMG['sealed:' + id] = u; await idbPut('img:sealed:' + id, u); imgsDirty = true; saveCol(); viewSealedItem(id); };
  if (g('sdel')) g('sdel').onclick = async () => { delete CUSTOM_IMG['sealed:' + id]; await idbDel('img:sealed:' + id); imgsDirty = true; saveCol(); viewSealedItem(id); };
}

/* ---------- ilustradores ---------- */
let illLang = ILL_LANG, illQuery = '', illOrden = true;
const langCond = l => l === 'all' ? '1=1' : l === 'es' ? "s.lang='es'" : "s.lang='ja'";
function viewIllustrators() {
  const rows = q(`SELECT c.illustrator name, COUNT(*) n FROM cards c JOIN sets s USING(set_id)
    WHERE c.illustrator IS NOT NULL AND ${langCond(illLang)} GROUP BY c.illustrator COLLATE NOCASE ORDER BY n DESC`);
  const favs = Object.keys(COL.illustrators);
  const ownBy = {};
  if (favs.length) {
    const ids = Object.keys(COL.cards);
    if (ids.length) q(`SELECT c.illustrator FROM cards c JOIN sets s USING(set_id) WHERE ${langCond(illLang)} AND c.card_id IN (${ids.map(() => '?').join(',')})`, ids)
      .forEach(r => { const k = (r.illustrator || '').toLowerCase(); ownBy[k] = (ownBy[k] || 0) + 1; });
  }
  const total = {}; rows.forEach(r => total[r.name.toLowerCase()] = r.n);
  // Si el ilustrador tiene lista "Mi orden", el total y el progreso salen de esa lista (una carta por ilustración)
  const ordOf = name => { const o = (window.ORDEN || {})[name.toLowerCase()]; return o && o.lang === illLang ? o : null; };
  const item = (name, n) => { const od = ordOf(name); let o = ownBy[name.toLowerCase()] || 0;
    if (od) { n = od.cartas.length; o = od.cartas.filter(e => ordenOwned(name, e)).length; } return `<a class="item" href="#/illustrator/${encodeURIComponent(name)}"><div class="col" style="flex:1"><b>${esc(name)} ${COL.illustrators[name] ? '<span class="up">★</span>' : ''}</b><span class="muted">${n} ${ordOf(name) ? 'ilustraciones' : 'cartas'}</span>
    ${o ? `<div class="bar" style="margin-top:4px"><div style="width:${o / n * 100}%"></div></div>` : ''}</div><span class="muted">${o ? o + '/' + n : ''}</span></a>`; };
  const draw = () => {
    const ql = illQuery.toLowerCase();
    document.getElementById('ills').innerHTML = rows.filter(r => !ql || r.name.toLowerCase().includes(ql)).slice(0, 300).map(r => item(r.name, r.n)).join('') || '<p class="muted">Sin resultados.</p>';
  };
  $view.innerHTML = `<div class="stack"><div class="row"><a href="#/sets" class="pill" style="display:flex;align-items:center">←</a><h1>Ilustradores</h1></div>
    ${favs.length ? `<div class="col"><h2>Mis colecciones</h2><div class="list">${favs.map(f => item(f, total[f.toLowerCase()] || 0)).join('')}</div></div>` : '<div class="card muted">Entra en un ilustrador y pulsa "Seguir" para tenerlo aquí como colección.</div>'}
    <input type="search" id="iq" placeholder="Buscar ilustrador…" value="${esc(illQuery)}">
    <div class="list" id="ills"></div></div>`;
  $view.querySelectorAll('[data-il]').forEach(b => b.onclick = () => { illLang = b.dataset.il; viewIllustrators(); });
  document.getElementById('iq').oninput = e => { illQuery = e.target.value; draw(); };
  draw();
}
function viewIllustrator(name) {
  const ord = (window.ORDEN || {})[name.toLowerCase()];
  if (ord && illLang === ord.lang && illOrden) { viewOrden(name, ord); const sim = similarSection(name); if (sim) $view.querySelector('.stack').insertAdjacentHTML('beforeend', sim); return; }
  const cards = q(`SELECT c.card_id, c.set_id, c.local_id, ${NAME} name, c.rarity, c.image_base, s.lang, s.release_date,
    (c.name_es IS NULL AND s.lang='es' AND s.release_date >= '2019') no_es,
    COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name FROM cards c JOIN sets s USING(set_id)
    WHERE c.illustrator = ? COLLATE NOCASE AND ${langCond(illLang)} ORDER BY s.release_date, s.set_id, CAST(c.local_id AS INTEGER)`, [name]);
  const vmap = variantsOf(cards.map(c => c.card_id));
  const fav = !!COL.illustrators[name];
  $view.innerHTML = `<div class="stack">
    <div class="row"><a href="#/illustrators" class="pill" style="display:flex;align-items:center">←</a><div class="col" style="flex:1"><h1>${esc(name)}</h1><span class="muted">Ilustrador · ${cards.length} cartas</span></div>
      <button class="pill ${fav ? 'on' : ''}" id="fav">${fav ? '★ Siguiendo' : '☆ Seguir'}</button></div>
    ${ord && illLang === ord.lang ? ordenTabs(false) : ''}
    <div class="card col" style="gap:8px" id="ihead"></div>
    ${browserControls('ill')}
    <div id="grid"></div>
    <p class="muted">Ordenadas por fecha de salida del set. Precios: ${PRICE_LABEL().toLowerCase()}.${illLang === 'ja' ? ' En japonés la lista está incompleta: a la base de datos le faltan muchos sets antiguos (DP, BW, XY…) y el ilustrador de algunas cartas.' : ''}</p></div>`;
  document.getElementById('fav').onclick = () => { if (fav) delete COL.illustrators[name]; else COL.illustrators[name] = { since: PRICE_DATE }; saveCol(); viewIllustrator(name); };
  $view.querySelectorAll('[data-il]').forEach(b => b.onclick = () => { illLang = b.dataset.il; viewIllustrator(name); });
  $view.querySelectorAll('[data-ord]').forEach(b => b.onclick = () => { illOrden = b.dataset.ord === '1'; viewIllustrator(name); });
  wireControls(() => viewIllustrator(name));
  cardBrowser('ill:' + name + ':' + illLang, cards, vmap, document.getElementById('grid'), document.getElementById('ihead'),
    { kind: 'ill', sub: c => `${c.set_name} · ${c.local_id}${illLang === 'all' ? ' · ' + (c.lang === 'ja' ? 'JP' : c.lang.toUpperCase()) : ''}` })();
  if (HAS_EXTRA && illLang !== 'es') extraSection(name);
  const sim = similarSection(name); if (sim) $view.querySelector('.stack').insertAdjacentHTML('beforeend', sim);
}
/* ---------- "Mi orden": lista hecha a mano, una carta por ilustración en orden de lanzamiento (app/orden.js) ---------- */
// Cada carta se guarda donde ya lo hace la app: COL.cards si está en la base de datos, COL.extra si es un producto
// de Cardmarket, y COL.extra con una clave negativa si no hay forma de enlazarla (cuenta como carta, sin precio).
const ordenTabs = on => `<div class="pills">${[[1, 'Mi orden · 1 por ilustración'], [0, 'Todas las cartas']].map(([k, l]) => `<button class="pill ${(k === 1) === on ? 'on' : ''}" data-ord="${k}">${l}</button>`).join('')}</div>`;
const ordenKey = (name, e) => e.id ? 'c:' + e.id : e.cm ? 'x:' + e.cm : 'x:' + (-(ordenHash(name) * 1000 + e.o));
const ordenHash = s => { let h = 7; for (const ch of s.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 9000; return h + 1; };
function ordenOwned(name, e) { const k = ordenKey(name, e); return k[0] === 'c' ? !!COL.cards[e.id] : !!COL.extra[k.slice(2)]; }
function ordenToggle(name, e, vmap) {
  const k = ordenKey(name, e);
  if (k[0] === 'c') {
    if (COL.cards[e.id]) { delete COL.cards[e.id]; if (COL.master) delete COL.master[e.id]; }
    else { const v = (vmap[e.id] || []).slice().sort((a, b) => (vPrice(a) ?? 1e9) - (vPrice(b) ?? 1e9))[0]; COL.cards[e.id] = { set: e.set_id, cm: v ? v.cm_product_id : null, variant: v ? v.variant : null, qty: 1 }; }
  } else { const id = k.slice(2); if (COL.extra[id]) delete COL.extra[id]; else COL.extra[id] = { qty: 1, added: PRICE_DATE, orden: e.n + ' · ' + e.s }; }
  saveCol();
}
function ordenData(ord) {
  const E = ord.cartas.map(x => Object.assign({}, x));
  const ids = E.filter(e => e.id).map(e => e.id), cms = E.filter(e => e.cm).map(e => e.cm);
  const info = {}; if (ids.length) q(`SELECT c.card_id, c.set_id, c.image_base, ${NAME} name FROM cards c JOIN sets s USING(set_id) WHERE c.card_id IN (${ids.map(() => '?').join(',')})`, ids).forEach(r => info[r.card_id] = r);
  const pr = {}; if (cms.length) q(`SELECT cm_product_id, trend, avg30, low FROM prices WHERE cm_product_id IN (${cms.map(() => '?').join(',')})`, cms).forEach(r => pr[r.cm_product_id] = r);
  const vmap = variantsOf(ids.filter(id => info[id]));
  E.forEach(e => { const r = e.id && info[e.id]; if (e.id && !r) delete e.id; if (r) { e.set_id = r.set_id; e.image_base = r.image_base; e.card_id = r.card_id; } e.pr = e.cm ? pr[e.cm] : null; });
  return { E, vmap };
}
function ordenPrice(name, e, vmap) { if (e.id) return COL.cards[e.id] ? vPrice(ownedVariant(e.id, vmap[e.id])) : cheapest(vmap[e.id]); if (!e.cm) return null; const r = realOf(e.cm); return realFresh(r) ? r.p : rPrice(e.pr); }
const ordenImgKey = (name, e) => 'orden:' + name.toLowerCase() + ':' + e.o;
function ordenImg(e, cls = '', name = '') { const mine = name && CUSTOM_IMG[ordenImgKey(name, e)]; if (mine) return `<img ${cls ? `class="${cls}"` : ''} loading="lazy" alt="${esc(e.n)}" src="${esc(mine)}">`; return e.id ? cardImg(e, cls ? 'high' : 'low', cls, e.n) : e.img ? `<img ${cls ? `class="${cls}"` : ''} loading="lazy" alt="${esc(e.n)}" src="${esc((window.ORDEN_IMGS || {})[e.img] || ORDEN_IMG + e.img)}" onerror="this.remove()">` : ''; }
function viewOrden(name, ord) {
  const { E, vmap } = ordenData(ord);
  $view.innerHTML = `<div class="stack">
    <div class="row"><a href="#/illustrators" class="pill" style="display:flex;align-items:center">←</a><div class="col" style="flex:1"><h1>${esc(name)}</h1><span class="muted">${esc(ord.titulo)} · ${E.length} ilustraciones</span></div>
      <button class="pill ${COL.illustrators[name] ? 'on' : ''}" id="fav">${COL.illustrators[name] ? '★ Siguiendo' : '☆ Seguir'}</button></div>
    ${ordenTabs(true)}
    <div class="card col" style="gap:8px" id="ohead"></div>
    ${browserControls('none')}
    <div id="ogrid"></div>
    <p class="muted">Una carta por ilustración, la primera vez que salió en japonés, en orden de lanzamiento. Las reimpresiones con el mismo dibujo están en la nota de cada carta. Fotos de las cartas que no están en la base de datos: CollectHolo.</p></div>`;
  document.getElementById('fav').onclick = () => { if (COL.illustrators[name]) delete COL.illustrators[name]; else COL.illustrators[name] = { since: PRICE_DATE }; saveCol(); viewOrden(name, ord); };
  $view.querySelectorAll('[data-il]').forEach(b => b.onclick = () => { illLang = b.dataset.il; viewIllustrator(name); });
  $view.querySelectorAll('[data-ord]').forEach(b => b.onclick = () => { illOrden = b.dataset.ord === '1'; viewIllustrator(name); });
  wireControls(() => viewOrden(name, ord));
  const el = document.getElementById('ogrid'), headEl = document.getElementById('ohead'), akey = 'orden:' + name;
  const tile = (e, i, pocket) => { const has = ordenOwned(name, e), p = ordenPrice(name, e, vmap);
    return `<div class="tile ${has ? 'has' : 'miss'}" data-oi="${i}" title="${pocket ? esc(pocket) : ''}">
      <div class="img"><span class="fbn">${esc(e.n)}</span>${ordenImg(e, '', name)}<span class="vtag">#${e.o}</span>
        <button class="own" data-oown="${i}" aria-label="${has ? 'Quitar de' : 'Añadir a'} mi colección: ${esc(e.n)}">${has ? '✓' : '＋'}</button></div>
      <span class="num">${esc(e.d.slice(0, 4))} · ${esc(e.s)}</span><span class="nm">${esc(e.n)}</span><span class="pr">${eur(p)}</span></div>`; };
  const draw = () => {
    LIST_CTX = E.map(e => ordenRoute(name, e));
    let have = 0, val = 0, miss = 0;
    E.forEach(e => { const p = ordenPrice(name, e, vmap) || 0; if (ordenOwned(name, e)) { have++; val += e.id ? cardValue(e.id, p) : p * ((COL.extra[ordenKey(name, e).slice(2)] || {}).qty || 1); } else miss += p; });
    const pc = have / E.length * 100, next = E.find(e => !ordenOwned(name, e));
    headEl.innerHTML = `<div class="between"><b>Tienes ${have} de ${E.length}</b><b class="up" style="font-size:22px">${Math.round(pc)} %</b></div>
      <div class="bar"><div style="width:${pc}%"></div></div>
      <div class="between muted" style="flex-wrap:wrap"><span>Tu parte vale <b style="color:var(--tx)">${eur(val)}</b></span><span>Lo que falta (con precio): <b style="color:var(--tx)">${eur(miss)}</b></span></div>
      ${bulkAlertButton('orden:' + name.toLowerCase())}
      ${next ? `<span class="muted">Siguiente en tu orden: <b style="color:var(--tx)">#${next.o} ${esc(next.n)}</b> · ${esc(next.s)} (${esc(next.d.slice(0, 4))})</span>` : ''}`;
    const ob = headEl.querySelector('[data-bulk]'); if (ob) ob.onclick = () => bulkAlerts('orden:' + name.toLowerCase(), E.filter(e => !ordenOwned(name, e)).map(e => { const p = ordenPrice(name, e, vmap); if (!p) return null;
      if (e.id) { const v = (vmap[e.id] || []).slice().sort((a, b) => (vPrice(a) ?? 1e9) - (vPrice(b) ?? 1e9))[0]; return v ? { key: v.cm_product_id + '|' + (v.variant || ''), card: e.id, cm: v.cm_product_id, variant: v.variant, price: p, name: e.n } : null; }
      return e.cm ? { key: e.cm + '|', cm: e.cm, price: p, name: e.n + ' · ' + e.s, route: ordenRoute(name, e), img: ((ordenImg(e, '', name).match(/src="([^"]+)"/) || [])[1] || '').replace(/^data:.*/, '') || undefined } : null; }).filter(Boolean), draw);
    if (browseMode === 'album') {
      renderBinder({ akey, E, tile, el, draw, ids: E.map(e => String(e.o) + ':' + e.n), label: k => '#' + k.replace(':', ' ') });
    } else {
      const idx = E.map((e, i) => i).filter(i => browseFilter === 'all' || (browseFilter === 'have') === ordenOwned(name, E[i]));
      const years = {}; idx.forEach(i => (years[E[i].d.slice(0, 4)] ||= []).push(i));
      el.innerHTML = Object.entries(years).map(([y, is]) => { const tot = E.filter(e => e.d.startsWith(y)), got = tot.filter(e => ordenOwned(name, e)).length;
        return `<div class="between" style="margin:14px 0 8px"><h2>${esc(y)}</h2><span class="muted">${got}/${tot.length}</span></div><div class="grid">${is.map(i => tile(E[i], i)).join('')}</div>`; }).join('')
        || '<p class="muted">Nada que mostrar con este filtro.</p>';
    }
    el.querySelectorAll('[data-oown]').forEach(b => b.onclick = ev => { ev.stopPropagation(); const i = +b.dataset.oown; ordenToggle(name, E[i], vmap); if (ordenOwned(name, E[i])) toast('📒 Va en la ' + spotTxt(binderSpot(akey, i))); draw(); });
    el.querySelectorAll('[data-oi]').forEach(t => t.onclick = () => { location.hash = ordenRoute(name, E[+t.dataset.oi]); });
  };
  draw();
}
const ordenRoute = (name, e) => e.id ? '#/card/' + encodeURIComponent(e.id) : '#/ocard/' + encodeURIComponent(name.toLowerCase()) + '/' + e.o;
// Ficha de una carta de "Mi orden" que no está en la base de datos: foto grande, datos, Cardmarket y gestos como en las demás
function viewOrdenCard(key, o) {
  const ord = (window.ORDEN || {})[key]; if (!ord) { $view.innerHTML = '<p>Carta no encontrada.</p>'; return; }
  const name = (q(`SELECT illustrator FROM cards WHERE illustrator = ? COLLATE NOCASE LIMIT 1`, [key])[0] || {}).illustrator || key;
  const { E, vmap } = ordenData(ord), e = E.find(x => String(x.o) === String(o)); if (!e) { $view.innerHTML = '<p>Carta no encontrada.</p>'; return; }
  const p = ordenPrice(name, e, vmap), ik = ordenImgKey(name, e);
  const cmUrl = e.cm ? cmProductLink(e.cm, 'asia') : e.id ? cmLink(null, { card_id: e.id, name: e.n }) : 'https://www.cardmarket.com/es/Pokemon/Products/Singles?searchString=' + encodeURIComponent(e.n);
  const dex = (q(`SELECT dex_id FROM cards WHERE dex_id IS NOT NULL AND (name_en = ? OR name_en = ?) LIMIT 1`, [e.n, e.n.replace(/^(Dark|Light|Janine's) /, '')])[0] || {}).dex_id;
  const nav = cardNav(location.hash, null, null);
  const paint = () => { const has = ordenOwned(name, e), p = ordenPrice(name, e, vmap);
    $view.innerHTML = `<div class="stack cardpage"><div class="grabber" aria-hidden="true"></div>
      <div class="row"><a href="#/illustrator/${encodeURIComponent(name)}" class="pill" id="cback" style="display:flex;align-items:center" aria-label="Volver">←</a><span class="muted">${esc(name)} · #${e.o} de ${E.length}</span></div>
      <div class="cardhero">${ordenImg(e, 'hero', name) || `<div class="hero" style="display:flex;align-items:center;justify-content:center;padding:12px;text-align:center">${esc(e.n)}<br>Sin foto</div>`}
        <h1>${esc(e.n)}</h1><span class="muted">${esc(e.s)} · ${esc(e.no)} · ${esc(e.d)}</span>
        ${p != null ? `<div class="big">${eur(p)}</div>${realFresh(realOf(e.cm)) ? `<span class="realtag">✓ ${esc(realLabel(realOf(e.cm)))}</span>` : `<span class="muted">${PRICE_LABEL()}</span>`}` : `<span class="muted">${e.cm ? 'Sin precio hoy en Cardmarket' : 'Sin precio: no está enlazada con Cardmarket'}</span>`}
        <div class="actions"><a class="btn cmbtn" id="ocmgo" target="_blank" rel="noopener" href="${esc(cmUrl)}">Ver en Cardmarket ${ico('external', 17)}</a>
          ${e.cm ? `<button class="iconbtn lg" id="orealset" aria-label="Precio real">${ico('pencil', 20)}</button>` : ''}</div>
        ${e.note ? `<span class="muted" style="color:var(--down)">${esc(e.note)}</span>` : ''}
        <span class="meta">${ico('binder', 16)}${spotTxt(binderSpot('orden:' + name, E.indexOf(e)))}</span>
        <button class="btn ${has ? 'warn' : ''}" id="stog" style="width:100%;max-width:340px">${has ? 'Quitar de la colección' : '＋ La tengo'}</button>
        <div class="row" style="flex-wrap:wrap;gap:6px;justify-content:center"><label class="pill" style="display:flex;align-items:center;cursor:pointer;font-size:13px">${CUSTOM_IMG[ik] ? 'Cambiar foto' : 'Poner mi foto'}<input type="file" id="oimg" accept="image/*" hidden></label>
          <button class="pill" id="ourl" style="font-size:13px">Enlace</button>${CUSTOM_IMG[ik] ? '<button class="pill" id="odel" style="font-size:13px">Quitar</button>' : ''}</div></div>
      ${nav.html}
      ${dex ? `<div class="card col pinfo" id="pinfo">${pokeInfoHTML(dex, e.n)}</div>` : ''}</div>`;
    const setImg = async u => { CUSTOM_IMG[ik] = u; await idbPut('img:' + ik, u); imgsDirty = true; saveCol(); paint(); };
    document.getElementById('oimg').onchange = async ev => { const f = ev.target.files[0]; if (!f) return; try { await setImg(await resizeImage(f)); toast('Foto guardada'); } catch (er) { alert(er.message); } };
    document.getElementById('ourl').onclick = async () => { const u = prompt('Pega el enlace de una imagen de la carta (https://…)'); if (u && /^https:\/\//.test(u.trim())) await setImg(u.trim()); };
    const od = document.getElementById('odel'); if (od) od.onclick = async () => { delete CUSTOM_IMG[ik]; await idbDel('img:' + ik); imgsDirty = true; saveCol(); paint(); };
    document.getElementById('stog').onclick = () => { ordenToggle(name, e, vmap); paint(); };
    const ors = document.getElementById('orealset'); if (ors) ors.onclick = () => askRealPrice(e.cm, false, 'JP', paint);
    const ocg = document.getElementById('ocmgo'); if (ocg && e.cm) ocg.addEventListener('click', () => armAskReal(e.cm, false, 'JP'));
  };
  paint();
  if (dex) pokeAfter(dex, e.n);
}
// Cartas que Cardmarket vende pero que no están en la base de datos (sobre todo japonesas antiguas).
// Se emparejan con su versión inglesa por nombre + ataques, así que conviene revisarlas.
function extraSection(name) {
  const rows = q(`SELECT e.cm_product_id, e.name, e.cm_expansion_id, e.date_added, c.image_base, p.trend, p.avg30, p.low
    FROM cm_extra e LEFT JOIN cards c ON c.card_id = e.ref_card_id LEFT JOIN prices p ON p.cm_product_id = e.cm_product_id
    WHERE e.illustrator = ? COLLATE NOCASE ORDER BY e.date_added IS NULL, e.date_added, e.name`, [name]);
  if (!rows.length) return;
  const box = document.createElement('div'); box.className = 'stack'; box.id = 'xtra';
  $view.querySelector('.stack').appendChild(box);
  const draw = () => {
    const own = rows.filter(r => COL.extra[r.cm_product_id]).length;
    box.innerHTML = `<div class="between"><h2>Más cartas (vía Cardmarket)</h2><span class="muted">${own}/${rows.length}</span></div>
      <p class="muted">Cartas de ${esc(name)} que Cardmarket vende y no están en la guía (sobre todo japonesas). Se han emparejado por nombre y ataques con su versión inglesa: la imagen es la inglesa y puede colarse alguna promo o carta china. Toca para marcarla como tuya.</p>
      <div class="grid">${rows.map(r => { const o = COL.extra[r.cm_product_id], p = rPrice(r);
        return `<div class="tile ${o ? 'has' : 'miss'}" data-x="${r.cm_product_id}">
          <div class="img"><span class="fbn" ${r.image_base ? 'style="display:none"' : ''}>${esc(r.name)}</span>${imgTag(r.image_base, 'low', '', r.name)}
            <span class="vtag">CM</span><button class="own" aria-label="${o ? 'Quitar' : 'Añadir'}: ${esc(r.name)}">${o ? (o.qty > 1 ? '×' + o.qty : '✓') : '＋'}</button></div>
          <span class="num">${r.date_added ? r.date_added.slice(0, 4) : 's/f'} · <a target="_blank" rel="noopener" href="https://www.cardmarket.com/es/Pokemon/Products/Singles?${r.cm_expansion_id ? 'idExpansion=' + r.cm_expansion_id + '&' : ''}searchString=${encodeURIComponent(r.name)}">Cardmarket ↗</a></span>
          <span class="nm">${esc(r.name)}</span><span class="pr">${eur(p)}</span></div>`; }).join('')}</div>`;
    box.querySelectorAll('[data-x]').forEach(t => t.onclick = ev => {
      if (ev.target.closest('a')) return;
      const id = t.dataset.x, cur = COL.extra[id];
      if (!cur) COL.extra[id] = { qty: 1, added: PRICE_DATE };
      else if (confirm('¿Quitar esta carta de tu colección? (Cancelar = añadir otra copia)')) delete COL.extra[id]; else cur.qty = (cur.qty || 1) + 1;
      saveCol(); draw();
    });
  };
  draw();
}

/* ---------- contexto de navegación: desde una lista (set, ilustrador, Mi orden) se pasa de carta en carta en ese orden ---------- */
let LIST_CTX = null, NAV_CTX = null;
function cardNav(hash, setOrder, setLabel) {
  let list = NAV_CTX && NAV_CTX.includes(hash) ? NAV_CTX : null;
  if (!list && setOrder) list = setOrder.map(id => '#/card/' + encodeURIComponent(id));
  if (!list) { CARD_NAV = null; return { html: '' }; }
  const i = list.indexOf(hash), prev = i > 0 ? list[i - 1] : null, next = i >= 0 && i < list.length - 1 ? list[i + 1] : null;
  CARD_NAV = { prev, next, set: setLabel };
  return { html: `<div class="cardnav">${prev ? `<a class="pill navb" href="${prev}" data-nav="prev" aria-label="Carta anterior">${ico('chev', 16, 'flip')}Anterior</a>` : '<span></span>'}
    <span class="muted">${i + 1} de ${list.length} · desliza para cambiar</span>
    ${next ? `<a class="pill navb" href="${next}" data-nav="next" aria-label="Carta siguiente">Siguiente${ico('chev', 16)}</a>` : '<span></span>'}</div>` };
}
function pokeAfter(dex, nm) {
  const fill = () => { const el = document.getElementById('pinfo'); if (!el) return; const h = pokeInfoHTML(dex, nm); if (h) { el.innerHTML = h; wirePoke(dex, nm); const hero = document.querySelector('.cardhero'); if (hero && typeGlow(dex)) hero.setAttribute('style', typeGlow(dex)); } else el.remove(); };
  if (POKE[dex] === undefined || (POKE[dex] && !POKE[dex].evo)) { if (POKE[dex]) fill(); loadPoke(dex).then(fill); } else fill();
}
/* ---------- avisos en bloque: todo lo que te falta de un set o de "Mi orden", con un % de bajada ---------- */
function bulkAlertButton(tag) {
  const n = Object.values(COL.alerts).filter(a => a.bulk === tag).length;
  return `<button class="pill" data-bulk="${esc(tag)}" style="align-self:flex-start;font-size:13px;display:flex;align-items:center;gap:6px">${ico('bell', 16)}${n ? `Avisos activos en ${n} cartas · cambiar` : 'Avisarme si baja lo que me falta'}</button>`;
}
function bulkAlerts(tag, items, rerender) {
  // items: [{key, card, cm, variant, price, name, route}] de cartas que te faltan y tienen precio
  const had = Object.entries(COL.alerts).filter(([, a]) => a.bulk === tag);
  items = items.filter(it => it.price >= 1); // por debajo de 1 € una bajada no merece aviso
  const v = prompt(had.length ? `Tienes avisos en ${had.length} cartas. ¿Qué bajada quieres (en %)? Escribe 0 para quitarlos.` : `Te avisaré cuando alguna de las ${items.length} cartas que te faltan (de 1 € para arriba) baje este % respecto a hoy:`, '15');
  if (v === null) return;
  const pc = parseFloat(String(v).replace(',', '.'));
  had.forEach(([k]) => delete COL.alerts[k]);
  if (pc > 0) items.forEach(it => { if (COL.alerts[it.key] && !COL.alerts[it.key].bulk) return;
    COL.alerts[it.key] = { card: it.card || null, cm: it.cm, variant: it.variant || null, target: Math.round(it.price * (1 - pc / 100) * 100) / 100, created: PRICE_DATE, bulk: tag, name: it.name, route: it.route, img: it.img }; });
  saveCol(); toast(pc > 0 ? `Avisos puestos en ${items.length} cartas (−${pc} %)` : 'Avisos quitados'); rerender();
}
/* ---------- información del Pokémon (PokéAPI, en español; se guarda para no volver a pedirla) ---------- */
const POKE = {};
try { Object.assign(POKE, JSON.parse(localStorage.getItem('poke_cache') || '{}')); } catch (e) {}
const TIPOS = { normal: 'Normal', fire: 'Fuego', water: 'Agua', grass: 'Planta', electric: 'Eléctrico', ice: 'Hielo', fighting: 'Lucha', poison: 'Veneno', ground: 'Tierra', flying: 'Volador', psychic: 'Psíquico', bug: 'Bicho', rock: 'Roca', ghost: 'Fantasma', dragon: 'Dragón', dark: 'Siniestro', steel: 'Acero', fairy: 'Hada' };
async function loadPoke(dex) {
  try {
    const [sp, pk] = await Promise.all([fetch(`https://pokeapi.co/api/v2/pokemon-species/${dex}`).then(r => r.json()), fetch(`https://pokeapi.co/api/v2/pokemon/${dex}`).then(r => r.json())]);
    const fl = sp.flavor_text_entries.filter(f => f.language.name === 'es'), fe = sp.flavor_text_entries.filter(f => f.language.name === 'en');
    POKE[dex] = { gen: ((sp.genera.find(g => g.language.name === 'es') || sp.genera.find(g => g.language.name === 'en') || {}).genus) || '',
      txt: ((fl[fl.length - 1] || fe[fe.length - 1] || {}).flavor_text || '').replace(/[\f\n\r]+/g, ' ').replace(/\s+/g, ' ').trim(),
      types: pk.types.map(t => TIPOS[t.type.name] || t.type.name), h: pk.height / 10, w: pk.weight / 10,
      gn: (sp.generation && sp.generation.name || '').replace('generation-', '').toUpperCase(), leg: sp.is_legendary, myth: sp.is_mythical, en: sp.name, evo: [] };
    try {   // cadena evolutiva: una lista por fase, con el nº y el nombre inglés de cada Pokémon
      const ch = await fetch(sp.evolution_chain.url).then(r => r.json()), st = [];
      const walk = (n, d) => { (st[d] ||= []).push({ id: +n.species.url.split('/').slice(-2)[0], en: n.species.name }); n.evolves_to.forEach(x => walk(x, d + 1)); };
      walk(ch.chain, 0); POKE[dex].evo = st;
    } catch (e) {}
    try { localStorage.setItem('poke_cache', JSON.stringify(POKE)); } catch (e) {}
  } catch (e) { POKE[dex] = null; }
}
const SPR = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/';
// Sprite animado (Showdown); si no hay, el animado de Negro/Blanco y si no, el dibujo de HOME
const spriteList = (id, shiny) => { const sh = shiny ? 'shiny/' : ''; return [`${SPR}other/showdown/${sh}${id}.gif`, `${SPR}versions/generation-v/black-white/animated/${sh}${id}.gif`, `${SPR}other/home/${sh}${id}.png`]; };
const spriteTag = (id, shiny, cls, alt) => { const l = spriteList(id, shiny); return `<img class="${cls}" alt="${esc(alt)}" src="${l[0]}" data-fb="${l.slice(1).join(' ')}" onerror="const f=(this.dataset.fb||'').split(' ').filter(Boolean);if(f.length){this.dataset.fb=f.slice(1).join(' ');this.src=f[0]}else this.remove()">`; };
function dexName(id, en) {   // en España los nombres de los Pokémon son los ingleses: se busca la forma bonita en la base de datos
  if (!en) en = (POKE[id] && POKE[id].en) || '';
  const norm = t => (t || '').toLowerCase().replace(/[.'’]/g, '').replace(/[\s_]+/g, '-').replace(/♀/g, '-f').replace(/♂/g, '-m').replace(/--+/g, '-');
  const names = q(`SELECT name_en, count(*) n FROM cards WHERE dex_id = ? AND name_en IS NOT NULL GROUP BY name_en ORDER BY n DESC`, [id]).map(r => r.name_en);
  if (en) { const hit = names.find(n => norm(n) === norm(en)); if (hit) return hit; return en.replace(/(^|-)\w/g, m => m.toUpperCase()).replace(/-/g, ' '); }
  return names.find(n => !/\s(ex|EX|V|VMAX|VSTAR|GX|BREAK)$/.test(n) && !/^(Galarian|Alolan|Hisuian|Paldean|Dark|Light|Shining|Radiant)\s/.test(n)) || names[0] || '';
}
let SHINY = false;
function pokeInfoHTML(dex, name) {
  const p = POKE[dex];
  if (p === undefined) return `<span class="muted">Cargando información de ${esc(name)}…</span>`;
  if (!p) return '';
  const n = String(dex).padStart(4, '0');
  // Comparador de tamaño: tú (1,70 m) al lado del Pokémon, a la misma escala
  const H = 1.7, top = Math.max(p.h, H), px = 130, ph = Math.max(6, p.h / top * px), yh = H / top * px;
  const person = `<svg viewBox="0 0 40 100" style="height:${yh}px;width:auto" aria-hidden="true"><circle cx="20" cy="11" r="9" fill="currentColor"/><path d="M8 24 Q20 19 32 24 L35 58 L29 58 L28 40 L27 98 L21 98 L20 64 L19 98 L13 98 L12 40 L11 58 L5 58 Z" fill="currentColor"/></svg>`;
  const evo = (p.evo || []).filter(x => x.length);
  return `<div class="between"><b>Nº ${n}${p.gen ? ' · ' + esc(p.gen) : ''}</b><span class="row" style="gap:6px">${p.types.map(t => `<span class="tchip">${esc(t)}</span>`).join('')}</span></div>
    <div class="psprite">${spriteTag(dex, SHINY, 'anim', name)}<button class="pill ${SHINY ? 'on' : ''}" id="shiny" aria-pressed="${SHINY}" style="font-size:12px;display:flex;align-items:center;gap:5px;min-height:32px">${ico('sparkle', 14)}${SHINY ? 'Shiny' : 'Ver shiny'}</button></div>
    ${p.txt ? `<p style="margin:0;line-height:1.45">${esc(p.txt)}</p>` : ''}
    <span class="muted">${p.h.toLocaleString('es-ES')} m · ${p.w.toLocaleString('es-ES')} kg${p.gn ? ' · Generación ' + esc(p.gn) : ''}${p.leg ? ' · Legendario' : p.myth ? ' · Singular' : ''}</span>
    <details class="fold"><summary>Tamaño comparado contigo</summary><div class="sizecmp" aria-label="Comparación de tamaño">
      <div class="col" style="align-items:center"><div class="sz" style="height:${px}px;color:var(--tx3, #6b7280)">${person}</div><span class="muted">Tú · 1,70 m</span></div>
      <div class="col" style="align-items:center"><div class="sz" style="height:${px}px"><img alt="${esc(name)}" src="${SPR}other/official-artwork/${SHINY ? 'shiny/' : ''}${dex}.png" style="height:${ph}px;width:auto;max-width:${Math.max(ph, 40) * 1.4}px;object-fit:contain" onerror="this.remove()"></div><span class="muted">${esc(dexName(dex, p.en) || name)} · ${p.h.toLocaleString('es-ES')} m</span></div></div></details>
    ${evo.length > 1 ? `<details class="fold" open><summary>Cadena evolutiva</summary><div class="evo">${evo.map(st => `<div class="evost">${st.map(x => `<a href="#/dex/${x.id}" class="evomon ${x.id === dex ? 'on' : ''}">${spriteTag(x.id, false, 'mini', x.en).replace(/other\/showdown\/|versions\/generation-v\/black-white\/animated\//g, '').replace(/\.gif/g, '.png')}<span>${esc(dexName(x.id, x.en))}</span></a>`).join('')}</div>`).join('<span class="evoarr">›</span>')}</div></div>` : ''}`;
}
function wirePoke(dex, name) {
  const b = document.getElementById('shiny'); if (b) b.onclick = () => { SHINY = !SHINY; const el = document.getElementById('pinfo'); if (el) { el.innerHTML = pokeInfoHTML(dex, name); wirePoke(dex, name); } };
}
// Todas las cartas de un Pokémon (desde la cadena evolutiva)
let dexLang = 'es';
function viewDex(id) {
  const nm = dexName(id, ''), rows = q(`SELECT c.card_id, c.set_id, c.local_id, ${NAME} name, c.image_base, s.lang, s.release_date, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name, c.illustrator
    FROM cards c JOIN sets s USING(set_id) WHERE c.dex_id = ? AND s.lang = ? ORDER BY s.release_date, CAST(c.local_id AS INTEGER)`, [id, dexLang]);
  const vm = variantsOf(rows.map(r => r.card_id)), have = rows.filter(r => COL.cards[r.card_id]).length;
  LIST_CTX = rows.map(r => '#/card/' + encodeURIComponent(r.card_id));
  $view.innerHTML = `<div class="stack"><div class="row"><a href="javascript:history.back()" class="pill" style="display:flex;align-items:center" aria-label="Volver">←</a>
      <div style="width:64px;height:64px;display:flex;align-items:center;justify-content:center">${spriteTag(id, false, 'anim', nm)}</div><div class="col" style="flex:1"><h1>${esc(nm || 'Nº ' + id)}</h1><span class="muted">Nº ${String(id).padStart(4, '0')} · tienes ${have} de ${rows.length} cartas</span></div></div>
    <div class="tbrow">${seg('dl', [['es', 'Español'], ['ja', 'Japonés']], dexLang)}<span></span></div>
    <div class="list">${rows.map(r => `<a class="item" href="#/card/${encodeURIComponent(r.card_id)}">${img(r.image_base, 'thumb', '', r.card_id)}<div class="col" style="flex:1;min-width:0"><b>${esc(r.name)} ${COL.cards[r.card_id] ? '<span class="up">✓</span>' : ''}</b><span class="muted">${esc(r.set_name)} · ${esc(r.local_id)} · ${esc((r.release_date || '').slice(0, 4))}${r.illustrator ? ' · ' + esc(r.illustrator) : ''}</span></div><b>${eur(cheapest(vm[r.card_id]))}</b></a>`).join('') || '<p class="muted">No hay cartas de este Pokémon en este idioma.</p>'}</div></div>`;
  $view.querySelectorAll('[data-dl]').forEach(b => b.onclick = () => { dexLang = b.dataset.dl; viewDex(id); });
}

/* ---------- gestos en la ficha de una carta: deslizar hacia abajo para volver, a los lados para cambiar de carta ---------- */
let CARD_NAV = null;
(() => {
  let x0 = 0, y0 = 0, mode = '', dx = 0, dy = 0, ok = false;
  const onCard = () => location.hash.startsWith('#/card/') || location.hash.startsWith('#/ocard/');
  const reset = anim => { $view.style.transition = anim ? 'transform .2s, opacity .2s' : ''; $view.style.transform = ''; $view.style.opacity = ''; };
  document.addEventListener('touchstart', e => {
    ok = onCard() && e.touches.length === 1 && !e.target.closest('input,select,textarea,.chart,svg');
    if (!ok) return; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; mode = ''; dx = dy = 0; $view.style.transition = '';
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!ok) return; dx = e.touches[0].clientX - x0; dy = e.touches[0].clientY - y0;
    if (!mode) {
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) mode = 'h';
      else if (dy > 12 && window.scrollY <= 0 && dy > Math.abs(dx) * 1.3) mode = 'v';
      else if (Math.abs(dy) > 12) { ok = false; return; }
    }
    if (mode === 'v') { e.preventDefault(); $view.style.transform = `translateY(${Math.max(0, dy) * 0.55}px)`; $view.style.opacity = String(Math.max(0.4, 1 - dy / 600)); }
    if (mode === 'h') { e.preventDefault(); const edge = (dx > 0 && !CARD_NAV?.prev) || (dx < 0 && !CARD_NAV?.next); $view.style.transform = `translateX(${dx * (edge ? 0.15 : 0.5)}px)`; }
  }, { passive: false });
  document.addEventListener('touchend', () => {
    if (!ok || !mode) return; ok = false;
    const stop = ev => { ev.stopPropagation(); ev.preventDefault(); };
    document.addEventListener('click', stop, { capture: true, once: true }); setTimeout(() => document.removeEventListener('click', stop, { capture: true }), 400);
    if (mode === 'v' && dy > 110) {
      $view.style.transition = 'transform .18s, opacity .18s'; $view.style.transform = 'translateY(60vh)'; $view.style.opacity = '0';
      setTimeout(() => { reset(false); if (history.length > 1) history.back(); else location.hash = CARD_NAV && CARD_NAV.set ? '#/set/' + encodeURIComponent(CARD_NAV.set) : '#/sets'; }, 170);
    } else if (mode === 'h' && Math.abs(dx) > 70 && CARD_NAV && (dx < 0 ? CARD_NAV.next : CARD_NAV.prev)) {
      const id = dx < 0 ? CARD_NAV.next : CARD_NAV.prev;
      $view.style.transition = 'transform .15s, opacity .15s'; $view.style.transform = `translateX(${dx < 0 ? -40 : 40}vw)`; $view.style.opacity = '0';
      setTimeout(() => { reset(false); location.replace(id); $view.style.transform = `translateX(${dx < 0 ? 30 : -30}vw)`; $view.style.opacity = '0';
        requestAnimationFrame(() => requestAnimationFrame(() => reset(true))); }, 140);
    } else reset(true);
  });
})();
/* ---------- quién es o dónde está: partidarios y estadios (resúmenes de WikiDex, se generan cada día en GitHub) ---------- */
const TRAINER_KIND = { Supporter: 'Partidario', Stadium: 'Estadio' };
let TRAINERS = null, TRAINERS_P = null;
const loadTrainers = () => TRAINERS_P ||= fetch('entrenadores.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : {}).catch(() => ({})).then(d => (TRAINERS = d));
function trainerInfoHTML(c) {
  const t = TRAINERS && TRAINERS[c.name_es || c.name];
  if (!t || t.miss) return '';
  return `<div class="between"><b>${t.k === 'p' ? '👤 Quién es' : '📍 Dónde está'}</b><span class="row" style="gap:6px"><span class="tchip">${TRAINER_KIND[c.kind]}</span>${t.r ? `<span class="tchip">${esc(t.r)}</span>` : ''}</span></div>
    ${t.t !== c.name ? `<b style="font-size:17px">${esc(t.t)}</b>` : ''}
    <p style="margin:0;line-height:1.45">${esc(t.x)}</p>
    <a class="muted" style="font-size:13px" target="_blank" rel="noopener" href="https://www.wikidex.net/wiki/${encodeURIComponent(t.t.replace(/ /g, '_'))}">Fuente: WikiDex ↗</a>`;
}
function trainerAfter(c) {
  if (TRAINERS) return;
  loadTrainers().then(() => { const el = document.getElementById('tinfo'); if (!el) return; const h = trainerInfoHTML(c); if (h) { el.innerHTML = h; el.style.display = ''; } });
}
function viewCard(cardId) {
  const c = q(`SELECT c.*, COALESCE(c.name_es,c.name_en,c.name_ja,c.name_local) name, s.region, s.card_count, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name FROM cards c JOIN sets s USING(set_id) WHERE card_id=?`, [cardId])[0];
  if (!c) { $view.innerHTML = '<p>Carta no encontrada.</p>'; return; }
  const vs = variantsOf([cardId])[cardId] || [];
  const e = COL.cards[cardId];
  const order = q(`SELECT card_id FROM cards WHERE set_id=? ORDER BY CAST(local_id AS INTEGER), local_id`, [c.set_id]).map(r => r.card_id);
  const idx = order.indexOf(cardId), nav = cardNav(location.hash, order, c.set_id);
  const bidx = setBinderIds(c.set_id).indexOf(cardId);
  const albumPos = bidx >= 0 ? `📒 En tu archivador: ${spotTxt(binderSpot('set:' + c.set_id, bidx))}` : '';
  let sel = ownedVariant(cardId, vs) || vs.slice().sort((a, b) => (vPrice(a) ?? 1e9) - (vPrice(b) ?? 1e9))[0] || null;
  const draw = () => {
    const h = sel ? historyFor([sel.cm_product_id]).map(r => [r.day, (isRevHolo(sel) ? r.trend_holo_c : r.trend_c)]).filter(r => r[1] != null).map(r => [r[0], r[1] / 100]) : [];
    const p = vPrice(sel), hol = isRevHolo(sel);
    const al = sel ? COL.alerts[sel.cm_product_id + '|' + (sel.variant || '')] : null;
    const sl = COL.sell[cardId];
    const uv = uniqVariants(vs).filter(Boolean), ok = ownedKeys(cardId, vs);
    const [pc, pv] = e ? cardCost(cardId, p) : [0, 0], profit = pc ? pv - pc : null;
    const defLang = c.region === 'asia' ? 'JP' : 'ES';
    const cps = e ? copiesOf(cardId).map(x => Object.assign({ lang: defLang, cond: 'NM' }, x, { lang: x.lang || defLang, cond: x.cond || 'NM' })) : [];
    const sel_ = (name, i, opts, val, extra = '') => `<select data-cp="${i}" data-k="${name}" ${extra}>${opts.map(o => `<option ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    $view.innerHTML = `<div class="stack cardpage">
      <div class="grabber" aria-hidden="true"></div>
      <div class="row"><a href="#/set/${encodeURIComponent(c.set_id)}" class="pill" id="cback" style="display:flex;align-items:center" aria-label="Volver">←</a><span class="muted">${esc(c.set_name)} · ${esc(c.local_id)}${c.card_count ? '/' + c.card_count : ''}${c.rarity && c.rarity !== 'None' ? ' · ' + esc(c.rarity) : ''}</span></div>
      <div class="cardhero" style="${(!c.kind || c.kind === 'Pokemon') ? typeGlow(c.dex_id) : ''}">${cardImg(c, 'high', 'hero', c.name)}
        <h1>${esc(c.name)}</h1>${c.name_ja && c.name_ja !== c.name ? `<span class="muted">${esc(c.name_ja)}</span>` : ''}${c.name_en && c.name_en !== c.name ? `<span class="muted">${esc(c.name_en)}</span>` : ''}
        <div class="big">${eur(p)}</div>${(() => { const r = sel && realOf(sel.cm_product_id, hol); return realFresh(r)
          ? `<span class="realtag">✓ ${esc(realLabel(r))}${hol ? ' · reverse holo' : ''}</span>`
          : `<span class="muted">${PRICE_LABEL()}${hol ? ' (reverse holo)' : ''}${PRICE_MODE === 'low' ? ' · cualquier idioma y estado' : ''}${r ? ` · tu precio real es antiguo (${ageTxt(realAge(r))})` : ''}</span>`; })()}
        ${sel && sel.ambiguous ? '<span class="down" style="font-size:13px">Ojo: este precio podría corresponder a otra versión de la carta.</span>' : ''}
        ${sel ? `<div class="actions"><a class="btn cmbtn" id="cmgo" target="_blank" rel="noopener" href="${cmLink(sel, c)}">Ver en Cardmarket ${ico('external', 17)}</a>
          ${sel.cm_product_id ? `<button class="iconbtn lg" id="realset" aria-label="${realFresh(realOf(sel.cm_product_id, hol)) ? 'Cambiar' : 'Poner'} precio real">${ico('pencil', 20)}</button>` : ''}</div>` : ''}
        ${vs.length > 1 ? `<label class="f" style="width:100%;max-width:340px;text-align:left">Versión<select id="vsel">${vs.map((v, i) => `<option value="${i}" ${v === sel ? 'selected' : ''}>${esc(vLabel(v))} — ${eur(vPrice(v))}</option>`).join('')}</select></label>` : `<span class="muted">${sel ? esc(vLabel(sel)) : 'Sin precio en Cardmarket'}</span>`}
        <div class="metarow">${c.illustrator ? `<a class="meta" href="#/illustrator/${encodeURIComponent(c.illustrator)}">${ico('brush', 16)}${esc(c.illustrator)}</a>` : ''}${albumPos ? `<span class="meta">${ico('binder', 16)}${albumPos.replace(/^📒 En tu archivador: /, '')}</span>` : ''}</div>
        <div class="row" style="flex-wrap:wrap;gap:6px;justify-content:center"><label class="pill" style="display:flex;align-items:center;cursor:pointer;font-size:13px">${CUSTOM_IMG[cardId] ? 'Cambiar foto' : 'Poner mi foto'}<input type="file" id="cimg" accept="image/*" hidden></label>
          <button class="pill" id="curl" style="font-size:13px">Enlace</button>${CUSTOM_IMG[cardId] ? '<button class="pill" id="cdel" style="font-size:13px">Quitar</button>' : ''}</div></div>
      ${nav.html}
      ${c.dex_id && (!c.kind || c.kind === 'Pokemon') && POKE[c.dex_id] !== null ? `<div class="card col pinfo" id="pinfo">${pokeInfoHTML(c.dex_id, c.name)}</div>` : ''}
      ${TRAINER_KIND[c.kind] ? `<div class="card col pinfo" id="tinfo" ${trainerInfoHTML(c) ? '' : 'style="display:none"'}>${trainerInfoHTML(c)}</div>` : ''}
      ${sel ? `<div class="card col" style="gap:12px"><b>Cardmarket${hol ? ' · reverse holo' : ''}</b><div class="kpis">
        <div><span>Mínimo</span><b>${eur(hol ? sel.low_holo : sel.low)}</b></div><div><span>Tendencia</span><b>${eur(hol ? sel.trend_holo : sel.trend)}</b></div>
        <div><span>Media 7 días</span><b>${eur(hol ? sel.avg7_holo : sel.avg7)}</b></div><div><span>Media 30 días</span><b>${eur(hol ? sel.avg30_holo : sel.avg30)}</b></div></div>
        <span class="muted" style="font-size:12px;display:block;margin-top:8px">El botón de Cardmarket abre las ofertas de esta carta en ${c.region === 'asia' ? 'japonés' : 'español'} y desde estado ${cmCond()}. El estado mínimo se cambia en Ajustes.</span></div>` : ''}
      <div class="col" style="gap:8px"><h2>Evolución del precio</h2>${chartSvg(h, 700, 140)}</div>
      ${uv.length > 1 ? `<div class="card col" style="gap:8px"><b>Versiones para el máster set</b>${uv.map((v, i) => { const hv = (COL.hide || {})[cardId + '|' + vkey(v)]; return `<div class="row" style="min-height:40px;${hv ? 'opacity:.45' : ''}"><label class="row" style="flex:1;cursor:pointer"><input type="checkbox" data-mv="${i}" ${ok.has(vkey(v)) ? 'checked' : ''} style="width:20px;height:20px;accent-color:#3DDC97"><span style="flex:1">${esc(v ? vLabel(v) : 'Estándar')}${v && v.notEs ? ' <span class="muted">(no sale en español)</span>' : ''}${v && v.stamp ? ' <span class="muted">(promo con sello, fuera del máster set)</span>' : ''}</span><b>${eur(vPrice(v))}</b></label><button class="pill" style="font-size:12px;min-height:34px" data-hv="${i}">${hv ? 'Mostrar' : 'No existe'}</button></div>`; }).join('')}</div>` : ''}
      <button class="pill" id="hidecard" style="align-self:flex-start;font-size:13px">${(COL.hide || {})[cardId] ? 'Volver a mostrar esta carta en el set' : 'Esta carta no existe en español: ocultarla del set'}</button>
      <div class="card col" style="gap:12px"><b>${e ? 'En tu colección' : 'No la tienes'}</b>
        ${e ? `<span class="muted">Tus copias (${cps.length}). Si una está gradeada, pon su valor: la app no tiene precios de cartas gradeadas.</span>
          <div class="col" style="gap:10px">${cps.map((x, i) => `<div class="copy"><b class="muted" style="min-width:22px">#${i + 1}</b>
            <label class="f">Idioma${sel_('lang', i, COPY_LANGS, x.lang)}</label>
            <label class="f">Estado${sel_('cond', i, CONDS, x.cond, x.grader ? 'disabled' : '')}</label>
            <label class="f">Gradeo${sel_('grader', i, ['No'].concat(GRADERS), x.grader || 'No')}</label>
            ${x.grader ? `<label class="f">Nota<input type="text" data-cp="${i}" data-k="grade" value="${esc(x.grade || '')}" placeholder="10" style="width:64px"></label>
              <label class="f">Valor (€)<input type="number" step="0.01" min="0" data-cp="${i}" data-k="gval" value="${x.gval ?? ''}" style="width:100px"></label>` : ''}
            <label class="f">Pagaste (€)<input type="number" step="0.01" min="0" data-cp="${i}" data-k="buy" value="${x.buy ?? ''}" style="width:100px"></label>
            <button class="pill" data-cpdel="${i}" aria-label="Quitar copia ${i + 1}">✕</button></div>`).join('')}</div>
          ${profit != null ? `<span class="${profit >= 0 ? 'up' : 'down'}" style="font-weight:700">${profit >= 0 ? '+' : '−'}${eur(Math.abs(profit))} (${pct(profit / pc * 100)}) sobre lo que pagaste</span>` : ''}
          <div class="row" style="flex-wrap:wrap"><button class="btn sec" id="cpadd">＋ Añadir copia</button><button class="btn" id="save">Guardar</button><button class="btn warn" id="del">Quitar de la colección</button></div>`
        : `<button class="btn" id="add">＋ La tengo</button>`}</div>
      ${sel ? `<div class="card col" style="gap:12px"><b>${al ? '♥ En tu lista de deseos' : 'Lista de deseos'}</b>
        <label class="f" for="tg">Precio objetivo (opcional): te avisa si esta versión baja de</label>
        <div class="row" style="flex-wrap:wrap"><input type="number" id="tg" step="0.01" min="0" value="${al && al.target ? al.target : ''}" placeholder="${p != null ? (Math.floor(p * 0.9 * 100) / 100) : ''}" style="flex:1;min-width:120px">
        <button class="btn" id="setal">${al ? 'Guardar' : '♡ La quiero'}</button>${al ? '<button class="btn sec" id="delal">Quitar</button>' : ''}</div></div>` : ''}
      ${e ? `<div class="card col" style="gap:12px"><b>${sl ? 'A la venta' : 'Vender'}</b>
        ${sl ? `<span class="muted">Pides ${eur(sl.price)} · ${esc(sl.cond)} · ${esc(sl.lang)} · ${sl.qty} ud.</span><div class="row"><a class="btn sec" style="display:flex;align-items:center" href="#/sell">Ver lista de venta</a><button class="btn warn" id="unsell">Quitar de venta</button></div>`
        : `<span class="muted">Precio sugerido: ${eur(p)} (tendencia) · mínimo actual ${eur(hol ? sel && sel.low_holo : sel && sel.low)}</span><button class="btn sec" id="sell">Poner a la venta</button>`}</div>` : ''}
    </div>`;
    $view.querySelectorAll('[data-mv]').forEach(x => x.onchange = () => { toggleVariant(cardId, c.set_id, uv[+x.dataset.mv], vs); viewCard(cardId); });
    $view.querySelectorAll('[data-hv]').forEach(b => b.onclick = () => { COL.hide ||= {}; const k = cardId + '|' + vkey(uv[+b.dataset.hv]); if (COL.hide[k]) delete COL.hide[k]; else COL.hide[k] = 1; saveCol(); viewCard(cardId); });
    const hc = document.getElementById('hidecard'); if (hc) hc.onclick = () => { COL.hide ||= {}; if (COL.hide[cardId]) delete COL.hide[cardId]; else COL.hide[cardId] = 1; saveCol(); toast(COL.hide[cardId] ? 'Oculta del set' : 'Visible de nuevo'); viewCard(cardId); };
    const ci = document.getElementById('cimg'); if (ci) ci.onchange = async ev => { const f = ev.target.files[0]; if (!f) return; try { const u = await resizeImage(f); CUSTOM_IMG[cardId] = u; await idbPut('img:' + cardId, u); imgsDirty = true; saveCol(); toast('Imagen guardada'); draw(); } catch (e) { alert(e.message); } };
    const rs = document.getElementById('realset'); if (rs) rs.onclick = () => askRealPrice(sel.cm_product_id, hol, c.region === 'asia' ? 'JP' : 'ES', draw);
    const cg = document.getElementById('cmgo'); if (cg && sel && sel.cm_product_id) cg.addEventListener('click', () => armAskReal(sel.cm_product_id, hol, c.region === 'asia' ? 'JP' : 'ES'));
    const cu = document.getElementById('curl'); if (cu) cu.onclick = async () => { const u = prompt('Pega el enlace de una imagen de la carta (https://…)'); if (!u || !/^https:\/\//.test(u.trim())) return; CUSTOM_IMG[cardId] = u.trim(); await idbPut('img:' + cardId, u.trim()); imgsDirty = true; saveCol(); draw(); };
    const cd = document.getElementById('cdel'); if (cd) cd.onclick = async () => { delete CUSTOM_IMG[cardId]; await idbDel('img:' + cardId); imgsDirty = true; saveCol(); draw(); };
    const vsel = document.getElementById('vsel'); if (vsel) vsel.onchange = () => { sel = vs[+vsel.value]; if (COL.cards[cardId]) { COL.cards[cardId].cm = sel.cm_product_id; COL.cards[cardId].variant = sel.variant; saveCol(); } draw(); };
    const add = document.getElementById('add'); if (add) add.onclick = () => { COL.cards[cardId] = { set: c.set_id, cm: sel ? sel.cm_product_id : null, variant: sel ? sel.variant : null, qty: 1 }; saveCol(); viewCard(cardId); };
    // Copias: se editan sobre "cps" y se guardan con el botón Guardar (o al añadir/quitar)
    const readCopies = () => { $view.querySelectorAll('[data-cp]').forEach(el => { const i = +el.dataset.cp, k = el.dataset.k; let v = el.value;
      if (k === 'buy' || k === 'gval') v = v === '' ? null : parseFloat(v); if (k === 'grader' && v === 'No') v = null; cps[i][k] = v; }); };
    const storeCopies = () => { const ent = COL.cards[cardId]; ent.copies = cps.map(x => Object.assign({}, x, x.grader ? {} : { grade: undefined, gval: undefined })); ent.qty = cps.length;
      const buys = cps.map(x => x.buy).filter(x => x != null); ent.buy = buys.length ? Math.round(buys.reduce((t, x) => t + x, 0) / buys.length * 100) / 100 : null; saveCol(); };
    $view.querySelectorAll('select[data-k="grader"]').forEach(el => el.onchange = () => { readCopies(); storeCopies(); draw(); });
    const cpadd = document.getElementById('cpadd'); if (cpadd) cpadd.onclick = () => { readCopies(); cps.push({ lang: defLang, cond: 'NM', buy: null }); storeCopies(); draw(); };
    $view.querySelectorAll('[data-cpdel]').forEach(b => b.onclick = () => { readCopies(); cps.splice(+b.dataset.cpdel, 1); if (!cps.length) { delete COL.cards[cardId]; saveCol(); viewCard(cardId); return; } storeCopies(); draw(); });
    const save = document.getElementById('save'); if (save) save.onclick = () => { readCopies(); storeCopies(); toast('Guardado'); draw(); };
    const del = document.getElementById('del'); if (del) del.onclick = () => { delete COL.cards[cardId]; saveCol(); viewCard(cardId); };
    const sa = document.getElementById('setal'); if (sa) sa.onclick = () => { const v = document.getElementById('tg').value, t = v === '' ? null : parseFloat(v); COL.alerts[sel.cm_product_id + '|' + (sel.variant || '')] = { card: cardId, cm: sel.cm_product_id, variant: sel.variant, target: t > 0 ? t : null, created: (al && al.created) || PRICE_DATE }; saveCol(); toast('Guardada en tu lista de deseos'); draw(); };
    const da = document.getElementById('delal'); if (da) da.onclick = () => { delete COL.alerts[sel.cm_product_id + '|' + (sel.variant || '')]; saveCol(); draw(); };
    const se = document.getElementById('sell'); if (se) se.onclick = () => { COL.sell[cardId] = { qty: 1, price: p != null ? Math.round(p * 100) / 100 : null, cond: 'NM', lang: c.region === 'asia' ? 'JP' : 'ES', cm: sel ? sel.cm_product_id : null, variant: sel ? sel.variant : null }; saveCol(); toast('Añadida a tu lista de venta'); draw(); };
    const us = document.getElementById('unsell'); if (us) us.onclick = () => { delete COL.sell[cardId]; saveCol(); draw(); };
  };
  draw();
  if (c.dex_id && (!c.kind || c.kind === 'Pokemon')) pokeAfter(c.dex_id, c.name);
  if (TRAINER_KIND[c.kind]) trainerAfter(c);
}

/* ---------- lista de deseos (con precio objetivo = alerta) ---------- */
function alertStatus() {
  const list = Object.entries(COL.alerts).map(([k, a]) => Object.assign({ key: k }, a));
  if (!list.length || !DB) return [];
  const ids = [...new Set(list.map(a => a.cm))];
  const pr = {}; q(`SELECT * FROM prices WHERE cm_product_id IN (${ids.map(() => '?').join(',')})`, ids).forEach(r => pr[r.cm_product_id] = r);
  const info = {}; q(`SELECT c.card_id, ${NAME} name, c.local_id, c.image_base, s.lang, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name FROM cards c JOIN sets s USING(set_id) WHERE c.card_id IN (${list.map(() => '?').join(',')})`, list.map(a => a.card)).forEach(r => info[r.card_id] = r);
  const vm = variantsOf([...new Set(list.map(a => a.card))]);
  return list.map(a => {
    const vr = (vm[a.card] || []).find(v => v.cm_product_id === a.cm && (v.variant || '') === (a.variant || '')) || Object.assign({ variant: a.variant }, pr[a.cm] || {});
    const now = vPrice(vr), low = isRevHolo(vr) ? vr.low_holo : vr.low; a.vr = vr;
    const ratio = a.target && now != null ? now / a.target : null;
    return Object.assign(a, { now, low, ratio, hit: !!a.target && now != null && now <= a.target, lowHit: !!a.target && low != null && low <= a.target, info: info[a.card] || { name: (a.name || 'Carta').split(' · ')[0], local_id: '', set_name: (a.name || '').split(' · ').slice(1).join(' · '), image_base: null, img: a.img } });
  }).sort((x, y) => (x.ratio == null) - (y.ratio == null) || (x.ratio ?? 0) - (y.ratio ?? 0) || (x.now ?? 1e9) - (y.now ?? 1e9));
}
/* Alertas vistas: al abrir Deseos se dan por vistas y se quitan el aviso de la portada y las notificaciones del móvil */
function seenAlerts() { try { return JSON.parse(localStorage.getItem('9b.alertSeen') || '{}'); } catch (e) { return {}; } }
function alertSeen(a) { const p = seenAlerts()[a.key]; return p != null && a.now != null && a.now >= p - 0.005; }
function markAlertsSeen(list) {
  const s = {}; list.filter(a => a.hit && a.now != null).forEach(a => { s[a.key] = a.now; });
  try { localStorage.setItem('9b.alertSeen', JSON.stringify(s)); } catch (e) {}
  try { if (navigator.clearAppBadge) navigator.clearAppBadge(); } catch (e) {}
  if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then(r => r && r.getNotifications ? r.getNotifications() : []).then(ns => ns.forEach(n => { const u = (n.data && n.data.url) || ''; if (!u || /#\/(wish|alerts)/.test(u)) n.close(); })).catch(() => {});
}
function viewWishlist() {
  const list = alertStatus();
  markAlertsSeen(list);
  const total = list.reduce((t, a) => t + (a.now || 0), 0);
  const hits = list.filter(a => a.hit), hitsCost = hits.reduce((t, a) => t + (a.now || 0), 0);
  const lowTotal = list.reduce((t, a) => t + (a.low ?? a.now ?? 0), 0);
  $view.innerHTML = `<div class="stack"><h1>Lista de deseos</h1>
    ${list.length ? `<div class="card col" style="gap:6px"><span class="muted">${list.length} carta${list.length > 1 ? 's' : ''} · comprarlo todo hoy</span>
      <div class="big">${eur(total)}</div>
      <span class="muted">Al precio mínimo publicado: <b style="color:var(--tx)">${eur(lowTotal)}</b>${hits.length ? ` · <span class="up">${hits.length} ya ${hits.length > 1 ? 'están' : 'está'} en tu objetivo (${eur(hitsCost)})</span>` : ''}</span></div>
      <div class="list">${list.map(a => {
        const near = a.ratio == null ? 'Sin precio objetivo' : a.hit ? '¡Ya está en tu objetivo!' : `A un ${Math.round((a.ratio - 1) * 100)} % de tu objetivo`;
        return `<div class="item" style="${a.hit ? 'background:#12271D;border-radius:10px;padding:10px' : ''}">
        <a href="${a.card ? '#/card/' + encodeURIComponent(a.card) : esc(a.route || '#/wish')}" style="display:flex;gap:12px;align-items:center;flex:1;color:var(--tx)">${a.card ? img(a.info.image_base, 'thumb', '', a.card) : a.info.img ? `<img class="thumb" loading="lazy" src="${esc(a.info.img)}" alt="">` : '<div class="thumb"></div>'}<div class="col" style="flex:1"><b>${esc(a.info.name)}${a.info.local_id ? ' · ' + esc(a.info.local_id) : ''}</b><span class="muted">${a.card ? esc(a.info.set_name) + ' · ' + esc(vLabel(a.vr || { variant: a.variant })) : esc(a.info.set_name) + ' · Japonesa'}</span>
        <span style="font-size:13px" class="${a.hit ? 'up' : ''}">${near}${a.target ? ` · objetivo ${eur(a.target)}` : ''}${!a.hit && a.lowHit ? ` · <span class="up">hay ofertas desde ${eur(a.low)}</span>` : ''}</span></div>
        <b>${eur(a.now)}</b></a><button class="pill" data-bought="${esc(a.key)}" title="La he comprado">✓</button></div>`;
      }).join('')}</div>`
      : `<div class="card muted">Tu lista está vacía. Abre cualquier carta y pulsa "♡ La quiero". Si le pones un precio objetivo, te avisa cuando baje.</div>`}
    <p class="muted">Ordenadas de la más cercana a tu objetivo a la más lejana. "✓" la pasa a tu colección y apunta la compra en tus gastos.</p></div>`;
  $view.querySelectorAll('[data-bought]').forEach(b => b.onclick = () => {
    const a = list.find(x => x.key === b.dataset.bought); if (!a) return;
    const v = prompt(`¿Cuánto has pagado por ${a.info.name}? (€)`, a.now != null ? a.now.toFixed(2).replace('.', ',') : '');
    if (v === null) return;
    const price = parseFloat(String(v).replace(',', '.')) || null;
    if (!a.card) { COL.extra[a.cm] = { qty: 1, added: PRICE_DATE, buy: price }; COL.purchases.push({ id: Date.now(), date: new Date().toISOString().slice(0, 10), type: 'single', desc: a.info.name, qty: 1, price, shop: '', cm: a.cm }); delete COL.alerts[a.key]; saveCol(); toast('Añadida a tu colección y a tus gastos'); viewWishlist(); return; }
    const cur = COL.cards[a.card];
    if (cur) { cur.qty = (cur.qty || 1) + 1; if (cur.copies) cur.copies.push({ lang: null, cond: 'NM', buy: price }); } else COL.cards[a.card] = { set: a.card.slice(0, a.card.lastIndexOf('-')), cm: a.cm, variant: a.variant, qty: 1, buy: price };
    COL.purchases.push({ id: Date.now(), date: new Date().toISOString().slice(0, 10), type: 'single', desc: a.info.name + ' · ' + a.info.set_name, qty: 1, price, shop: '', card: a.card, cm: a.cm, variant: a.variant });
    delete COL.alerts[a.key]; saveCol(); toast('Añadida a tu colección y a tus gastos'); viewWishlist();
  });
}

/* ---------- utilidades de productos ---------- */
const TYPES = { single: 'Carta suelta', sobres: 'Sobres', etb: 'ETB', caja: 'Caja / display', lata: 'Lata / colección', otro: 'Otro' };
function sealedPrices(ids) {
  const out = {}; if (!ids.length) return out;
  q(`SELECT p.cm_product_id, p.name, p.category, pr.trend, pr.avg30, pr.avg7, pr.low, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name, s.set_id, p.cm_expansion_id,
     (SELECT image_base FROM cards c WHERE c.set_id = s.set_id LIMIT 1) ib
     FROM cm_products p LEFT JOIN prices pr USING(cm_product_id) LEFT JOIN sets s ON s.set_id = (SELECT MIN(set_id) FROM sets x WHERE x.cm_expansion_id = p.cm_expansion_id)
     WHERE p.cm_product_id IN (${ids.map(() => '?').join(',')})`, ids).forEach(r => out[r.cm_product_id] = r);
  return out;
}
function purchaseValue(pu, cardPrice, sealed) {
  if (pu.card) { const v = cardPrice[pu.card]; return v != null ? v * (pu.qty || 1) : null; }
  if (pu.cm && sealed[pu.cm]) { const r = sealed[pu.cm]; const p = rPrice(r); return p != null ? p * (pu.qty || 1) : null; }
  return null;
}
function parseNum(v) { if (v == null) return null; v = String(v).replace(/[€\s]/g, ''); if (/,\d{1,2}$/.test(v)) v = v.replace(/\./g, '').replace(',', '.'); const n = parseFloat(v); return isNaN(n) ? null : n; }
function parseDate(v) {
  v = String(v || '').trim(); let m;
  if ((m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if ((m = v.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/))) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  return null;
}
function parseCsv(text) {
  const first = text.split(/\r?\n/)[0] || ''; const d = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : (first.includes('\t') ? '\t' : ',');
  const rows = []; let row = [], cur = '', inq = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inq) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inq = false; else cur += ch; }
    else if (ch === '"') inq = true; else if (ch === d) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
function downloadFile(name, text, type = 'text/csv') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: type + ';charset=utf-8' })); a.download = name; a.click();
}
const csvCell = v => { v = v == null ? '' : String(v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

/* ---------- gastos ---------- */
let linkPick = null;
function viewExpenses() {
  const P = COL.purchases.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id - a.id);
  const cardIds = [...new Set(P.filter(p => p.card).map(p => p.card))], vm = variantsOf(cardIds), cardPrice = {};
  cardIds.forEach(id => { const vs = vm[id] || []; const pu = P.find(p => p.card === id); const v = vs.find(x => x.cm_product_id === pu.cm && (x.variant || '') === (pu.variant || '')) || vs[0]; cardPrice[id] = vPrice(v); });
  const sealed = sealedPrices([...new Set(P.filter(p => !p.card && p.cm).map(p => p.cm))]);
  const total = P.reduce((t, p) => t + (p.price || 0), 0);
  const month = new Date().toISOString().slice(0, 7), mTotal = P.filter(p => (p.date || '').startsWith(month)).reduce((t, p) => t + (p.price || 0), 0);
  let linkedCost = 0, linkedVal = 0;
  P.forEach(p => { const v = purchaseValue(p, cardPrice, sealed); if (v != null && p.price) { linkedCost += p.price; linkedVal += v; } });
  const months = []; const d0 = new Date(); d0.setDate(1);
  for (let i = 11; i >= 0; i--) { const d = new Date(d0); d.setMonth(d0.getMonth() - i); const k = d.toISOString().slice(0, 7); months.push([k, P.filter(p => (p.date || '').startsWith(k)).reduce((t, p) => t + (p.price || 0), 0)]); }
  const mx = Math.max(1, ...months.map(m => m[1]));
  const byType = {}; P.forEach(p => byType[p.type] = (byType[p.type] || 0) + (p.price || 0));
  const shops = [...new Set(P.map(p => p.shop).filter(Boolean))];
  $view.innerHTML = `<div class="stack"><div class="row"><a href="#/more" class="pill" style="display:flex;align-items:center">←</a><h1>Gastos</h1></div>
    <div class="card col" style="gap:6px"><span class="muted">Gastado en total</span><div class="big">${eur(total)}</div>
      <span class="muted">Este mes: <b style="color:var(--tx)">${eur(mTotal)}</b>${linkedCost ? ` · Lo que compraste (cartas y sellado con precio) hoy vale <b style="color:var(--tx)">${eur(linkedVal)}</b> <span class="${linkedVal >= linkedCost ? 'up' : 'down'}">(${pct((linkedVal - linkedCost) / linkedCost * 100)})</span>` : ''}</span></div>
    <div class="card col" style="gap:8px"><b>Por mes</b>
      <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:4px;align-items:end;height:120px">${months.map(([k, v]) => `<div title="${k}: ${eur(v)}" style="height:${Math.max(2, v / mx * 100)}%;background:${k === month ? 'var(--up)' : '#2D5A45'};border-radius:3px"></div>`).join('')}</div>
      <div style="display:grid;grid-template-columns:repeat(12,1fr);gap:4px" class="muted">${months.map(([k]) => `<span style="font-size:10px;text-align:center">${'EFMAMJJASOND'[+k.slice(5) - 1]}</span>`).join('')}</div>
      ${Object.keys(byType).length ? `<div class="row muted" style="flex-wrap:wrap;gap:14px">${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, v]) => `<span>${esc(TYPES[t] || t)} <b style="color:var(--tx)">${eur(v)}</b></span>`).join('')}</div>` : ''}</div>
    <div class="card col" style="gap:10px" id="newp"><b>Nueva compra</b>
      <div class="row" style="flex-wrap:wrap">
        <label class="f">Fecha<input type="date" id="pd" value="${new Date().toISOString().slice(0, 10)}"></label>
        <label class="f">Tipo<select id="pt">${Object.entries(TYPES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label class="f">Cantidad<input type="number" id="pq" value="1" min="1" style="width:80px"></label>
        <label class="f">Precio total (€)<input type="number" id="pp" step="0.01" min="0" style="width:120px"></label>
        <label class="f">Tienda<input type="text" id="ps" list="shops" placeholder="Cardmarket, Padis…" style="width:160px"><datalist id="shops">${shops.map(s => `<option value="${esc(s)}">`).join('')}</datalist></label></div>
      <label class="f">Qué es<input type="text" id="pdesc" placeholder="Ej.: 3 sobres de Oscuridad Absoluta"></label>
      <label class="f">Vincular a una carta o producto sellado (opcional, para saber cuánto vale hoy)<input type="search" id="plink" placeholder="Busca por nombre…"></label>
      <div id="plinkres" class="list"></div><div id="plinked"></div>
      <button class="btn" id="padd">Guardar compra</button></div>
    <div class="col"><div class="between"><h2>Compras</h2><div class="row">
      <label class="pill" style="display:flex;align-items:center;cursor:pointer">Importar CSV<input type="file" id="pimp" accept=".csv,.txt" hidden></label>
      <button class="pill" id="pexp">Exportar CSV</button></div></div>
      <div class="list">${P.map(p => { const v = purchaseValue(p, cardPrice, sealed); return `<div class="item"><div class="col" style="flex:1"><b>${esc(p.desc || TYPES[p.type])}</b><span class="muted">${esc(p.date ? p.date.split('-').reverse().join('/') : '')} · ${esc(TYPES[p.type] || p.type)}${p.qty > 1 ? ' · ' + p.qty + ' ud.' : ''}${p.shop ? ' · ' + esc(p.shop) : ''}</span>
        ${v != null ? `<span style="font-size:13px" class="${p.price && v < p.price ? 'down' : 'up'}">Hoy vale ${eur(v)}</span>` : ''}</div><b>${eur(p.price)}</b><button class="pill" data-delp="${p.id}" aria-label="Borrar compra">✕</button></div>`; }).join('') || '<p class="muted">Aún no has apuntado compras. Puedes importar tu Excel guardándolo como CSV (columnas: fecha, descripción, tipo, cantidad, precio, tienda).</p>'}</div></div></div>`;
  const pl = document.getElementById('plink'); let t = null;
  const showLinked = () => { document.getElementById('plinked').innerHTML = linkPick ? `<div class="row card" style="padding:10px"><span style="flex:1">Vinculada: <b>${esc(linkPick.label)}</b></span>${linkPick.card ? '<label class="row muted"><input type="checkbox" id="padcol" checked> Añadir a mi colección</label>' : '<label class="row muted"><input type="checkbox" id="padcol" checked> Añadir a mi sellado</label>'}<button class="pill" id="punlink">✕</button></div>` : '';
    const u = document.getElementById('punlink'); if (u) u.onclick = () => { linkPick = null; showLinked(); }; };
  pl.oninput = () => { clearTimeout(t); t = setTimeout(() => {
    const v = pl.value.trim(); const box = document.getElementById('plinkres');
    if (v.length < 2) { box.innerHTML = ''; return; }
    const like = '%' + v + '%';
    const cs = q(`SELECT c.card_id, ${NAME} name, c.local_id, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name FROM cards c JOIN sets s USING(set_id) WHERE c.name_es LIKE ? OR c.name_en LIKE ? OR c.name_ja LIKE ? ORDER BY s.release_date DESC LIMIT 8`, [like, like, like]);
    const ss = q(`SELECT cm_product_id, name, category FROM cm_products WHERE kind='sealed' AND name LIKE ? ORDER BY cm_product_id DESC LIMIT 8`, [like]);
    box.innerHTML = cs.map(c => `<button class="item pill" style="width:100%;justify-content:flex-start;margin:2px 0" data-lc="${esc(c.card_id)}" data-ll="${esc(c.name + ' · ' + c.set_name + ' · ' + c.local_id)}">${esc(c.name)} · ${esc(c.set_name)} · ${esc(c.local_id)}</button>`).join('')
      + ss.map(x => `<button class="item pill" style="width:100%;justify-content:flex-start;margin:2px 0" data-ls="${x.cm_product_id}" data-ll="${esc(x.name)}">${esc(x.name)} <span class="muted">· ${esc(x.category.replace('Pokémon ', ''))}</span></button>`).join('');
    box.querySelectorAll('[data-ll]').forEach(b => b.onclick = () => {
      if (b.dataset.lc) { const vs = variantsOf([b.dataset.lc])[b.dataset.lc] || []; const vv = vs.slice().sort((a, c) => (vPrice(a) ?? 1e9) - (vPrice(c) ?? 1e9))[0]; linkPick = { card: b.dataset.lc, cm: vv ? vv.cm_product_id : null, variant: vv ? vv.variant : null, label: b.dataset.ll }; document.getElementById('pt').value = 'single'; }
      else { linkPick = { cm: +b.dataset.ls, label: b.dataset.ll }; const n = b.dataset.ll.toLowerCase(); document.getElementById('pt').value = n.includes('elite trainer') ? 'etb' : n.includes('booster box') || n.includes('display') ? 'caja' : n.includes('tin') ? 'lata' : n.includes('booster') ? 'sobres' : 'otro'; }
      if (!document.getElementById('pdesc').value) document.getElementById('pdesc').value = b.dataset.ll;
      box.innerHTML = ''; pl.value = ''; showLinked();
    });
  }, 200); };
  showLinked();
  document.getElementById('padd').onclick = () => {
    const price = parseNum(document.getElementById('pp').value), qty = Math.max(1, parseInt(document.getElementById('pq').value, 10) || 1);
    const desc = document.getElementById('pdesc').value.trim();
    if (price == null && !desc) { toast('Pon al menos qué es y el precio'); return; }
    const pu = { id: Date.now(), date: document.getElementById('pd').value, type: document.getElementById('pt').value, desc, qty, price, shop: document.getElementById('ps').value.trim() };
    if (linkPick) Object.assign(pu, { card: linkPick.card || null, cm: linkPick.cm || null, variant: linkPick.variant || null });
    const addc = document.getElementById('padcol');
    if (linkPick && addc && addc.checked) {
      const unit = price != null ? Math.round(price / qty * 100) / 100 : null;
      if (linkPick.card) { const cur = COL.cards[linkPick.card]; if (cur) { cur.qty = (cur.qty || 1) + qty; if (cur.copies) for (let i = 0; i < qty; i++) cur.copies.push({ lang: null, cond: 'NM', buy: unit }); } else COL.cards[linkPick.card] = { set: linkPick.card.slice(0, linkPick.card.lastIndexOf('-')), cm: linkPick.cm, variant: linkPick.variant, qty, buy: unit }; }
      else { const cur = COL.sealed[linkPick.cm]; if (cur) { cur.buy = cur.buy && unit ? Math.round(((cur.buy * (cur.qty || 1)) + unit * qty) / ((cur.qty || 1) + qty) * 100) / 100 : (cur.buy || unit); cur.qty = (cur.qty || 1) + qty; } else COL.sealed[linkPick.cm] = { qty, buy: unit }; }
    }
    COL.purchases.push(pu); linkPick = null; saveCol(); toast('Compra guardada'); viewExpenses();
  };
  $view.querySelectorAll('[data-delp]').forEach(b => b.onclick = () => { if (!confirm('¿Borrar esta compra? (no quita la carta de tu colección)')) return; COL.purchases = COL.purchases.filter(p => p.id !== +b.dataset.delp); saveCol(); viewExpenses(); });
  document.getElementById('pexp').onclick = () => downloadFile(`9bolsillos-gastos-${new Date().toISOString().slice(0, 10)}.csv`,
    ['fecha;descripcion;tipo;cantidad;precio;tienda'].concat(P.map(p => [p.date, p.desc, TYPES[p.type] || p.type, p.qty, p.price != null ? String(p.price).replace('.', ',') : '', p.shop].map(csvCell).join(';'))).join('\n'));
  document.getElementById('pimp').onchange = async ev => {
    const f = ev.target.files[0]; if (!f) return;
    const rows = parseCsv(await f.text()); if (rows.length < 2) { alert('El archivo está vacío'); return; }
    const H = rows[0].map(h => h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim());
    const col = (...names) => H.findIndex(h => names.some(n => h.includes(n)));
    const ci = { date: col('fecha', 'date', 'dia'), desc: col('descrip', 'concepto', 'producto', 'articulo', 'nombre', 'item'), type: col('tipo', 'categoria', 'type'), qty: col('cantidad', 'unidades', 'qty', 'uds'), price: col('precio', 'importe', 'total', 'coste', 'price', 'euros'), shop: col('tienda', 'lugar', 'shop', 'vendedor', 'donde') };
    if (ci.price < 0 || (ci.date < 0 && ci.desc < 0)) { alert('No encuentro las columnas. La primera fila tiene que tener nombres como: fecha, descripción, tipo, cantidad, precio, tienda.'); return; }
    const guessType = t => { t = (t || '').toLowerCase(); return /etb|elite/.test(t) ? 'etb' : /caja|display|box/.test(t) ? 'caja' : /lata|tin|colecc/.test(t) ? 'lata' : /sobre|booster|pack/.test(t) ? 'sobres' : /carta|single|suelta/.test(t) ? 'single' : 'otro'; };
    let n = 0; const base = Date.now();
    rows.slice(1).forEach((r, i) => {
      const price = ci.price >= 0 ? parseNum(r[ci.price]) : null, desc = ci.desc >= 0 ? (r[ci.desc] || '').trim() : '';
      if (price == null && !desc) return;
      COL.purchases.push({ id: base + i, date: ci.date >= 0 ? parseDate(r[ci.date]) : null, type: guessType(ci.type >= 0 ? r[ci.type] : desc), desc, qty: ci.qty >= 0 ? (parseInt(r[ci.qty], 10) || 1) : 1, price, shop: ci.shop >= 0 ? (r[ci.shop] || '').trim() : '' }); n++;
    });
    saveCol(); toast(`${n} compras importadas`); viewExpenses();
  };
}

/* ---------- sellado ---------- */
function viewSealed() {
  const ids = Object.keys(COL.sealed).map(Number), info = sealedPrices(ids);
  const hist = {}; historyFor(ids).forEach(h => { if (h.trend_c != null) (hist[h.cm_product_id] ||= []).push([h.day, h.trend_c / 100]); });
  let cost = 0, val = 0, units = 0;
  const rows = ids.map(id => { const e = COL.sealed[id], r = info[id] || {}, now = rPrice(r), qty = e.qty || 1;
    units += qty; if (now != null) val += now * qty; if (e.buy != null && now != null) cost += e.buy * qty;
    const g = e.buy != null && now != null ? (now - e.buy) * qty : null;
    return { id, e, r, now, qty, g }; }).sort((a, b) => (b.now || 0) * b.qty - (a.now || 0) * a.qty);
  const withBuy = rows.filter(x => x.g != null), gain = withBuy.reduce((t, x) => t + x.g, 0);
  // valor del sellado día a día (solo días con precio de todos los productos que tenían precio)
  const days = {}; Object.entries(hist).forEach(([id, h]) => h.forEach(([d, v]) => days[d] = (days[d] || 0) + v * ((COL.sealed[id] || {}).qty || 1)));
  const series = Object.entries(days).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([d, v]) => [d, v]);
  $view.innerHTML = `<div class="stack"><div class="row"><a href="#/more" class="pill" style="display:flex;align-items:center" aria-label="Volver">←</a><h1 style="flex:1">Sellado</h1>
      <button class="pill" id="sadd2" style="display:flex;align-items:center;gap:6px">＋ Añadir</button></div>
    <div class="sealhero"><span class="sk">Valor de tu sellado</span><span class="sv">${eur(val)}</span>
      <span class="sk">${units} producto${units === 1 ? '' : 's'}${withBuy.length ? ` · pagaste ${eur(cost)} · <b style="color:${gain >= 0 ? '#3DDC97' : '#F2A65A'}">${gain >= 0 ? '+' : '−'}${eur(Math.abs(gain))} (${pct(cost ? gain / cost * 100 : 0)})</b>` : ''}</span>
      ${series.length > 1 ? `<div style="margin-top:8px">${chartSvg(series, 700, 90)}</div>` : ''}</div>
    <div id="sfind" class="col" style="gap:8px;display:none"><input type="search" id="sq2" placeholder="Busca: Elite Trainer Box Fulgor Negro, caja de sobres…"><div class="list" id="sres"></div></div>
    ${rows.length ? `<div class="sgal">${rows.map(x => `<a class="scard" href="#/sealeditem/${x.id}">
        <div class="sphoto">${CUSTOM_IMG['sealed:' + x.id] ? `<img src="${CUSTOM_IMG['sealed:' + x.id]}" alt="">` : sealedPhoto(x.r) ? sealedPhotoTag(x.r, x.r.ib) : sealedArt(x.r, x.r.ib)}
          ${x.qty > 1 ? `<span class="sqty">×${x.qty}</span>` : ''}
          ${CUSTOM_IMG['sealed:' + x.id] || sealedPhoto(x.r) ? '' : `<label class="sphotobtn" aria-label="Hacer foto" onclick="event.stopPropagation()">${ico('camera', 18)}<input type="file" accept="image/*" capture="environment" data-sphoto="${x.id}" hidden></label>`}</div>
        <div class="sinfo"><span class="stype">${esc(SEALED_LABEL[x.r.category] || (x.r.category || '').replace('Pokémon ', ''))}${x.r.set_name ? ' · ' + esc(x.r.set_name) : ''}</span>
          <b class="sname">${esc(x.r.name || 'Producto ' + x.id)}</b>
          <div class="between"><b>${eur(x.now)}</b>${x.g != null ? `<span class="schip ${x.g >= 0 ? 'up' : 'down'}">${pct((x.now - x.e.buy) / x.e.buy * 100)}</span>` : ''}</div></div></a>`).join('')}</div>`
      : '<div class="card col" style="gap:8px;align-items:flex-start"><b>Aún no tienes producto sellado</b><span class="muted">Pulsa «＋ Añadir» y busca tus ETB, cajas o latas. Luego hazles una foto con 📷.</span></div>'}
    <p class="muted">La foto es tuya: hazla con buena luz y de frente. Toca un producto para cambiar la foto, las unidades o lo que pagaste.</p></div>`;
  const find = document.getElementById('sfind');
  document.getElementById('sadd2').onclick = () => { find.style.display = find.style.display === 'none' ? 'flex' : 'none'; if (find.style.display !== 'none') document.getElementById('sq2').focus(); };
  $view.querySelectorAll('[data-sphoto]').forEach(inp => { inp.onclick = ev => ev.stopPropagation(); inp.onchange = async ev => { const f = ev.target.files[0]; if (!f) return; const id = inp.dataset.sphoto;
    const u = await resizeImage(f); CUSTOM_IMG['sealed:' + id] = u; await idbPut('img:sealed:' + id, u); imgsDirty = true; saveCol(); toast('Foto guardada'); viewSealed(); }; });
  const sq = document.getElementById('sq2'); let t = null;
  sq.oninput = () => { clearTimeout(t); t = setTimeout(() => {
    const v = sq.value.trim(), box = document.getElementById('sres'); if (v.length < 2) { box.innerHTML = ''; return; }
    const rs = q(`SELECT p.cm_product_id, p.name, p.category, pr.trend FROM cm_products p LEFT JOIN prices pr USING(cm_product_id) WHERE p.kind='sealed' AND p.name LIKE ? ORDER BY p.cm_product_id DESC LIMIT 15`, ['%' + v + '%']);
    box.innerHTML = rs.map(r => `<div class="item"><div class="col" style="flex:1"><b>${esc(r.name)}</b><span class="muted">${esc(SEALED_LABEL[r.category] || r.category.replace('Pokémon ', ''))}</span></div><b>${eur(r.trend)}</b><button class="pill" data-sadd="${r.cm_product_id}" aria-label="Añadir">＋</button></div>`).join('') || '<p class="muted">Nada con ese nombre.</p>';
    box.querySelectorAll('[data-sadd]').forEach(b => b.onclick = () => { const id = b.dataset.sadd; if (COL.sealed[id]) COL.sealed[id].qty = (COL.sealed[id].qty || 1) + 1; else COL.sealed[id] = { qty: 1 }; saveCol(); toast('Añadido'); viewSealed(); });
  }, 200); };
}

/* ---------- lista de venta ---------- */
function viewSell() {
  const ids = Object.keys(COL.sell), vm = variantsOf(ids);
  const info = {}; if (ids.length) q(`SELECT c.card_id, ${NAME} name, c.name_en, c.local_id, c.rarity, c.image_base, s.card_count, s.lang, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name, s.name_en set_en FROM cards c JOIN sets s USING(set_id) WHERE c.card_id IN (${ids.map(() => '?').join(',')})`, ids).forEach(r => info[r.card_id] = r);
  const rows = ids.map(id => { const e = COL.sell[id], vs = vm[id] || [], v = vs.find(x => x.cm_product_id === e.cm && (x.variant || '') === (e.variant || '')) || vs[0], sug = vPrice(v), low = v ? (isRevHolo(v) ? v.low_holo : v.low) : null; return { id, e, v, sug, low, i: info[id] || {} }; });
  const total = rows.reduce((t, r) => t + (r.e.price || 0) * (r.e.qty || 1), 0), sugT = rows.reduce((t, r) => t + (r.sug || 0) * (r.e.qty || 1), 0);
  const COND = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'], CL = { MT: 'Mint', NM: 'Near Mint', EX: 'Excelente', GD: 'Bueno', LP: 'Ligeramente jugada', PL: 'Jugada', PO: 'Pobre' };
  const wtext = r => `${r.i.name} ${r.i.local_id}${r.i.card_count ? '/' + r.i.card_count : ''} ${r.i.set_name} - ${r.e.lang} ${r.e.cond}\n\nCarta Pokémon TCG ${r.i.name} (${r.i.set_name}, ${r.i.local_id}${r.i.card_count ? '/' + r.i.card_count : ''}${r.i.rarity ? ', ' + r.i.rarity : ''}${r.v && r.v.variant === 'reverse' ? ', reverse holo' : ''}).\nIdioma: ${r.e.lang}. Estado: ${CL[r.e.cond] || r.e.cond}.\nSale de funda directamente. Envío protegido con top loader.\nPrecio: ${eur(r.e.price)}${r.e.qty > 1 ? ' por unidad (' + r.e.qty + ' disponibles)' : ''}.`;
  $view.innerHTML = `<div class="stack"><div class="row"><a href="#/more" class="pill" style="display:flex;align-items:center">←</a><h1>Lista de venta</h1></div>
    <div class="card col" style="gap:6px"><span class="muted">${rows.length} carta${rows.length === 1 ? '' : 's'} a la venta · lo que pides</span><div class="big">${eur(total)}</div><span class="muted">Según ${PRICE_MODE === 'low' ? 'la oferta más baja' : 'la tendencia'} de Cardmarket valdrían ${eur(sugT)}</span>
      <div class="row" style="flex-wrap:wrap"><button class="btn sec" id="xcsv">Exportar CSV</button></div></div>
    ${dupSection()}
    <div class="list">${rows.map(r => `<div class="item" style="flex-wrap:wrap;align-items:flex-start">${img(r.i.image_base, 'thumb', '', r.id)}<div class="col" style="flex:1;min-width:180px"><a href="#/card/${encodeURIComponent(r.id)}" style="color:var(--tx)"><b>${esc(r.i.name)} · ${esc(r.i.local_id)}</b></a><span class="muted">${esc(r.i.set_name)}${r.v ? ' · ' + esc(vLabel(r.v)) : ''}</span>
        <span style="font-size:13px">Sugerido ${eur(r.sug)} · mínimo publicado ${eur(r.low)}</span>
        <div class="row" style="flex-wrap:wrap;margin-top:6px">
          <label class="f">Tu precio €<input type="number" step="0.01" min="0" value="${r.e.price ?? ''}" data-sp="${esc(r.id)}" style="width:100px"></label>
          <label class="f">Uds<input type="number" min="1" value="${r.e.qty || 1}" data-sqty="${esc(r.id)}" style="width:70px"></label>
          <label class="f">Estado<select data-sc="${esc(r.id)}">${COND.map(c => `<option ${c === r.e.cond ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
          <label class="f">Idioma<select data-sl="${esc(r.id)}">${['ES', 'EN', 'JP', 'FR', 'DE', 'IT', 'PT'].map(c => `<option ${c === r.e.lang ? 'selected' : ''}>${c}</option>`).join('')}</select></label></div>
        <div class="row" style="flex-wrap:wrap;margin-top:6px"><button class="pill" data-wall="${esc(r.id)}">Copiar texto para Wallapop</button><button class="pill" data-sold="${esc(r.id)}">Vendida</button><button class="pill" data-rm="${esc(r.id)}">Quitar</button></div></div></div>`).join('') || '<p class="muted">No tienes cartas a la venta. Abre una carta de tu colección y pulsa "Poner a la venta".</p>'}</div>
    <p class="muted">El CSV lleva nombre, set, número, rareza, versión, idioma, estado, cantidad y precio, y lo puedes abrir en Excel. Si me pasas un ejemplo del formato que pide Cardmarket para subir stock, lo adapto exactamente.</p></div>`;
  const upd = (attr, key, conv) => $view.querySelectorAll(`[${attr}]`).forEach(i => i.onchange = () => { const id = i.getAttribute(attr); COL.sell[id][key] = conv(i.value); saveCol(); viewSell(); });
  wireDup();
  upd('data-sp', 'price', parseNum); upd('data-sqty', 'qty', v => Math.max(1, parseInt(v, 10) || 1)); upd('data-sc', 'cond', v => v); upd('data-sl', 'lang', v => v);
  $view.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { delete COL.sell[b.dataset.rm]; saveCol(); viewSell(); });
  $view.querySelectorAll('[data-sold]').forEach(b => b.onclick = () => {
    const id = b.dataset.sold, e = COL.sell[id], c = COL.cards[id];
    if (!confirm('¿Marcar como vendida? Se quita de la lista de venta y se descuenta de tu colección.')) return;
    if (c) { c.qty = (c.qty || 1) - (e.qty || 1); if (c.copies) c.copies.splice(0, e.qty || 1); if (c.qty <= 0) delete COL.cards[id]; }
    delete COL.sell[id]; saveCol(); toast('Vendida'); viewSell();
  });
  $view.querySelectorAll('[data-wall]').forEach(b => b.onclick = async () => {
    const r = rows.find(x => x.id === b.dataset.wall);
    try { await navigator.clipboard.writeText(wtext(r)); toast('Texto copiado'); } catch (e) { prompt('Copia el texto:', wtext(r)); }
  });
  document.getElementById('xcsv').onclick = () => downloadFile(`9bolsillos-venta-${new Date().toISOString().slice(0, 10)}.csv`,
    ['nombre;nombre_ingles;set;numero;rareza;version;idioma;estado;cantidad;precio;precio_sugerido'].concat(rows.map(r => [r.i.name, r.i.name_en, r.i.set_name, r.i.local_id, r.i.rarity, r.v ? vLabel(r.v) : '', r.e.lang, r.e.cond, r.e.qty, r.e.price != null ? String(r.e.price).replace('.', ',') : '', r.sug != null ? String(r.sug).replace('.', ',') : ''].map(csvCell).join(';'))).join('\n'));
}

/* ---------- "Qué comprar este mes": reparte tu presupuesto entre lo que te falta ---------- */
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
function buyCandidates(src) {
  const out = [];
  if (src.orden) for (const [key, ord] of Object.entries(window.ORDEN || {})) {
    const name = (q(`SELECT illustrator FROM cards WHERE illustrator = ? COLLATE NOCASE LIMIT 1`, [key])[0] || {}).illustrator || key;
    if (!COL.illustrators[name]) continue;
    const { E, vmap } = ordenData(ord);
    E.forEach(e => { if (ordenOwned(name, e)) return; const p = ordenPrice(name, e, vmap); if (!p) return;
      out.push({ k: 'o:' + key + ':' + e.o, src: 'orden', rank: e.o, name: e.n, sub: `${name} · #${e.o} · ${e.s}`, price: p, route: ordenRoute(name, e),
        link: e.cm ? cmProductLink(e.cm, 'asia') : e.id ? cmLink((vmap[e.id] || []).slice().sort((a, b) => (vPrice(a) ?? 1e9) - (vPrice(b) ?? 1e9))[0], { card_id: e.id, region: 'asia' }) : null,
        own: () => ordenToggle(name, e, vmap), img: ordenImg(e, '', name) }); });
  }
  if (src.sets) {
    const sets = [...new Set(Object.values(COL.cards).map(x => x.set))];
    if (sets.length) {
      const rows = q(`SELECT c.card_id, c.set_id, c.local_id, c.image_base, ${NAME} name, s.region, COALESCE(s.name_es,s.name_en) set_name FROM cards c JOIN sets s USING(set_id)
        WHERE s.lang = 'es' AND c.set_id IN (${sets.map(() => '?').join(',')})`, sets).filter(c => !COL.cards[c.card_id] && !hiddenCard(c));
      const vm = variantsOf(rows.map(r => r.card_id));
      rows.forEach(c => { const v = (vm[c.card_id] || []).slice().sort((a, b) => (vPrice(a) ?? 1e9) - (vPrice(b) ?? 1e9))[0]; const p = v && vPrice(v); if (!p) return;
        out.push({ k: 'c:' + c.card_id, src: 'sets', rank: 1e6, name: c.name, sub: `${c.set_name} · ${c.local_id}`, price: p, route: '#/card/' + encodeURIComponent(c.card_id), link: cmLink(v, c),
          own: () => { COL.cards[c.card_id] = { set: c.set_id, cm: v.cm_product_id, variant: v.variant, qty: 1 }; }, img: cardImg(c, 'low', '', '') }); });
    }
  }
  return out;
}
function viewBuy() {
  const budget = parseFloat(lsGet('buy_budget', '50')) || 0, prio = lsGet('buy_prio', 'orden');
  const src = { orden: lsGet('buy_orden', '1') === '1', sets: lsGet('buy_sets', '1') === '1' };
  const all = buyCandidates(src).sort(prio === 'orden' ? (a, b) => a.rank - b.rank || a.price - b.price : (a, b) => a.price - b.price);
  let left = budget; const pick = [], skipped = [];
  for (const it of all) { if (it.price <= left) { pick.push(it); left -= it.price; } else if (it.src === 'orden' && prio === 'orden' && skipped.length < 3) skipped.push(it); if (pick.length >= 60) break; }
  const spent = budget - left;
  $view.innerHTML = `<div class="stack"><div class="row"><a href="#/more" class="pill" style="display:flex;align-items:center" aria-label="Volver">←</a><h1>Qué comprar</h1></div>
    <div class="card col" style="gap:10px">
      <label class="f" for="bud">Tu presupuesto este mes (€)</label>
      <input type="number" id="bud" min="0" step="5" value="${budget}" inputmode="decimal">
      <div class="tbrow">${seg('prio', [['orden', 'Mi orden primero'], ['cheap', 'Más baratas']], prio)}</div>
      <div class="tbrow">${seg('so', [['1', 'Mi orden']], src.orden ? '1' : '')}${seg('ss', [['1', 'Mis sets']], src.sets ? '1' : '')}<span></span></div>
      <span class="muted">"Mi orden" son las listas de los ilustradores que sigues; "Mis sets", lo que te falta de los sets en español que ya has empezado.</span></div>
    <div class="card col" style="gap:4px"><div class="between"><b>${pick.length} carta${pick.length === 1 ? '' : 's'}</b><b class="up" style="font-size:22px">${eur(spent)}</b></div>
      <span class="muted">Te sobran ${eur(left)} de ${eur(budget)} · precio: ${PRICE_LABEL().toLowerCase()}</span>
      ${skipped.length ? `<span class="muted" style="color:var(--down)">No caben con este presupuesto: ${skipped.map(x => `${esc(x.name)} (${eur(x.price)})`).join(', ')}</span>` : ''}</div>
    <div class="list">${pick.map((it, i) => `<div class="item"><a href="${esc(it.route)}" style="display:flex;gap:12px;align-items:center;flex:1;color:var(--tx);min-width:0">
        <div class="thumb">${it.img}</div><div class="col" style="flex:1;min-width:0"><b>${esc(it.name)}</b><span class="muted">${esc(it.sub)}</span></div><b>${eur(it.price)}</b></a>
        ${it.link ? `<a class="pill" target="_blank" rel="noopener" href="${esc(it.link)}" aria-label="Ver en Cardmarket" style="display:flex;align-items:center">↗</a>` : ''}
        <button class="pill" data-got="${i}" aria-label="La he comprado">✓</button></div>`).join('') || '<p class="muted">No hay nada que proponer: sube el presupuesto o activa otra fuente.</p>'}</div>
    <p class="muted">"↗" abre la carta en Cardmarket filtrada por idioma y estado. "✓" la pasa a tu colección y apunta lo que pagaste en tus gastos.</p></div>`;
  const bud = document.getElementById('bud'); bud.onchange = () => { lsSet('buy_budget', bud.value); viewBuy(); };
  $view.querySelectorAll('[data-prio]').forEach(b => b.onclick = () => { lsSet('buy_prio', b.dataset.prio); viewBuy(); });
  $view.querySelectorAll('[data-so]').forEach(b => b.onclick = () => { lsSet('buy_orden', src.orden ? '0' : '1'); viewBuy(); });
  $view.querySelectorAll('[data-ss]').forEach(b => b.onclick = () => { lsSet('buy_sets', src.sets ? '0' : '1'); viewBuy(); });
  $view.querySelectorAll('[data-got]').forEach(b => b.onclick = () => { const it = pick[+b.dataset.got];
    const v = prompt(`¿Cuánto has pagado por ${it.name}? (€)`, it.price.toFixed(2).replace('.', ',')); if (v === null) return;
    const price = parseFloat(String(v).replace(',', '.')) || null;
    it.own(); COL.purchases.push({ id: Date.now(), date: new Date().toISOString().slice(0, 10), type: 'single', desc: it.name + ' · ' + it.sub, qty: 1, price, shop: 'Cardmarket' });
    saveCol(); toast('Añadida a tu colección y a tus gastos'); viewBuy(); });
}
/* ---------- colores de tipo (Pokédex en español y tipos del juego de cartas) ---------- */
const TYPE_COLOR = { Normal: '#A8A77A', Fuego: '#EE8130', Agua: '#6390F0', Planta: '#7AC74C', 'Eléctrico': '#F7D02C', Hielo: '#96D9D6', Lucha: '#C22E28', Veneno: '#A33EA1',
  Tierra: '#E2BF65', Volador: '#A98FF3', 'Psíquico': '#F95587', Bicho: '#A6B91A', Roca: '#B6A136', Fantasma: '#735797', 'Dragón': '#6F35FC', Siniestro: '#705746', Acero: '#B7B7CE', Hada: '#D685AD' };
const TCG_TYPE = { Grass: ['Planta', '#7AC74C'], Fire: ['Fuego', '#EE8130'], Water: ['Agua', '#6390F0'], Lightning: ['Rayo', '#F7D02C'], Psychic: ['Psíquico', '#A66FD6'], Fighting: ['Lucha', '#C8743B'],
  Darkness: ['Oscuridad', '#4B5A6B'], Metal: ['Metal', '#9AA7B5'], Fairy: ['Hada', '#E58BC4'], Dragon: ['Dragón', '#C2A33E'], Colorless: ['Incoloro', '#C9C9C0'] };
// Halo del color del tipo detrás de la carta
function typeGlow(dex) {
  const p = dex && POKE[dex], t = p && p.types && p.types.map(x => TYPE_COLOR[x]).filter(Boolean);
  if (!t || !t.length) return '';
  const a = t[0], b = t[1] || t[0];
  return `background:radial-gradient(ellipse 70% 55% at 35% 40%, ${a}88, transparent 70%),radial-gradient(ellipse 70% 55% at 65% 60%, ${b}77, transparent 72%)`;
}

/* ---------- ilustradores que suelen aparecer en los mismos sets y en la misma época ---------- */
const SIMILAR = {};
function similarIllustrators(name) {
  const k = name.toLowerCase() + '|' + illLang;
  if (SIMILAR[k]) return SIMILAR[k];
  const cond = langCond(illLang);
  const mine = q(`SELECT DISTINCT c.set_id FROM cards c JOIN sets s USING(set_id) WHERE c.illustrator = ? COLLATE NOCASE AND ${cond}`, [name]).map(r => r.set_id);
  if (!mine.length) return (SIMILAR[k] = []);
  const ph = mine.map(() => '?').join(',');
  const rows = q(`SELECT c.illustrator, COUNT(DISTINCT c.set_id) common, COUNT(*) n FROM cards c WHERE c.set_id IN (${ph}) AND c.illustrator IS NOT NULL AND c.illustrator != ? COLLATE NOCASE
    AND c.illustrator NOT LIKE '%Graphics%' AND c.illustrator NOT LIKE '%Ltd%' AND c.illustrator NOT LIKE '%Inc.%' AND c.illustrator NOT LIKE '%,%' AND c.illustrator NOT LIKE '%/%' GROUP BY c.illustrator HAVING common >= 3`, [...mine, name]);
  if (!rows.length) return (SIMILAR[k] = []);
  const tot = {}; q(`SELECT c.illustrator, COUNT(DISTINCT c.set_id) t FROM cards c JOIN sets s USING(set_id) WHERE ${cond} AND c.illustrator IN (${rows.map(() => '?').join(',')}) GROUP BY c.illustrator`, rows.map(r => r.illustrator)).forEach(r => tot[r.illustrator] = r.t);
  return (SIMILAR[k] = rows.map(r => ({ name: r.illustrator, common: r.common, score: r.common / Math.sqrt((tot[r.illustrator] || r.common) * mine.length) }))
    .sort((a, b) => b.score - a.score).slice(0, 8));
}
function similarSection(name) {
  const l = similarIllustrators(name);
  if (!l.length) return '';
  return `<div class="card col" style="gap:8px"><b>Si te gusta ${esc(name)}…</b><span class="muted">Ilustradores que más coinciden con su época y sus sets.</span>
    <div class="row" style="flex-wrap:wrap;gap:8px">${l.map(x => `<a class="pill" href="#/illustrator/${encodeURIComponent(x.name)}">${esc(x.name)} <span class="muted">· ${x.common} sets</span></a>`).join('')}</div></div>`;
}

/* ---------- Tu colección en números ---------- */
const COLS = {};
const hasCol = (t, c) => (COLS[t] ||= q(`PRAGMA table_info(${t})`).map(r => r.name)).includes(c);
function viewStats() {
  const ids = Object.keys(COL.cards), vm = variantsOf(ids);
  const rows = ids.length ? q(`SELECT c.card_id, ${NAME} name, c.illustrator, c.dex_id, ${hasCol('cards', 'ptype') ? 'c.ptype' : 'NULL ptype'}, ${hasCol('cards', 'kind') ? 'c.kind' : 'NULL kind'}, c.image_base, c.local_id, s.release_date, s.lang, c.set_id, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name
    FROM cards c JOIN sets s USING(set_id) WHERE c.card_id IN (${ids.map(() => '?').join(',')})`, ids) : [];
  if (!rows.length) { $view.innerHTML = `<div class="stack"><div class="row"><a href="#/more" class="pill" style="display:flex;align-items:center" aria-label="Volver">←</a><h1>Tu colección en números</h1></div><p class="muted">Aún no tienes cartas en tu colección.</p></div>`; return; }
  const qty = id => COL.cards[id].qty || 1;
  let copies = 0, value = 0; const price = {};
  rows.forEach(r => { const p = vPrice(ownedVariant(r.card_id, vm[r.card_id])); price[r.card_id] = p; copies += qty(r.card_id); value += cardValue(r.card_id, p) || 0; });
  const count = (f, filt = () => true) => { const m = {}; rows.filter(filt).forEach(r => { const k = f(r); if (k != null && k !== '') m[k] = (m[k] || 0) + qty(r.card_id); }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const top = rows.filter(r => price[r.card_id] != null).sort((a, b) => price[b.card_id] - price[a.card_id])[0];
  const ill = count(r => r.illustrator), types = count(r => r.ptype), dex = count(r => r.dex_id, r => r.dex_id && (!r.kind || r.kind === 'Pokemon'));
  const years = count(r => (r.release_date || '').slice(0, 4)), oldest = rows.slice().sort((a, b) => (a.release_date || '9') < (b.release_date || '9') ? -1 : 1)[0];
  const bySet = {}; rows.forEach(r => (bySet[r.set_id] ||= { name: r.set_name, n: 0, lang: r.lang }).n++);
  const sets = Object.entries(bySet).filter(([, v]) => v.lang === 'es').map(([id, v]) => ({ id, ...v, tot: setBinderIds(id).length })).filter(x => x.tot).map(x => ({ ...x, pc: Math.min(100, Math.round(x.n / x.tot * 100)) })).sort((a, b) => b.pc - a.pc).slice(0, 3);
  const spent = (COL.purchases || []).reduce((t, p) => t + (p.price || 0) * (p.type === 'single' ? 1 : (p.qty || 1)), 0);
  const tmax = types.length ? types[0][1] : 1, ymax = years.length ? Math.max(...years.map(y => y[1])) : 1;
  const topDex = dex[0], topDexName = topDex ? dexName(+topDex[0], '') : '';
  const S = (grad, inner) => `<div class="stat" style="background:${grad}">${inner}</div>`;
  $view.innerHTML = `<div class="stack"><div class="row"><a href="#/more" class="pill" style="display:flex;align-items:center" aria-label="Volver">←</a><h1>Tu colección en números</h1></div>
    ${S('linear-gradient(135deg,#1f6f5c,#0f2f3a)', `<span class="sk">Tienes</span><span class="sv">${copies.toLocaleString('es-ES')} cartas</span><span class="sk">${rows.length.toLocaleString('es-ES')} distintas · valen ${eur(value)}${spent ? ` · has gastado ${eur(spent)}` : ''}</span>`)}
    ${top ? S('linear-gradient(135deg,#7a4b12,#2b1a08)', `<div class="row" style="gap:14px;align-items:center"><a href="#/card/${encodeURIComponent(top.card_id)}" style="width:96px;flex:none">${cardImg(top, 'low', 'hero', top.name)}</a><div class="col"><span class="sk">Tu carta más cara</span><span class="sv">${esc(top.name)}</span><span class="sk">${esc(top.set_name)} · ${eur(price[top.card_id])}</span></div></div>`) : ''}
    ${ill.length ? S('linear-gradient(135deg,#4a2a7a,#1a1030)', `<span class="sk">Tu ilustrador más repetido</span><a class="sv" style="color:#fff" href="#/illustrator/${encodeURIComponent(ill[0][0])}">${esc(ill[0][0])} →</a><span class="sk">${ill[0][1]} cartas${ill[1] ? ` · después ${esc(ill[1][0])} (${ill[1][1]})${ill[2] ? ` y ${esc(ill[2][0])} (${ill[2][1]})` : ''}` : ''}</span>`) : ''}
    ${topDex ? S('linear-gradient(135deg,#1c4f8a,#0b1d33)', `<div class="row" style="gap:14px;align-items:center"><a href="#/dex/${topDex[0]}" style="width:96px;height:96px;display:flex;align-items:center;justify-content:center;flex:none">${spriteTag(+topDex[0], false, 'anim', topDexName)}</a><div class="col"><span class="sk">El Pokémon que más tienes</span><span class="sv">${esc(topDexName)}</span><span class="sk">${topDex[1]} cartas${dex[1] ? ` · después ${esc(dexName(+dex[1][0], ''))} (${dex[1][1]})` : ''}</span></div></div>`) : ''}
    ${types.length ? S('linear-gradient(135deg,#2d3a1a,#11160a)', `<span class="sk">Tu tipo favorito</span><span class="sv">${esc((TCG_TYPE[types[0][0]] || [types[0][0]])[0])}</span>
      <div class="col" style="gap:5px;margin-top:8px">${types.slice(0, 6).map(([t, n]) => `<div class="row" style="gap:8px;align-items:center"><span style="width:78px;font-size:13px">${esc((TCG_TYPE[t] || [t])[0])}</span><div style="flex:1;height:10px;border-radius:5px;background:#ffffff14"><div style="width:${n / tmax * 100}%;height:100%;border-radius:5px;background:${(TCG_TYPE[t] || [, '#999'])[1]}"></div></div><span style="width:34px;text-align:right;font-size:13px">${n}</span></div>`).join('')}</div>`) : ''}
    ${years.length ? S('linear-gradient(135deg,#6b1f3a,#2a0c17)', `<span class="sk">Tu año favorito</span><span class="sv">${esc(years[0][0])}</span><span class="sk">${years[0][1]} cartas salieron ese año</span>
      <div class="years">${years.slice().sort((a, b) => a[0] - b[0]).map(([y, n]) => `<div title="${y}: ${n}" style="height:${Math.max(4, n / ymax * 56)}px;${y === years[0][0] ? 'background:#fff' : ''}"></div>`).join('')}</div>`) : ''}
    ${oldest ? S('linear-gradient(135deg,#3b3b3b,#141414)', `<div class="row" style="gap:14px;align-items:center"><a href="#/card/${encodeURIComponent(oldest.card_id)}" style="width:80px;flex:none">${cardImg(oldest, 'low', 'hero', oldest.name)}</a><div class="col"><span class="sk">Tu carta más antigua</span><span class="sv">${esc(oldest.name)}</span><span class="sk">${esc(oldest.set_name)} · ${esc((oldest.release_date || '').slice(0, 4))}</span></div></div>`) : ''}
    ${sets.length ? S('linear-gradient(135deg,#145a4a,#08201b)', `<span class="sk">Tus sets más completos</span>${sets.map(x => `<a href="#/set/${encodeURIComponent(x.id)}" style="color:#fff" class="col"><div class="between" style="margin-top:8px"><b>${esc(x.name)}</b><b>${x.pc} %</b></div><div style="height:8px;border-radius:4px;background:#ffffff1f"><div style="width:${x.pc}%;height:100%;border-radius:4px;background:#3DDC97"></div></div><span class="sk">${x.n} de ${x.tot}</span></a>`).join('')}`) : ''}
  </div>`;
}

/* ---------- Modo enseñar: tus archivadores a pantalla completa, sin precios ni botones ---------- */
function showBinders() {
  const out = [];
  const ids = Object.keys(COL.cards);
  if (ids.length) q(`SELECT c.set_id, COUNT(*) n, COALESCE(s.name_es,s.name_en) name, s.release_date FROM cards c JOIN sets s USING(set_id) WHERE s.lang = 'es' AND c.card_id IN (${ids.map(() => '?').join(',')}) GROUP BY c.set_id ORDER BY n DESC`, ids)
    .forEach(r => out.push({ k: 'set:' + r.set_id, label: r.name, sub: `${r.n} cartas` }));
  for (const [key, ord] of Object.entries(window.ORDEN || {})) {
    const name = (q(`SELECT illustrator FROM cards WHERE illustrator = ? COLLATE NOCASE LIMIT 1`, [key])[0] || {}).illustrator || key;
    const { E } = ordenData(ord), n = E.filter(e => ordenOwned(name, e)).length;
    if (n) out.unshift({ k: 'orden:' + name, label: 'Mi orden · ' + name, sub: `${n} de ${E.length}` });
  }
  return out;
}
function showPages(k) {   // [{img, empty}] en orden físico, con los bolsillos libres del principio
  const off = ((COL.binders || {})[k] || {}).off || 0, pockets = Array(off).fill(null);
  if (k.startsWith('set:')) {
    const ids = setBinderIds(k.slice(4)), info = {};
    q(`SELECT c.card_id, c.set_id, c.local_id, c.image_base, ${NAME} name, s.region FROM cards c JOIN sets s USING(set_id) WHERE c.set_id = ?`, [k.slice(4)]).forEach(r => info[r.card_id] = r);
    ids.forEach(id => pockets.push(COL.cards[id] && info[id] ? cardImg(info[id], 'high', '', info[id].name) : null));
  } else {
    const name = k.slice(6), ord = (window.ORDEN || {})[name.toLowerCase()];
    if (ord) ordenData(ord).E.forEach(e => pockets.push(ordenOwned(name, e) ? ordenImg(e, '', name) : null));
  }
  return pockets;
}
let SHOW_PG = {};
function viewShow(k) {
  document.body.classList.remove('showmode');
  if (!k) {
    const l = showBinders();
    $view.innerHTML = `<div class="stack"><div class="row"><a href="#/more" class="pill" style="display:flex;align-items:center" aria-label="Volver">←</a><h1>Enseñar colección</h1></div>
      <span class="muted">Elige un archivador. Se abre a pantalla completa, sin precios ni botones: desliza para pasar páginas y toca la ✕ para salir.</span>
      <div class="list">${l.map(x => `<a class="item" href="#/show/${encodeURIComponent(x.k)}"><div class="col" style="flex:1"><b>${esc(x.label)}</b><span class="muted">${esc(x.sub)}</span></div>▶</a>`).join('') || '<p class="muted">Marca cartas de algún set o de Mi orden y aparecerán aquí.</p>'}</div></div>`;
    return;
  }
  const P = showPages(k), pages = Math.max(1, Math.ceil(P.length / 9)), label = (showBinders().find(x => x.k === k) || { label: '' }).label;
  document.body.classList.add('showmode');
  try { const d = document.documentElement; if (d.requestFullscreen && !document.fullscreenElement) d.requestFullscreen().catch(() => {}); } catch (e) {}
  const draw = (dir = '') => {
    let pg = Math.min(SHOW_PG[k] || 0, pages - 1); SHOW_PG[k] = pg;
    let html = '';
    for (let i = 0; i < 9; i++) { const c = P[pg * 9 + i]; html += `<div class="spk ${c ? '' : 'none'}"><div class="pk">${c || ''}</div></div>`; }
    $view.innerHTML = `<div class="show"><div class="showtop"><span>${esc(label)} · página ${pg + 1} de ${pages}</span><button class="pill" id="showx" aria-label="Salir">✕</button></div>
      <div class="showpage spread ${dir}">${html}</div></div>`;
    document.getElementById('showx').onclick = () => { document.body.classList.remove('showmode'); try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {} location.hash = '#/show'; };
    swipePages($view.querySelector('.show'), d => { const nx = (SHOW_PG[k] || 0) + d; if (nx < 0 || nx >= pages) return; SHOW_PG[k] = nx; draw(d > 0 ? 'fromR' : 'fromL'); });
  };
  draw();
}

/* ---------- Repetidas: lo que tienes más de una vez y no está ya a la venta ---------- */
function dupRows() {
  const ids = Object.keys(COL.cards).filter(id => (COL.cards[id].qty || 1) - ((COL.sell[id] || {}).qty || 0) > 1);
  if (!ids.length) return [];
  const vm = variantsOf(ids), info = {};
  q(`SELECT c.card_id, ${NAME} name, c.local_id, c.image_base, s.card_count, s.region, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name FROM cards c JOIN sets s USING(set_id) WHERE c.card_id IN (${ids.map(() => '?').join(',')})`, ids).forEach(r => info[r.card_id] = r);
  return ids.filter(id => info[id]).map(id => { const v = ownedVariant(id, vm[id]); return { id, i: info[id], v, extra: (COL.cards[id].qty || 1) - ((COL.sell[id] || {}).qty || 0) - 1, sug: vPrice(v) }; })
    .sort((a, b) => (b.sug || 0) - (a.sug || 0));
}
function dupToSell(r) {
  const s = COL.sell[r.id];
  if (s) s.qty = (s.qty || 1) + r.extra;
  else COL.sell[r.id] = { qty: r.extra, price: r.sug != null ? Math.round(r.sug * 100) / 100 : null, cond: 'NM', lang: r.i.region === 'asia' ? 'JP' : 'ES', cm: r.v ? r.v.cm_product_id : null, variant: r.v ? r.v.variant : null };
}
function dupSection() {
  const D = dupRows();
  if (!D.length) return '';
  const tot = D.reduce((t, r) => t + (r.sug || 0) * r.extra, 0);
  return `<div class="card col" style="gap:8px"><div class="between"><b>Repetidas (${D.reduce((t, r) => t + r.extra, 0)})</b><b>${eur(tot)}</b></div>
    <span class="muted">Copias que tienes de más (te quedas una de cada) y aún no están a la venta.</span>
    <div class="list">${D.slice(0, 40).map(r => `<div class="item">${img(r.i.image_base, 'thumb', '', r.id)}<div class="col" style="flex:1;min-width:0"><a href="#/card/${encodeURIComponent(r.id)}" style="color:var(--tx)"><b>${esc(r.i.name)} · ${esc(r.i.local_id)}</b></a><span class="muted">${esc(r.i.set_name)} · ${r.extra} de más · ${eur(r.sug)} c/u</span></div><button class="pill" data-dup="${esc(r.id)}" style="font-size:13px">A la venta</button></div>`).join('')}</div>
    <div class="row" style="flex-wrap:wrap"><button class="btn" id="dupall">Poner todas a la venta</button><button class="btn sec" id="dupwall">Copiar lista para Wallapop</button></div></div>`;
}
function wireDup() {
  const D = dupRows();
  $view.querySelectorAll('[data-dup]').forEach(b => b.onclick = () => { const r = D.find(x => x.id === b.dataset.dup); if (r) { dupToSell(r); saveCol(); toast('Puesta a la venta'); viewSell(); } });
  const all = document.getElementById('dupall'); if (all) all.onclick = () => { D.forEach(dupToSell); saveCol(); toast(`${D.length} cartas puestas a la venta`); viewSell(); };
  const w = document.getElementById('dupwall'); if (w) w.onclick = async () => {
    const t = 'Vendo cartas Pokémon repetidas (en perfecto estado, de funda directa):\n\n' + D.map(r => `· ${r.i.name} ${r.i.local_id}${r.i.card_count ? '/' + r.i.card_count : ''} (${r.i.set_name}, ${r.i.region === 'asia' ? 'japonés' : 'español'})${r.extra > 1 ? ' ×' + r.extra : ''} — ${eur(r.sug)}`).join('\n') + '\n\nEnvío protegido con top loader. Pregunta por packs.';
    try { await navigator.clipboard.writeText(t); toast('Lista copiada'); } catch (e) { prompt('Copia el texto:', t); }
  };
}

/* ---------- Calendario de lanzamientos: lo anunciado (app/calendario.js) + lo que ya trae la base de datos ---------- */
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const daysTo = f => Math.round((new Date(f + 'T00:00:00') - new Date(todayISO() + 'T00:00:00')) / 864e5);
const cdText = n => n === 0 ? '¡Sale hoy!' : n === 1 ? 'Sale mañana' : n > 1 ? `Faltan ${n} días` : n === -1 ? 'Salió ayer' : `Salió hace ${-n} días`;
function calEntries() {
  const hoy = todayISO(), desde = new Date(Date.now() - 75 * 864e5).toISOString().slice(0, 10);
  const db = q(`SELECT set_id, lang, release_date, COALESCE(name_es,name_en,name_ja,name_local) name, name_ja, name_en FROM sets WHERE lang IN ('es','ja') AND release_date >= ? ORDER BY release_date`, [desde])
    .filter(s => !/デッキ|Deck|スターター|ボックス|Box|Starter|Kit/i.test((s.name || '') + ' ' + (s.name_en || '')));
  const out = db.map(s => ({ id: 'set:' + s.set_id, fecha: s.release_date, idioma: s.lang, nombre: s.lang === 'ja' && s.name_en && s.name_ja ? `${s.name_ja} · ${s.name_en}` : s.name, set: s.set_id, tipo: 'Set' }));
  const seen = new Set(out.map(e => e.set).concat(out.map(e => e.idioma + e.fecha)));
  (window.CALENDARIO || []).forEach(c => { if (c.set && seen.has(c.set)) return; if (!c.set && seen.has(c.idioma + c.fecha)) return; if (c.fecha >= desde) out.push(c); });
  return out.filter(e => e.idioma === 'es' && e.fecha >= hoy).sort((a, b) => a.fecha < b.fecha ? -1 : 1).map(e => ({ ...e, dias: daysTo(e.fecha), pasado: false }));   // solo lo que va a salir en España
}
const calAviso = id => ((COL.cal || []).includes(id));
function viewCalendar() {
  const E = calEntries(), next = E.filter(e => !e.pasado), past = E.filter(e => e.pasado).reverse(), N = next[0];
  const day = e => { const [y, m, d] = e.fecha.split('-'); return `<div class="calday"><b>${+d}</b><span>${MESES[+m - 1]} ${y.slice(2)}</span></div>`; };
  const row = e => `<div class="item calrow">${day(e)}<a ${e.set ? `href="#/set/${encodeURIComponent(e.set)}"` : e.fuente ? `href="${esc(e.fuente)}" target="_blank" rel="noopener"` : ''} class="col" style="flex:1;min-width:0;color:var(--tx)">
      <b>${esc(e.nombre)}</b>
      <span class="muted">${esc(cdText(e.dias))}${e.codigo ? ' · ' + esc(e.codigo) : ''}${e.nota ? ' · ' + esc(e.nota) : ''}</span></a>
      ${!e.pasado ? `<button class="pill ${calAviso(e.id) ? 'on' : ''}" data-cal="${esc(e.id)}" aria-pressed="${calAviso(e.id)}" aria-label="Avisarme el día que salga" style="display:flex;align-items:center">${ico('bell', 18)}</button>` : ''}</div>`;
  $view.innerHTML = `<div class="stack"><div class="row"><a href="#/more" class="pill" style="display:flex;align-items:center" aria-label="Volver">←</a><h1>Lanzamientos</h1></div>
    ${N ? `<div class="calnext"><span style="opacity:.8">Próximo lanzamiento en España</span><b style="font-size:22px">${esc(N.nombre)}</b>
      <span class="cd">${N.dias === 0 ? '¡Hoy!' : N.dias === 1 ? 'Mañana' : N.dias + ' días'}</span><span style="opacity:.8">${+N.fecha.slice(8)} de ${MESES[+N.fecha.slice(5, 7) - 1]} de ${N.fecha.slice(0, 4)}${N.nota ? ' · ' + esc(N.nota) : ''}</span></div>` : ''}
    <h2>Próximos</h2><div class="list">${next.map(row).join('') || '<p class="muted">No hay ningún lanzamiento anunciado todavía.</p>'}</div>
    <span class="muted">La campana te manda un aviso al móvil la mañana en que sale (necesitas los avisos activados en Ajustes).</span>
    <p class="muted">Los sets entran solos en la app cuando se añaden a la base de datos. Los anunciados que aún no están, los apunto a mano: pídemelo cuando anuncien uno nuevo.</p></div>`;
  $view.querySelectorAll('[data-cal]').forEach(b => b.onclick = () => { const id = b.dataset.cal; COL.cal = COL.cal || []; const i = COL.cal.indexOf(id);
    if (i >= 0) COL.cal.splice(i, 1); else COL.cal.push(id); saveCol(); toast(i >= 0 ? 'Aviso quitado' : 'Te avisaré el día que salga'); viewCalendar(); });
}
function calBanner() {
  const N = calEntries().find(e => !e.pasado && e.dias <= 21);
  return N ? `<a class="card row" href="#/calendario" style="gap:12px;align-items:center;color:var(--tx)"><span class="gico" style="background:#E2465B">${ico('calendar', 18)}</span><div class="col" style="flex:1"><b>${esc(N.nombre)}</b><span class="muted">${esc(cdText(N.dias))}</span></div>${ico('chev', 16, 'chev')}</a>` : '';
}

/* ---------- recibir un precio del Atajo: #/precio?cm=886509&p=115.00&l=ES&c=NM&r=0 ---------- */
function viewRecvPrice(qs) {
  const P = new URLSearchParams(qs || ''), cm = parseInt(P.get('cm'), 10), price = parseFloat(String(P.get('p') || '').replace(/\./g, '').replace(',', '.')) || parseFloat(P.get('p'));
  const rev = P.get('r') === '1', l = (P.get('l') || 'ES').toUpperCase(), c = (P.get('c') || 'NM').toUpperCase();
  const back = '<a href="#/" class="btn" style="align-self:flex-start">Ir a 9Bolsillos</a>';
  if (!cm || !(price > 0)) { $view.innerHTML = `<div class="stack"><h1>No he podido leer el precio</h1><p class="muted">Abre la carta en Cardmarket (desde el botón ↗ de 9B), espera a que se vean las ofertas y vuelve a usar el Atajo.</p>${back}</div>`; return; }
  const today = todayISO(), entry = { p: Math.round(price * 100) / 100, d: today, l, c };
  const pu = String(P.get('u') || ''); if (/^https:\/\/www\.cardmarket\.com\/[a-z]{2}\/Pokemon\/Products\/Singles\/[^?#\s]+$/.test(pu)) entry.u = pu;
  // No se toca la colección guardada aquí todavía: Safari puede tener una copia antigua. Se apunta como pendiente y
  // se aplica sobre la versión de tu cuenta (applyPendingReal), así no se pisa nada de lo que hiciste en la app.
  const pend = JSON.parse(localStorage.getItem('9b.realPending') || '{}'); pend[realKey(cm, rev)] = entry; localStorage.setItem('9b.realPending', JSON.stringify(pend));
  try { history.replaceState(null, '', '#/'); } catch (e) {}   // para que al volver a abrir la app no se guarde otra vez
  const card = q(`SELECT c.card_id, c.set_id, c.local_id, c.image_base, ${NAME} name, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name, s.region FROM card_variants v JOIN cards c USING(card_id) JOIN sets s USING(set_id)
    WHERE v.cm_product_id = ? ORDER BY (s.lang = 'es') DESC LIMIT 1`, [cm])[0];
  let ord = null; if (!card) for (const [key, o] of Object.entries(window.ORDEN || {})) { const e = (o.cartas || []).find(x => x.cm === cm); if (e) { ord = { key, e }; break; } }
  const link = card ? '#/card/' + encodeURIComponent(card.card_id) : ord ? ordenRoute(ord.key.replace(/\b\w/g, m => m.toUpperCase()), ord.e) : '#/';
  $view.innerHTML = `<div class="stack" style="align-items:center;text-align:center;padding-top:20px">
    <div style="font-size:44px">✓</div><h1>Precio guardado</h1>
    ${card ? `<div style="width:150px">${cardImg(card, 'low', 'hero', card.name)}</div><b>${esc(card.name)}</b><span class="muted">${esc(card.set_name)} · ${esc(card.local_id)}</span>` : ord ? `<b>${esc(ord.e.n)}</b><span class="muted">${esc(ord.e.s)} · Mi orden</span>` : `<span class="muted">Producto ${cm} de Cardmarket (no está en tu base de datos todavía)</span>`}
    <div class="big">${eur(price)}</div><span class="realtag">${esc(realLabel(entry))}${rev ? ' · reverse holo' : ''}</span>
    <a href="${link}" class="btn" style="display:flex;align-items:center;justify-content:center">Ver la carta</a>
    <span id="rsync" class="muted" style="font-size:13px">Guardando en tu cuenta…</span>
    <span class="muted" style="font-size:13px">Se usa en el valor de tu colección, en «Qué comprar» y en los avisos durante ${REAL_DAYS} días.</span></div>`;
  (async () => {
    const el = () => document.getElementById('rsync');
    for (let i = 0; i < 20 && SB && !SB_USER; i++) { try { const ss = await SB.auth.getSession(); if (ss.data.session) SB_USER = ss.data.session.user; } catch (e) {} if (!SB_USER) await new Promise(r => setTimeout(r, 300)); }
    let r = await applyPendingReal(); if (r === 'none') r = SB && SB_USER ? 'cloud' : 'local';   // ya lo aplicó el arranque
    if (!el()) return;
    el().innerHTML = r === 'cloud' ? '<span class="up">✓ Guardado en tu cuenta: ya lo verás en la app</span>'
      : r === 'local' ? '<b style="color:var(--down)">Aquí (Safari) no tienes la sesión iniciada</b>: se ha guardado solo en Safari. Si usas 9B desde el icono de la pantalla de inicio, entra una vez en <a href="#/settings">Ajustes</a> de Safari con tu cuenta y vuelve a usar el Atajo.'
      : '<span style="color:var(--down)">No se ha podido subir a tu cuenta. Se queda pendiente y se subirá la próxima vez que abras 9B con conexión.</span>';
  })();
}
// Aplica los precios del Atajo pendientes. Con sesión: sobre la versión más reciente de la nube (sin pisar nada); sin sesión: aquí.
async function applyPendingReal() {
  const pend = JSON.parse(localStorage.getItem('9b.realPending') || '{}'), keys = Object.keys(pend);
  if (!keys.length) return 'none';
  const put = base => { base.real = base.real || {}; base.cmurl = base.cmurl || {};
    keys.forEach(k => { const { u, ...e } = pend[k]; if (u) base.cmurl[k.split('|')[0]] = u; if (!base.real[k] || (e.d || '') >= (base.real[k].d || '')) base.real[k] = e; }); };
  if (!SB || !SB_USER) { put(COL); saveCol(); localStorage.removeItem('9b.realPending'); return 'local'; }
  try {
    const { data, error } = await SB.from('collections').select('data').eq('user_id', SB_USER.id).maybeSingle();
    if (error) throw error;
    const remote = data && data.data && data.data.cards ? data.data : null;
    if (remote && (remote.updatedAt || 0) > (COL.updatedAt || 0)) COL = Object.assign({ sealed: {}, alerts: {}, illustrators: {}, purchases: [], sell: {}, master: {}, extra: {} }, remote);
    put(COL); COL.updatedAt = Date.now(); localStorage.setItem(STORE_KEY, JSON.stringify(COL));
    await pushNow(); localStorage.removeItem('9b.realPending'); return 'cloud';
  } catch (e) { console.warn('Precio real:', e); return 'error'; }
}
/* ---------- iconos de línea propios (en lugar de emojis) ---------- */
const IC = {
  crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  chart: '<path d="M4 19V5M4 19h16"/><path d="M7 15l4-4 3 3 5-6"/>',
  stats: '<path d="M5 20V11M12 20V4M19 20v-6"/>',
  present: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/><path d="M10 8.5l4 1.5-4 1.5z" fill="currentColor"/>',
  cart: '<path d="M3 4h2l2.2 10.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.5L21 8H6.2"/><circle cx="10" cy="20" r="1.3"/><circle cx="17" cy="20" r="1.3"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18M16 15h2"/><path d="M6 6l9-3 1.5 3"/>',
  box: '<path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.4"/>',
  brush: '<path d="M14.5 4.5l5 5L10 19H5v-5z"/><path d="M12.5 6.5l5 5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  camera: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H8l1.5-2h5L16 6h2.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.8"/>',
  pencil: '<path d="M4 20l1-4.5L16 4.5l3.5 3.5L8.5 19z"/><path d="M14 7l3.5 3.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  binder: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M9 3v18M12.5 8h4M12.5 12h4"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 7.5 2.8C19.5 15.4 12 20 12 20z"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
};
const ico = (n, s = 20, extra = '') => `<svg class="ico ${extra}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n] || ''}</svg>`;
// Fila de lista agrupada estilo Ajustes del iPhone
const grow = (href, icon, color, title, sub) => `<a class="grow" href="${href}"><span class="gico" style="background:${color}">${ico(icon, 18)}</span><span class="col" style="flex:1;min-width:0;gap:1px"><b>${title}</b>${sub ? `<span class="muted">${sub}</span>` : ''}</span>${ico('chev', 16, 'chev')}</a>`;
function viewMore() {
  const n = k => Object.keys(COL[k] || {}).length, pl = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  $view.innerHTML = `<div class="stack"><h1>Más</h1>
    <div class="gsec"><span class="ghead">Tu colección</span><div class="group">
      ${grow('#/stats', 'stats', '#7C5CFA', 'Tu colección en números', 'Ilustrador, Pokémon y año favoritos, tu carta más cara…')}
      ${grow('#/show', 'present', '#2F9BF0', 'Enseñar colección', 'Tus archivadores a pantalla completa, sin precios')}
      ${grow('#/illustrators', 'brush', '#E0752B', 'Ilustradores', pl(n('illustrators'), 'colección que sigues', 'colecciones que sigues'))}
      ${grow('#/sealed', 'box', '#C79A3A', 'Sellado', pl(n('sealed'), 'producto', 'productos'))}</div></div>
    <div class="gsec"><span class="ghead">Comprar y vender</span><div class="group">
      ${grow('#/buy', 'cart', '#2FB57A', 'Qué comprar este mes', 'Reparte tu presupuesto entre lo que te falta')}
      ${grow('#/calendario', 'calendar', '#E2465B', 'Lanzamientos', 'Próximos sets en España, con cuenta atrás')}
      ${grow('#/expenses', 'wallet', '#3A7BD5', 'Gastos', pl(COL.purchases.length, 'compra apuntada', 'compras apuntadas'))}
      ${grow('#/sell', 'tag', '#D5527F', 'Lista de venta', pl(n('sell'), 'carta', 'cartas') + ' · repetidas y exportar')}</div></div>
    <div class="gsec"><span class="ghead">App</span><div class="group">
      ${grow('#/settings', 'gear', '#6B7280', 'Ajustes', 'Cuenta, avisos, base de datos y copias')}</div></div></div>`;
}

let searchQ = '';
/* ---------- Escanear carta: foto → lectura del número y el nombre (Tesseract, en el propio móvil) → carta ---------- */
let TESS = null;
function loadTess() {
  return TESS ||= new Promise((ok, ko) => {
    const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    sc.onload = () => Tesseract.createWorker('eng').then(ok, ko); sc.onerror = ko; document.head.append(sc);
  }).catch(e => { TESS = null; throw e; });
}
const fold = t => (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
async function photoCanvas(file) {
  const bmp = await createImageBitmap(file), k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  // Franja de abajo ampliada: el número (116/086) es muy pequeño en la foto
  const sh = Math.round(bmp.height * 0.16), z = Math.min(3, 2400 / bmp.width), st = document.createElement('canvas');
  st.width = Math.round(bmp.width * z); st.height = Math.round(sh * z);
  st.getContext('2d').drawImage(bmp, 0, bmp.height - sh, bmp.width, sh, 0, 0, st.width, st.height);
  return [cv, st];
}
function scanParse(text) {
  const T = text.replace(/[‘’`´]/g, "'"), nums = [], seen = new Set();
  for (const m of T.matchAll(/(?:\b(TG|GG|RC|SV|SH))?(\d{1,3})\s*[\/|]\s*([A-Z]{0,3})\s*(\d{2,3})\b/g)) {
    const k = (m[1] || '') + m[2] + '/' + m[4]; if (!seen.has(k)) { seen.add(k); nums.push({ pre: m[1] || '', n: parseInt(m[2], 10), tot: parseInt(m[4], 10) }); } }
  const codes = [...new Set((T.match(/\b(?:S[VMI]?\d{1,2}[a-zA-Z]?|M\d{1,2}[a-zA-Z]?|SM\d{1,2}[a-zA-Z]?)\b/g) || []).map(x => x.toLowerCase()))];
  const words = [...new Set(fold(T).match(/[a-zñ]{4,}/g) || [])].filter(w => !/^(pokemon|basico|basic|stage|fase|evoluciona|ilus|illus|weakness|debilidad|resistencia|retirada|retreat|damage|dano|energia|energy|trainer|entrenador)$/.test(w));
  return { nums, codes, words };
}
function scanMatch(r) {
  const sel = `SELECT c.card_id, c.set_id, c.local_id, ${NAME} name, c.name_en, c.name_es, c.image_base, s.lang, s.card_count, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name
    FROM cards c JOIN sets s USING(set_id) WHERE s.lang IN ('es','ja') AND `;
  let rows = [];
  r.nums.forEach(x => { rows.push(...q(sel + `(c.local_id = ? OR (CAST(c.local_id AS INTEGER) = ? AND c.local_id GLOB '[0-9]*')) AND (s.card_count = ? OR ? = 1)`, [x.pre + String(x.n).padStart(x.pre ? 2 : 3, '0'), x.pre ? -1 : x.n, x.tot, x.pre ? 1 : 0]).map(c => Object.assign(c, { why: 2 }))); });
  if (!rows.length && r.nums.length) r.nums.forEach(x => rows.push(...q(sel + `CAST(c.local_id AS INTEGER) = ? AND c.local_id GLOB '[0-9]*'`, [x.n])));
  if (!rows.length && r.words.length) r.words.slice(0, 6).forEach(w => rows.push(...q(sel + `(lower(c.name_es) LIKE ? OR lower(c.name_en) LIKE ?) LIMIT 40`, ['%' + w + '%', '%' + w + '%'])));
  const uniq = {}; rows.forEach(c => { if (uniq[c.card_id]) return; const nm = fold((c.name_es || '') + ' ' + (c.name_en || ''));
    c.score = (c.why || 0) + r.words.filter(w => nm.includes(w)).length * 3 + (r.codes.includes(c.set_id.toLowerCase()) ? 6 : 0) + (c.lang === SETS_LANG ? 1 : 0) + (COL.cards[c.card_id] ? 0.5 : 0);
    uniq[c.card_id] = c; });
  return Object.values(uniq).sort((a, b) => b.score - a.score).slice(0, 8);
}
function scanOwn(c) {
  if (COL.cards[c.card_id]) { COL.cards[c.card_id].qty = (COL.cards[c.card_id].qty || 1) + 1; saveCol(); toast(`Ya la tenías: ahora tienes ${COL.cards[c.card_id].qty}`); return; }
  const v = (variantsOf([c.card_id])[c.card_id] || []).slice().sort((a, b) => (vPrice(a) ?? 1e9) - (vPrice(b) ?? 1e9))[0];
  COL.cards[c.card_id] = { set: c.set_id, cm: v ? v.cm_product_id : null, variant: v ? v.variant : null, qty: 1 }; saveCol();
  const i = setBinderIds(c.set_id).indexOf(c.card_id); toast(i >= 0 ? '✓ Añadida · 📒 va en la ' + spotTxt(binderSpot('set:' + c.set_id, i)) : '✓ Añadida a tu colección');
}
let SCAN = null;   // último resultado, para volver a la lista desde la ficha
function viewScan() {
  const res = SCAN;
  $view.innerHTML = `<div class="stack"><div class="row"><a href="#/search" class="pill" style="display:flex;align-items:center" aria-label="Volver">←</a><h1>Escanear carta</h1></div>
    <label class="btn" style="display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer">${ico('camera', 20)} ${res ? 'Escanear otra' : 'Hacer foto a la carta'}<input type="file" id="scanf" accept="image/*" capture="environment" hidden></label>
    <span class="muted">Foto de frente, con buena luz y sin reflejos. Que se vea bien el número de abajo (por ejemplo 116/086).</span>
    <div id="scanout">${res ? scanResultHTML(res) : ''}</div></div>`;
  const out = document.getElementById('scanout');
  const wire = () => out.querySelectorAll('[data-sown]').forEach(b => b.onclick = ev => { ev.preventDefault(); ev.stopPropagation(); scanOwn(SCAN.cands[+b.dataset.sown]); out.innerHTML = scanResultHTML(SCAN); wire(); });
  wire();
  document.getElementById('scanf').onchange = async ev => {
    const f = ev.target.files[0]; if (!f) return;
    out.innerHTML = '<p class="muted">Leyendo la carta… (la primera vez tarda un poco más: descarga el lector)</p>';
    try {
      const [w, [cv, st]] = await Promise.all([loadTess(), photoCanvas(f)]);
      const a = await w.recognize(cv), b = await w.recognize(st), r = scanParse((a.data.text || '') + '\n' + (b.data.text || ''));
      SCAN = { r, cands: scanMatch(r), thumb: cv.toDataURL('image/jpeg', 0.5) };
      out.innerHTML = scanResultHTML(SCAN); wire();
    } catch (e) { out.innerHTML = `<p class="muted" style="color:var(--down)">No he podido leer la foto (${esc(e.message || e)}). Comprueba la conexión la primera vez y vuelve a probar.</p>`; }
    ev.target.value = '';
  };
}
function scanResultHTML({ r, cands, thumb }) {
  const read = [r.nums.map(x => `${x.pre}${x.n}/${x.tot}`).join(', '), r.codes.join(', ').toUpperCase(), r.words.slice(0, 4).join(' ')].filter(Boolean).join(' · ');
  return `<div class="card row" style="gap:12px;align-items:center"><img src="${thumb}" alt="Tu foto" style="width:56px;border-radius:6px"><span class="muted">He leído: <b style="color:var(--tx)">${esc(read || 'nada claro')}</b></span></div>
    ${cands.length ? `<h2 style="margin-top:6px">${(cands.length === 1 || (cands[0].score >= 6 && cands[0].score - cands[1].score >= 3)) ? 'Es esta' : '¿Cuál es?'}</h2>` : '<p class="muted">No encuentro ninguna carta con eso. Repite la foto más cerca del número, o búscala por nombre.</p>'}
    <div class="list">${cands.map((c, i) => `<a class="item" href="#/card/${encodeURIComponent(c.card_id)}">${img(c.image_base, 'thumb', '', c.card_id)}
      <div class="col" style="flex:1;min-width:0"><b>${esc(c.name)} ${COL.cards[c.card_id] ? `<span class="up">✓${COL.cards[c.card_id].qty > 1 ? '×' + COL.cards[c.card_id].qty : ''}</span>` : ''}</b><span class="muted">${esc(c.set_name)} · ${esc(c.local_id)}${c.card_count ? '/' + c.card_count : ''} · ${c.lang === 'ja' ? 'JP' : 'ES'}</span></div>
      <button class="pill" data-sown="${i}" style="font-size:13px">${COL.cards[c.card_id] ? '+1' : 'La tengo'}</button></a>`).join('')}</div>`;
}
/* ---------- Buscar: cuando está vacío, recientes y accesos útiles ---------- */
const getRecent = () => { try { return JSON.parse(localStorage.getItem('9b.recent') || '[]'); } catch (e) { return []; } };
function saveRecent(t) { let l = getRecent().filter(x => x.toLowerCase() !== t.toLowerCase()); l.unshift(t); try { localStorage.setItem('9b.recent', JSON.stringify(l.slice(0, 8))); } catch (e) {} }
function searchHome() {
  const r = getRecent(), ill = Object.keys(COL.illustrators || {}).slice(0, 6);
  return `<div class="stack" style="gap:16px">
    <a class="scanhero" href="#/scan"><span class="gico" style="background:#2FB57A;width:44px;height:44px;border-radius:14px">${ico('camera', 22)}</span><span class="col" style="flex:1;gap:2px"><b>Escanear una carta</b><span class="muted">Hazle una foto y la encuentro por su número</span></span>${ico('chev', 16, 'chev')}</a>
    ${r.length ? `<div class="gsec"><div class="between"><span class="ghead">Recientes</span><button class="linkbtn" id="rclear">Borrar</button></div><div class="chips">${r.map(x => `<button class="chip" data-rq="${esc(x)}">${ico('clock', 14)}${esc(x)}</button>`).join('')}</div></div>` : ''}
    ${ill.length ? `<div class="gsec"><span class="ghead">Tus ilustradores</span><div class="chips">${ill.map(x => `<a class="chip" href="#/illustrator/${encodeURIComponent(x)}">${ico('brush', 14)}${esc(x)}</a>`).join('')}</div></div>` : ''}</div>`;
}
function wireSearchHome() {
  const inp = document.getElementById('s');
  $view.querySelectorAll('[data-rq]').forEach(b => b.onclick = () => { inp.value = b.dataset.rq; inp.dispatchEvent(new Event('input')); });
  const c = document.getElementById('rclear'); if (c) c.onclick = () => { try { localStorage.removeItem('9b.recent'); } catch (e) {} document.getElementById('res').innerHTML = searchHome(); wireSearchHome(); };
}
function viewSearch() {
  $view.innerHTML = `<div class="stack"><h1>Buscar</h1><div class="searchbox">${ico('search', 18)}<input type="search" id="s" placeholder="Nombre de la carta (español, inglés o japonés)" value="${esc(searchQ)}" autocomplete="off"></div><div id="res"></div></div>`;
  const inp = document.getElementById('s');
  let t = null;
  const run = () => {
    searchQ = inp.value.trim();
    if (searchQ.length < 2) { document.getElementById('res').innerHTML = searchHome(); wireSearchHome(); return; }
    saveRecent(searchQ);
    const like = '%' + searchQ + '%';
    const rows = q(`SELECT c.card_id, COALESCE(c.name_es,c.name_en,c.name_ja,c.name_local) name, c.local_id, c.rarity, c.image_base, s.region, s.release_date, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name
      FROM cards c JOIN sets s USING(set_id) WHERE c.name_es LIKE ? OR c.name_en LIKE ? OR c.name_ja LIKE ? ORDER BY s.release_date DESC LIMIT 80`, [like, like, like]);
    const vm = variantsOf(rows.map(r => r.card_id));
    document.getElementById('res').innerHTML = (rows.length ? '<div class="list">' : '') + rows.map(r => `<a class="item" href="#/card/${encodeURIComponent(r.card_id)}">${img(r.image_base, 'thumb', '', r.card_id)}<div class="col" style="flex:1"><b>${esc(r.name)} ${COL.cards[r.card_id] ? '<span class="up">✓</span>' : ''}</b><span class="muted">${esc(r.set_name)} · ${esc(r.local_id)} · ${esc(r.rarity || '')}${r.region === 'asia' ? ' · JP' : ''}</span></div><b>${eur(cheapest(vm[r.card_id]))}</b></a>`).join('') + (rows.length ? '</div>' : '<p class="muted">Sin resultados.</p>');
  };
  inp.oninput = () => { clearTimeout(t); t = setTimeout(run, 200); };
  run();
}

function viewSettings() {
  const days = HAS_HISTORY ? q('SELECT COUNT(DISTINCT day) n FROM history')[0].n : 0;
  $view.innerHTML = `<div class="stack"><div class="row"><a href="#/more" class="pill" style="display:flex;align-items:center">←</a><h1>Ajustes</h1></div>
    ${syncCard()}
    <div class="card col" style="gap:10px" id="pushcard"></div>
    <div class="card col" style="gap:10px"><b>Base de datos</b><span class="muted">Precios del ${PRICE_DATE.split('-').reverse().join('/')} · ${days} día${days === 1 ? '' : 's'} de historial</span>
      <span class="muted">${ONLINE ? 'Se actualiza sola cada vez que abres la app y hay precios nuevos.' : 'Para actualizar: descarga <b>9bolsillos.db</b> de tu repositorio de GitHub (Releases → datos) y cárgala aquí.'}</span>
      <label class="btn sec" style="display:flex;align-items:center;justify-content:center;cursor:pointer">Cargar base de datos nueva<input type="file" id="dbf" accept=".db" hidden></label></div>
    <div class="card col" style="gap:10px"><b>Estado mínimo en Cardmarket</b>
      <div class="seg" role="group">${Object.keys(CM_COND).map(k => `<button class="${cmCond() === k ? 'on' : ''}" data-cond="${k}">${k}</button>`).join('')}</div>
      <span class="muted">El botón "Ver en Cardmarket" abre las ofertas desde este estado, en español para tus sets y en japonés para tus ilustradores.</span></div>
    <div class="card col" style="gap:10px"><b>Precio que usa la app</b>
      <div class="pills"><button class="pill ${PRICE_MODE === 'trend' ? 'on' : ''}" data-pm="trend">Tendencia</button><button class="pill ${PRICE_MODE === 'low' ? 'on' : ''}" data-pm="low">Oferta más baja</button></div>
      <span class="muted">"Oferta más baja" es el anuncio más barato publicado en Cardmarket, de cualquier idioma y estado, tal como estaba de madrugada. "Tendencia" es el precio medio de venta reciente, más estable. Los gráficos de evolución siempre usan la tendencia.</span></div>
    <div class="card col" style="gap:10px"><b>Cartas y versiones que no existen en español</b>
      <div class="pills"><button class="pill ${SHOW_NON_ES ? '' : 'on'}" data-ne="0">Ocultarlas</button><button class="pill ${SHOW_NON_ES ? 'on' : ''}" data-ne="1">Mostrarlas</button></div>
      <span class="muted">Se ocultan las cartas de sets recientes que no tienen versión en español, las versiones marcadas como de otro idioma y las que tú marques con "No existe". Así los porcentajes y el coste de completar son los reales para tu colección en español.</span></div>
    <div class="card col" style="gap:10px"><b>Tu colección</b><span class="muted">${Object.keys(COL.cards).length} cartas, ${Object.keys(COL.sealed).length} sellados, ${Object.keys(COL.alerts).length} deseos, ${COL.purchases.length} compras y ${Object.keys(COL.sell).length} a la venta. Se guardan solo en este navegador: haz copias de vez en cuando.</span>
      <div class="row" style="flex-wrap:wrap"><button class="btn sec" id="exp">Exportar copia</button>
      <label class="btn sec" style="display:flex;align-items:center;cursor:pointer">Importar copia<input type="file" id="imp" accept=".json" hidden></label></div></div>
    <div class="card col" style="gap:10px"><b>Datos</b><span class="muted">Cartas y sets: TCGdex (licencia MIT). Precios: guía pública de Cardmarket. Imágenes: TCGdex. 9Bolsillos no está afiliado a Pokémon, Cardmarket ni TCGdex.</span></div>
  </div>`;
  document.getElementById('dbf').onchange = async ev => { const f = ev.target.files[0]; if (!f) return; try { const b = await f.arrayBuffer(); openDb(b); await idbPut('db', b); await idbPut('db_date', PRICE_DATE); toast('Base de datos actualizada'); viewSettings(); } catch (e) { alert('No se pudo cargar: ' + e.message); } };
  wireSync(viewSettings);
  pushCard();
  $view.querySelectorAll('[data-ne]').forEach(b => b.onclick = () => { SHOW_NON_ES = b.dataset.ne === '1'; try { localStorage.setItem('9b.showNonEs', SHOW_NON_ES ? '1' : '0'); } catch (e) {} viewSettings(); });
  $view.querySelectorAll('[data-pm]').forEach(b => b.onclick = () => { PRICE_MODE = b.dataset.pm; try { localStorage.setItem('9b.priceMode', PRICE_MODE); } catch (e) {} toast(PRICE_MODE === 'low' ? 'Usando la oferta más baja' : 'Usando la tendencia'); viewSettings(); });
  document.getElementById('exp').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(Object.assign({}, COL, { images: CUSTOM_IMG }), null, 1)], { type: 'application/json' })); a.download = `9bolsillos-coleccion-${new Date().toISOString().slice(0, 10)}.json`; a.click(); };
  document.getElementById('imp').onchange = async ev => { const f = ev.target.files[0]; if (!f) return; try { const c = JSON.parse(await f.text()); if (!c.cards) throw new Error('formato'); if (!confirm('Esto sustituye tu colección actual por la de la copia. ¿Seguir?')) return; const imgs = c.images || {}; delete c.images; COL = Object.assign({ sealed: {}, alerts: {}, illustrators: {}, purchases: [], sell: {}, master: {}, extra: {} }, c); saveCol(); for (const [k, v] of Object.entries(imgs)) { CUSTOM_IMG[k] = v; await idbPut('img:' + k, v); } toast('Colección importada'); viewSettings(); } catch (e) { alert('Archivo no válido'); } };
  $view.querySelectorAll('[data-cond]').forEach(b => b.onclick = () => { try { localStorage.setItem('cm_cond', b.dataset.cond); } catch (e) {} viewSettings(); });
}

function viewWelcome(msg) {
  $tabs.hidden = true;
  $view.innerHTML = `<div class="center"><h1>9Bolsillos</h1>
    <p>Para empezar, carga la base de datos de cartas y precios: el archivo <b>9bolsillos.db</b>.</p>
    <p class="muted">Lo tienes en tu repositorio de GitHub → Releases → datos. Solo hace falta la primera vez: se guarda en este navegador.</p>
    ${msg ? `<p class="down">${esc(msg)}</p>` : ''}
    <label class="btn" style="display:flex;align-items:center;justify-content:center;cursor:pointer">Elegir 9bolsillos.db<input type="file" id="dbf" accept=".db" hidden></label></div>`;
  document.getElementById('dbf').onchange = async ev => {
    const f = ev.target.files[0]; if (!f) return;
    $view.querySelector('label').textContent = 'Cargando…';
    try { const b = await f.arrayBuffer(); openDb(b); await idbPut('db', b); await idbPut('db_date', PRICE_DATE); start(); }
    catch (e) { viewWelcome('No se pudo cargar: ' + e.message); }
  };
}

/* ---------- sincronización entre dispositivos (Supabase) ---------- */
const SB_CFG = window.NB_CONFIG || {};
const SB = (SB_CFG.supabaseUrl && SB_CFG.supabaseKey && window.supabase) ? window.supabase.createClient(SB_CFG.supabaseUrl, SB_CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true } }) : null;
let SB_USER = null, SB_LAST = null, SB_BUSY = false, pushTimer = null, imgsDirty = false;
async function sbInit() {
  if (!SB) return;
  const { data } = await SB.auth.getSession();
  SB_USER = data && data.session ? data.session.user : null;
  // Si estás en Ajustes, se vuelve a dibujar con la sesión ya comprobada
  const redrawSettings = () => { if (DB && location.hash.startsWith('#/settings')) route(); };
  SB.auth.onAuthStateChange((_e, session) => { const was = SB_USER && SB_USER.id; SB_USER = session ? session.user : null; if (was !== (SB_USER && SB_USER.id)) redrawSettings(); });
  redrawSettings();
  if (SB_USER) { await syncNow(true); redrawSettings(); }
  if (await applyPendingReal() === 'cloud' && DB && !location.hash.includes('precio')) route();
}
// Trae la versión de la nube; se queda con la más reciente (la de la nube o la de este dispositivo)
async function syncNow(quiet) {
  if (!SB || !SB_USER || SB_BUSY) return;
  SB_BUSY = true;
  try {
    const { data, error } = await SB.from('collections').select('data, images, updated_at').eq('user_id', SB_USER.id).maybeSingle();
    if (error) throw error;
    const remote = data && data.data && data.data.cards ? data.data : null;
    const lt = COL.updatedAt || 0, rt = remote ? (remote.updatedAt || 0) : -1;
    const firstTime = localStorage.getItem('9b.synced') !== (SB_USER.id);
    if (remote && firstTime && Object.keys(COL.cards).length) {
      // Primera vez en este dispositivo con datos en los dos lados: se juntan, no se pisa nada
      COL = mergeCols(remote, COL); COL.updatedAt = Date.now();
      localStorage.setItem(STORE_KEY, JSON.stringify(COL));
      for (const [k, v] of Object.entries(data.images || {})) if (!CUSTOM_IMG[k]) { CUSTOM_IMG[k] = v; await idbPut('img:' + k, v); }
      await pushNow(true);
      if (!quiet) toast('Colecciones unidas y sincronizadas');
      if (DB) route();
    } else if (remote && rt > lt) {
      COL = Object.assign({ sealed: {}, alerts: {}, illustrators: {}, purchases: [], sell: {}, master: {}, extra: {} }, remote);
      localStorage.setItem(STORE_KEY, JSON.stringify(COL));
      for (const [k, v] of Object.entries(data.images || {})) { if (CUSTOM_IMG[k] !== v) { CUSTOM_IMG[k] = v; await idbPut('img:' + k, v); } }
      for (const k of Object.keys(CUSTOM_IMG)) if (!(data.images || {})[k]) { delete CUSTOM_IMG[k]; await idbDel('img:' + k); }
      if (!quiet) toast('Colección actualizada desde la nube');
      if (DB) route();
    } else if (!remote || lt > rt) {
      await pushNow(true);
      if (!quiet) toast('Colección subida a la nube');
    }
    SB_LAST = new Date(); localStorage.setItem('9b.synced', SB_USER.id);
  } catch (e) { console.warn('Sync:', e); toast('No se pudo sincronizar: ' + (e.message || e)); }
  SB_BUSY = false;
}
function mergeCols(a, b) {
  const out = Object.assign({ sealed: {}, alerts: {}, illustrators: {}, purchases: [], sell: {}, master: {}, hide: {}, setHide: {} }, a);
  for (const k of ['cards', 'sealed', 'alerts', 'illustrators', 'sell', 'hide', 'extra', 'binders', 'real', 'cmurl', 'setMode']) out[k] = Object.assign({}, a[k] || {}, b[k] || {});
  out.real = {}; for (const src of [a.real || {}, b.real || {}]) for (const [k, v] of Object.entries(src)) if (!out.real[k] || (v.d || '') >= (out.real[k].d || '')) out.real[k] = v;
  out.master = Object.assign({}, a.master || {}); for (const [id, m] of Object.entries(b.master || {})) out.master[id] = Object.assign({}, out.master[id] || {}, m);
  out.setHide = Object.assign({}, a.setHide || {}); for (const [id, l] of Object.entries(b.setHide || {})) out.setHide[id] = [...new Set([...(out.setHide[id] || []), ...l])];
  const ids = new Set((a.purchases || []).map(p => p.id)); out.purchases = (a.purchases || []).concat((b.purchases || []).filter(p => !ids.has(p.id)));
  return out;
}
async function pushNow(withImages) {
  if (!SB || !SB_USER) return;
  const row = { user_id: SB_USER.id, data: COL, updated_at: new Date().toISOString() };
  if (withImages || imgsDirty) row.images = CUSTOM_IMG;
  const { error } = await SB.from('collections').upsert(row);
  if (error) throw error;
  imgsDirty = false; SB_LAST = new Date();
}
function schedulePush() {
  if (!SB || !SB_USER) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushNow().catch(e => console.warn('Sync:', e)), 1500);
}
// Al volver a la app (por ejemplo, cambiar del móvil al ordenador), trae los cambios
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(true); });

/* ---------- avisos al móvil (Web Push) ---------- */
const PUSH_OK = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STANDALONE = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
let SW_REG = null;
function registerSw() { if (!('serviceWorker' in navigator) || location.protocol === 'file:') return Promise.resolve(null); return navigator.serviceWorker.register('sw.js').then(r => SW_REG = r).catch(e => { console.warn('SW:', e); return null; }); }
function b64u(s) { const p = '='.repeat((4 - s.length % 4) % 4), b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); }
async function currentSub() { const r = SW_REG || await registerSw(); return r ? r.pushManager.getSubscription() : null; }
async function pushCard() {
  const el = document.getElementById('pushcard'); if (!el) return;
  const key = (window.NB_CONFIG || {}).vapidPublicKey;
  const head = '<b>Avisos al móvil</b><span class="muted">Te llega una notificación cuando una carta de tu lista de deseos baja de tu precio objetivo. Se comprueba cada mañana, al actualizarse los precios.</span>';
  let body = '';
  if (!PUSH_OK) body = IS_IOS && !STANDALONE ? '<span class="muted">En iPhone primero instala la app: en Safari, Compartir → "Añadir a pantalla de inicio", y ábrela desde el icono. Necesita iOS 16.4 o posterior.</span>' : '<span class="muted">Este navegador no admite avisos.</span>';
  else if (!key) body = '<span class="muted">Falta la clave de avisos (vapidPublicKey) en config.js. Mira el LEEME.</span>';
  else if (!SB_USER) body = '<span class="muted">Entra en "Sincronizar entre dispositivos" para activar los avisos.</span>';
  else {
    const sub = await currentSub().catch(() => null);
    const perm = Notification.permission;
    body = perm === 'denied' ? '<span class="muted">Has bloqueado las notificaciones de 9Bolsillos. Actívalas en los ajustes del navegador o del móvil y vuelve aquí.</span>'
      : sub ? `<span class="up" style="font-weight:600">Activados en este dispositivo</span><span class="muted">${Object.values(COL.alerts).filter(a => a.target).length} deseos con precio objetivo.</span><div class="row" style="flex-wrap:wrap"><button class="btn sec" id="pstest">Probar</button><button class="btn warn" id="psoff">Desactivar aquí</button></div>`
      : '<div class="row"><button class="btn" id="pson">Activar avisos en este dispositivo</button></div>';
  }
  el.innerHTML = head + body;
  const on = document.getElementById('pson'), off = document.getElementById('psoff'), test = document.getElementById('pstest');
  if (on) on.onclick = async () => {
    try {
      if (await Notification.requestPermission() !== 'granted') { toast('Sin permiso para notificaciones'); return pushCard(); }
      const r = SW_REG || await registerSw(); await navigator.serviceWorker.ready;
      const sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(key) });
      const { error } = await SB.from('push_subs').upsert({ endpoint: sub.endpoint, user_id: SB_USER.id, sub: sub.toJSON(), ua: navigator.userAgent.slice(0, 200) });
      if (error) { await sub.unsubscribe(); throw error; }
      toast('Avisos activados');
    } catch (e) { alert('No se pudieron activar los avisos: ' + (e.message || e) + (/push_subs/.test(e.message || '') ? '\n\n¿Has ejecutado el SQL de avisos en Supabase? Mira el LEEME.' : '')); }
    pushCard();
  };
  if (off) off.onclick = async () => { const sub = await currentSub(); if (sub) { await SB.from('push_subs').delete().eq('endpoint', sub.endpoint); await sub.unsubscribe(); } toast('Avisos desactivados en este dispositivo'); pushCard(); };
  if (test) test.onclick = async () => { const r = SW_REG || await registerSw(); r.showNotification('9Bolsillos', { body: 'Así te llegarán los avisos de precio.', icon: 'icon-192.png', data: { url: './#/wish' } }); };
}

function syncCard() {
  if (!SB) return `<div class="card col" style="gap:8px"><b>Sincronizar entre dispositivos</b><span class="muted">Sin configurar. Sigue los pasos del archivo LEEME para conectar tu cuenta gratuita de Supabase; después podrás entrar con tu email aquí y en el móvil.</span></div>`;
  if (!SB_USER) return `<div class="card col" style="gap:10px"><b>Sincronizar entre dispositivos</b>
    <span class="muted">Entra con tu cuenta y tu colección será la misma en el ordenador y en el móvil.</span>
    <label class="f">Email<input type="text" id="sbe" autocomplete="email" inputmode="email"></label>
    <label class="f">Contraseña<input type="password" id="sbp" autocomplete="current-password" style="height:44px;border-radius:10px;border:1px solid #39404B;background:var(--bg);color:var(--tx);padding:0 12px"></label>
    <div class="row" style="flex-wrap:wrap"><button class="btn" id="sbin">Entrar</button><button class="btn sec" id="sbup">Crear cuenta</button></div></div>`;
  return `<div class="card col" style="gap:10px"><b>Sincronizar entre dispositivos</b>
    <span class="muted">Conectado como <b style="color:var(--tx)">${esc(SB_USER.email)}</b>${SB_LAST ? ` · última sincronización ${SB_LAST.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}` : ''}. Los cambios se guardan solos.</span>
    <span class="muted" id="sbdiag">Comprobando la nube…</span>
    <div class="row" style="flex-wrap:wrap"><button class="btn sec" id="sbnow">Sincronizar ahora</button><button class="btn warn" id="sbout">Cerrar sesión</button></div>
    <details><summary class="muted" style="cursor:pointer">Opciones avanzadas</summary><div class="row" style="flex-wrap:wrap;margin-top:8px">
      <button class="btn sec" id="sbup2">Subir este dispositivo a la nube</button><button class="btn sec" id="sbdown">Bajar la colección de la nube</button></div>
      <span class="muted" style="font-size:12px">"Subir" sustituye lo que hay en la nube por lo de este dispositivo. "Bajar" hace lo contrario. Úsalos si los dos dispositivos no coinciden.</span></details></div>`;
}
function wireSync(rerender) {
  const g = id => document.getElementById(id);
  if (g('sbin')) g('sbin').onclick = async () => { const { error } = await SB.auth.signInWithPassword({ email: g('sbe').value.trim(), password: g('sbp').value }); if (error) { alert('No se pudo entrar: ' + error.message); return; } const s = await SB.auth.getSession(); SB_USER = s.data.session.user; await syncNow(); rerender(); };
  if (g('sbup')) g('sbup').onclick = async () => { const email = g('sbe').value.trim(), password = g('sbp').value; if (password.length < 8) { alert('La contraseña debe tener al menos 8 caracteres'); return; } const { data, error } = await SB.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }); if (error) { alert('No se pudo crear la cuenta: ' + error.message); return; } if (data.session) { SB_USER = data.session.user; await syncNow(); rerender(); } else alert('Cuenta creada. Revisa tu email para confirmarla y luego pulsa "Entrar".'); };
  if (g('sbnow')) g('sbnow').onclick = async () => { g('sbnow').textContent = 'Sincronizando…'; await syncNow(); rerender(); };
  if (g('sbout')) g('sbout').onclick = async () => { await SB.auth.signOut(); SB_USER = null; rerender(); };
  if (g('sbdiag')) (async () => {
    const { data, error } = await SB.from('collections').select('data, updated_at').eq('user_id', SB_USER.id).maybeSingle();
    const local = Object.keys(COL.cards).length;
    g('sbdiag').innerHTML = error ? `<span class="down">Error con la nube: ${esc(error.message)}</span>`
      : `En la nube: <b style="color:var(--tx)">${data && data.data && data.data.cards ? Object.keys(data.data.cards).length : 0} cartas</b>${data ? ' (guardado ' + new Date(data.updated_at).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ')' : ' (vacía)'} · en este dispositivo: <b style="color:var(--tx)">${local} cartas</b>`;
  })();
  if (g('sbup2')) g('sbup2').onclick = async () => { if (!confirm('¿Sustituir lo que hay en la nube por la colección de este dispositivo?')) return; try { COL.updatedAt = Date.now(); localStorage.setItem(STORE_KEY, JSON.stringify(COL)); await pushNow(true); localStorage.setItem('9b.synced', SB_USER.id); toast('Subida a la nube'); } catch (e) { alert('Error: ' + e.message); } rerender(); };
  if (g('sbdown')) g('sbdown').onclick = async () => { if (!confirm('¿Sustituir la colección de este dispositivo por la de la nube?')) return;
    const { data, error } = await SB.from('collections').select('data, images').eq('user_id', SB_USER.id).maybeSingle();
    if (error || !data || !data.data || !data.data.cards) { alert(error ? 'Error: ' + error.message : 'La nube está vacía'); return; }
    COL = Object.assign({ sealed: {}, alerts: {}, illustrators: {}, purchases: [], sell: {}, master: {}, extra: {} }, data.data); localStorage.setItem(STORE_KEY, JSON.stringify(COL)); localStorage.setItem('9b.synced', SB_USER.id);
    for (const [k, v] of Object.entries(data.images || {})) { CUSTOM_IMG[k] = v; await idbPut('img:' + k, v); }
    toast('Colección bajada de la nube'); rerender(); };
}

/* ---------- router ---------- */
function route() {
  if (!DB) return;
  const h = decodeURIComponent(location.hash.slice(1) || '/');
  const [, a, b] = h.split('/');
  const tab = { '': 'home', sets: 'sets', set: 'sets', card: 'sets', ocard: 'sets', illustrators: 'more', illustrator: 'sets', search: 'search', alerts: 'wish', wish: 'wish', settings: 'more', more: 'more', buy: 'more', scan: 'search', dex: 'sets', stats: 'more', calendario: 'more', show: 'more', expenses: 'more', sealed: 'more', sealeditem: 'sets', sell: 'more' }[a || ''] || 'home';
  $tabs.querySelectorAll('a').forEach(x => x.classList.toggle('on', x.dataset.t === tab));
  window.scrollTo(0, 0);
  $view.classList.remove('vin'); void $view.offsetWidth; $view.classList.add('vin');   // entrada suave de cada pantalla
  if (a !== 'show' || !b) document.body.classList.remove('showmode');
  if (a === 'card' || a === 'ocard') { if (LIST_CTX && LIST_CTX.includes(location.hash)) NAV_CTX = LIST_CTX; else if (!(NAV_CTX && NAV_CTX.includes(location.hash))) NAV_CTX = null; } else LIST_CTX = null;
  try {
    if (!a) viewHome();
    else if (a.startsWith('precio')) viewRecvPrice(location.hash.split('?')[1] || '');   // sin decodificar: la dirección de Cardmarket lleva barras
    else if (a === 'sets') viewSets();
    else if (a === 'set') viewSet(b);
    else if (a === 'illustrators') viewIllustrators();
    else if (a === 'illustrator') viewIllustrator(b);
    else if (a === 'card') viewCard(b);
    else if (a === 'ocard') viewOrdenCard(b, h.split('/')[3]);
    else if (a === 'search') viewSearch();
    else if (a === 'alerts' || a === 'wish') viewWishlist();
    else if (a === 'expenses') viewExpenses();
    else if (a === 'sealed') viewSealed();
    else if (a === 'sealeditem') viewSealedItem(b);
    else if (a === 'sell') viewSell();
    else if (a === 'buy') viewBuy();
    else if (a === 'scan') viewScan();
    else if (a === 'dex') viewDex(+b);
    else if (a === 'stats') viewStats();
    else if (a === 'calendario') viewCalendar();
    else if (a === 'show') viewShow(b ? decodeURIComponent(b) : '');
    else if (a === 'more') viewMore();
    else if (a === 'settings') viewSettings();
    else viewHome();
  } catch (e) { console.error(e); $view.innerHTML = `<p class="down">Error: ${esc(e.message)}</p>`; }
}
function start() { $tabs.hidden = false; registerSw(); route(); sbInit().catch(e => console.warn('Sync:', e)); }
window.addEventListener('hashchange', route);

// Descarga automática cuando la app está publicada en internet (GitHub Pages)
const ONLINE = location.protocol.startsWith('http');
// Descarga solo lo que cambia: la base completa (comprimida) si cambia el catálogo; si no, los precios del día
// y los días de historial que falten (~1 MB al día en vez de ~26 MB)
async function fetchBytes(url, label) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('No se pudo descargar ' + url + ' (' + r.status + ')');
  const total = +r.headers.get('content-length') || 0, reader = r.body.getReader(), parts = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    parts.push(value); got += value.length;
    const pg = document.getElementById('prog'); if (pg && label) pg.textContent = label + ' · ' + (total ? Math.round(got / total * 100) + ' %' : (got / 1048576).toFixed(1) + ' MB');
  }
  const bytes = new Uint8Array(got); let off = 0; parts.forEach(p => { bytes.set(p, off); off += p.length; });
  return bytes;
}
async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip');
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
}
const gzJson = async url => JSON.parse(new TextDecoder().decode(await gunzip(await fetchBytes(url))));
function showProgress(msg) { $view.innerHTML = `<div class="center"><h1>9Bolsillos</h1><p>${esc(msg)}</p><p class="muted" id="prog"></p></div>`; }
async function saveDb(meta) { const buf = DB.export().buffer; await idbPut('db', buf); await idbPut('db_meta', meta); }
async function autoUpdate() {
  const v = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : null);
  if (!v || !v.prices_date) return false;
  // Si el móvil tiene guardada una versión vieja de la app, recarga una vez saltándose la caché
  const mine = ((document.querySelector('script[src*="app.js"]') || {}).src || '').split('v=')[1] || '';
  if (v.app_ver && mine && v.app_ver !== mine) {
    let tried = ''; try { tried = sessionStorage.getItem('reload_for') || ''; sessionStorage.setItem('reload_for', v.app_ver); } catch (e) {}
    if (tried !== v.app_ver) { location.replace(location.pathname + '?r=' + v.app_ver + location.hash); return false; }
  }
  if (!v.catalog_ver) {   // publicación antigua: descarga completa sin comprimir
    const want = v.prices_date + '|' + (v.built_at || '');
    if ((await idbGet('db_ver')) === want && await idbGet('db')) return false;
    showProgress('Descargando precios del ' + v.prices_date.split('-').reverse().join('/') + '…');
    const bytes = await fetchBytes('9bolsillos.db?v=' + encodeURIComponent(want), 'Base de datos');
    openDb(bytes.buffer); await idbPut('db', bytes.buffer); await idbPut('db_ver', want); return true;
  }
  const meta = (await idbGet('db_meta')) || {};
  const saved = await idbGet('db');
  const firstDay = (v.history_days || [])[0] || 0, haveDay = +(meta.prices_date || '').replace(/-/g, '');
  const needFull = !saved || meta.catalog_ver !== v.catalog_ver || meta.schema !== v.schema || (haveDay && haveDay < firstDay - 1);
  if (needFull) {
    showProgress(saved ? 'Hay cartas o sets nuevos: actualizando el catálogo…' : 'Descargando el catálogo de cartas (solo la primera vez)…');
    const raw = await gunzip(await fetchBytes('9bolsillos.db.gz?v=' + v.catalog_ver + v.prices_date, 'Catálogo'));
    openDb(raw.buffer);
    await saveDb({ catalog_ver: v.catalog_ver, prices_date: v.prices_date, schema: v.schema });
    return true;
  }
  if (meta.prices_date === v.prices_date) return false;
  // Solo precios del día + historial que falte
  openDb(saved);
  showProgress('Actualizando precios del ' + v.prices_date.split('-').reverse().join('/') + '…');
  const pr = await gzJson('prices-latest.json.gz?v=' + v.prices_date);
  DB.run('BEGIN');
  DB.run('DELETE FROM prices');
  const st = DB.prepare(`INSERT OR REPLACE INTO prices (cm_product_id, date, ${pr.cols.join(', ')}) VALUES (?, ?, ${pr.cols.map(() => '?').join(', ')})`);
  pr.rows.forEach(r => { st.run([r[0], pr.date].concat(r.slice(1))); }); st.free();
  DB.run("INSERT OR REPLACE INTO meta VALUES ('prices_date', ?)", [pr.date]);
  DB.run('COMMIT');
  if (HAS_HISTORY) {
    const haveDays = new Set(q('SELECT DISTINCT day FROM history').map(r => r.day));
    for (const d of (v.history_days || []).filter(d => !haveDays.has(d))) {
      const rows = await gzJson('history-' + d + '.json.gz');
      DB.run('BEGIN'); const hs = DB.prepare('INSERT OR REPLACE INTO history VALUES (?, ?, ?, ?)');
      rows.forEach(r => hs.run([r[0], d, r[1], r[2]])); hs.free(); DB.run('COMMIT');
    }
    // Misma regla que el servidor: diario 90 días, semanal antes
    const last = (v.history_days || []).slice(-1)[0];
    if (last) {
      const dt = new Date(String(last).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')); dt.setDate(dt.getDate() - 90);
      const cut = +dt.toISOString().slice(0, 10).replace(/-/g, '');
      q('SELECT DISTINCT day FROM history WHERE day < ?', [cut]).forEach(r => { const x = new Date(String(r.day).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')); if (x.getDay() !== 1) DB.run('DELETE FROM history WHERE day = ?', [r.day]); });
    }
  }
  PRICE_DATE = pr.date;
  await saveDb({ catalog_ver: v.catalog_ver, prices_date: v.prices_date, schema: v.schema });
  return true;
}

(async function init() {
  try {
    SQL = await initSqlJs();
    try { await loadCustomImgs(); } catch (e) {}
    if (ONLINE) {
      try { if (await autoUpdate()) return start(); }
      catch (e) { console.warn('Sin actualización automática:', e); }
    }
    const saved = await idbGet('db');
    if (saved) { try { openDb(saved); return start(); } catch (e) { await idbDel('db'); } }
    viewWelcome();
  } catch (e) {
    $view.innerHTML = `<div class="center"><h1>9Bolsillos</h1><p class="down">No se pudo arrancar: ${esc(e.message)}</p><p class="muted">Usa Chrome o Edge actualizados.</p></div>`;
  }
})();
