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
function setLogo(base, cls, name = '') {
  // Si TCGdex aún no tiene logo (sets muy nuevos), se muestra un distintivo con el nombre
  const badge = `<span class="fbn logofb ${cls === 'biglogo' ? 'big' : ''}" ${base ? 'style="display:none"' : ''}>${esc(name)}</span>`;
  if (!base) return badge;
  const dir = base.replace(/\/[^/]+$/, '');
  const urls = dir.includes('/en/') ? [dir.replace('/en/', '/es/') + '/logo.webp', dir + '/logo.webp'] : [dir + '/logo.webp', ''];
  return `<img class="${cls}" loading="lazy" alt="" src="${esc(urls[0])}" data-fb="${esc(urls[1])}" onerror="${IMG_ERR.replace("this.style.visibility='hidden'", "this.style.display='none'")}">` + badge;
}
// Enlace a Cardmarket: listado de singles del set de la carta, filtrado por su nombre
function cmLink(v, c) {
  const r = v ? q('SELECT name, cm_expansion_id FROM cm_products WHERE cm_product_id = ?', [v.cm_product_id])[0] : null;
  const name = r ? r.name.replace(/\s*\[.*$/, '') : (c.name_en || c.name);
  return 'https://www.cardmarket.com/es/Pokemon/Products/Singles' + (r && r.cm_expansion_id ? '?idExpansion=' + r.cm_expansion_id + '&' : '?') + 'searchString=' + encodeURIComponent(name);
}
function cardImg(c, size, cls, alt) { return CUSTOM_IMG[c.card_id] ? `<img ${cls ? `class="${cls}"` : ''} alt="${esc(alt || '')}" src="${CUSTOM_IMG[c.card_id]}">` : imgTag(c.image_base, size, cls, alt || ''); }
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
const IMG_ERR = "if(this.dataset.fb){this.src=this.dataset.fb;this.dataset.fb=''}else{this.style.visibility='hidden';var n=this.parentNode&&this.parentNode.querySelector('.fbn');if(n)n.style.display=''}";
function imgTag(base, size, cls, alt, extra = '') {
  const [src, fb] = imgUrls(base, size);
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
function vPrice(v) {
  if (!v) return null;
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
function chartSvg(points, w = 700, h = 180) {
  if (points.length < 2) {
    return `<div class="card muted" style="height:${h}px;display:flex;align-items:center;justify-content:center;text-align:center">El gráfico se irá llenando con los precios de cada día.<br>Ahora hay ${points.length} día de historial.</div>`;
  }
  const ys = points.map(p => p[1]); const mn = Math.min(...ys), mx = Math.max(...ys);
  const pad = 10, X = i => 4 + i / (points.length - 1) * (w - 8), Y = v => pad + (1 - (v - mn) / ((mx - mn) || 1)) * (h - pad * 2);
  const line = points.map((p, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join(' ');
  const up = ys[ys.length - 1] >= ys[0], col = up ? 'var(--up)' : 'var(--down)';
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="Evolución del valor">
    <path d="${line} L${X(points.length - 1)} ${h} L${X(0)} ${h} Z" fill="${up ? 'rgba(61,220,151,.12)' : 'rgba(242,166,90,.12)'}"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>
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

  const alertsHit = alertStatus().filter(a => a.hit).length;
  const periods = [[7, '1S'], [30, '1M'], [90, '3M'], [365, '1A'], [0, 'Todo']];
  $view.innerHTML = `<div class="stack">
    <div class="between"><div class="row" style="gap:10px"><img src="icon-192.png" alt="" width="36" height="36" style="border-radius:9px"><h1>9Bolsillos</h1></div><a class="pill" style="display:flex;align-items:center" href="#/settings">Ajustes</a></div>
    ${alertsHit ? `<a class="alertbox" href="#/wish" style="color:var(--tx)"><b class="up">${alertsHit} alerta${alertsHit > 1 ? 's' : ''} de precio</b> ${alertsHit > 1 ? 'han saltado' : 'ha saltado'}. Ver →</a>` : ''}
    <div class="col"><span class="muted">Valor de tu colección · precios del ${PRICE_DATE.split('-').reverse().join('/')}</span>
      <div class="big">${eur(total)}</div>${change}
      <span class="muted">${n} carta${n === 1 ? '' : 's'}${sealedIds.length ? ` · ${sealedIds.length} producto${sealedIds.length > 1 ? 's' : ''} sellado${sealedIds.length > 1 ? 's' : ''}` : ''}${cost ? ` · pagaste ${eur(cost)} por las que tienen precio de compra` : ''}</span></div>
    <div class="col" style="gap:10px">${chartSvg(pts)}
      <div class="pills">${periods.map(([d, l]) => `<button class="pill ${homePeriod === d ? 'on' : ''}" data-p="${d}">${l}</button>`).join('')}</div></div>
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
  $view.querySelectorAll('[data-mv2]').forEach(b => b.onclick = () => { homeMoves = b.dataset.mv2; viewHome(); });
  const tm = document.getElementById('topmore'); if (tm) tm.onclick = () => { topN = topN > 8 ? 8 : 25; viewHome(); };
}

const LANGS = { es: 'Español / inglés', ja: 'Japonés', ko: 'Coreano', 'zh-tw': 'Chino (trad.)', 'zh-cn': 'Chino (simpl.)', id: 'Indonesio', th: 'Tailandés' };
const NAME = 'COALESCE(c.name_es,c.name_en,c.name_ja,c.name_local)';

let setsFilter = 'es', setsQuery = '';
function viewSets() {
  const rows = q(`SELECT s.set_id, s.lang, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) name, s.serie, s.release_date,
    (SELECT COUNT(*) FROM cards c WHERE c.set_id = s.set_id) n, (SELECT image_base FROM cards c WHERE c.set_id = s.set_id LIMIT 1) ib
    FROM sets s WHERE n > 0 ORDER BY s.release_date DESC, s.set_id`);
  const ownCount = {}; Object.values(COL.cards).forEach(e => ownCount[e.set] = (ownCount[e.set] || 0) + 1);
  const draw = () => {
    const ql = setsQuery.toLowerCase();
    const okLang = r => setsFilter === 'mine' ? ownCount[r.set_id] : setsFilter === 'otros' ? !['es', 'ja'].includes(r.lang) : r.lang === setsFilter;
    const list = rows.filter(r => okLang(r) && (!ql || (r.name || '').toLowerCase().includes(ql) || (r.serie || '').toLowerCase().includes(ql)));
    document.getElementById('setlist').innerHTML = list.map(r => {
      const o = ownCount[r.set_id] || 0, p = Math.round(o / r.n * 100);
      return `<a class="item" href="#/set/${encodeURIComponent(r.set_id)}"><div class="logobox">${setLogo(r.ib, 'setlogo', r.name)}</div><div class="col" style="flex:1"><b>${esc(r.name)}</b><span class="muted">${esc(r.serie)} · ${r.release_date ? esc(r.release_date.slice(0, 4)) : ''} · ${r.n} cartas${setsFilter === 'otros' || setsFilter === 'mine' ? ' · ' + esc(LANGS[r.lang] || r.lang) : ''}</span>
        ${o ? `<div class="bar" style="margin-top:4px"><div style="width:${p}%"></div></div>` : ''}</div><span class="muted">${o ? `${o}/${r.n}` : ''}</span></a>`;
    }).join('') || '<p class="muted">No hay sets que coincidan.</p>';
  };
  $view.innerHTML = `<div class="stack"><div class="between"><h1>Colección</h1><a class="pill" style="display:flex;align-items:center" href="#/illustrators">Ilustradores →</a></div>
    <input type="search" id="sq" placeholder="Buscar set…" value="${esc(setsQuery)}">
    <div class="pills">${[['es', 'Español / inglés'], ['ja', 'Japonés'], ['otros', 'Otros idiomas'], ['mine', 'Mis sets']].map(([k, l]) => `<button class="pill ${setsFilter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
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
function cardBrowser(key, cards0, vmap, el, headEl, opts = {}) {
  const kind = opts.kind || 'set', mode = SORT[kind];
  const pr = c => { const p = COL.cards[c.card_id] ? vPrice(ownedVariant(c.card_id, vmap[c.card_id])) : cheapest(vmap[c.card_id]); return p ?? -1; };
  const num = c => [parseInt(c.local_id, 10) || 0, c.local_id || ''];
  const byRel = (a, b) => (a.release_date || '').localeCompare(b.release_date || '') || (a.set_id || '').localeCompare(b.set_id || '') || num(a)[0] - num(b)[0];
  const cards = cards0.filter(c => !hiddenCard(c)).sort(mode === 'new' ? (a, b) => byRel(b, a) : mode === 'old' ? byRel : mode === 'price_desc' ? (a, b) => pr(b) - pr(a) : mode === 'price_asc' ? (a, b) => (pr(a) < 0) - (pr(b) < 0) || pr(a) - pr(b) : mode === 'name' ? (a, b) => (a.name || '').localeCompare(b.name || '', 'es') : (a, b) => num(a)[0] - num(b)[0] || num(a)[1].localeCompare(num(b)[1]));
  const perSpread = () => window.innerWidth >= 760 ? 2 : 1;
  // Entradas: una por carta (set básico) o una por versión (máster set)
  const entries = () => MASTER
    ? cards.flatMap(c => uniqVariants(vmap[c.card_id]).filter(v => !(v && v.stamp) && !hiddenVariant(c, v)).map(v => ({ c, v, k: vkey(v) })))
    : cards.map(c => ({ c, v: null, k: null }));
  const owns = e => e.k ? ownedKeys(e.c.card_id, vmap[e.c.card_id]).has(e.k) : !!COL.cards[e.c.card_id];
  const priceOf = e => e.k ? vPrice(e.v) : (COL.cards[e.c.card_id] ? vPrice(ownedVariant(e.c.card_id, vmap[e.c.card_id])) : cheapest(vmap[e.c.card_id]));
  const draw = () => {
    const E = entries();
    let have = 0, missCost = 0, val = 0;
    E.forEach(e => { const p = priceOf(e) || 0; if (owns(e)) { have++; val += e.k ? p : cardValue(e.c.card_id, p); } else missCost += p; });
    const p = E.length ? have / E.length * 100 : 0;
    headEl.innerHTML = `<div class="between"><b>${MASTER ? 'Máster set: ' : ''}Tienes ${have} de ${E.length}${MASTER ? ' versiones' : ''}</b><b class="up" style="font-size:22px">${Math.round(p)} %</b></div>
      <div class="bar"><div style="width:${p}%"></div></div>
      <div class="between muted" style="flex-wrap:wrap"><span>Tu parte vale <b style="color:var(--tx)">${eur(val)}</b></span><span>Completarlo hoy: <b style="color:var(--tx)">${eur(missCost)}</b></span></div>`;
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
      const pages = Math.max(1, Math.ceil(E.length / 9)), per = perSpread(), akey = key + (MASTER ? ':m' : '');
      let pg = albumPage[akey] || 0; pg = Math.min(pg - pg % per, (pages - 1) - (pages - 1) % per); albumPage[akey] = pg;
      let html = `<div class="between pgnav"><button class="pill pgbtn" data-pg="-1" ${pg === 0 ? 'disabled' : ''} aria-label="Página anterior">←</button>
        <span class="pgtxt">Página ${pg + 1}${per === 2 && pg + 2 <= pages ? '–' + (pg + 2) : ''} de ${pages}</span>
        <button class="pill pgbtn" data-pg="1" ${pg + per >= pages ? 'disabled' : ''} aria-label="Página siguiente">→</button></div><div class="spread ${albumAnim[akey] || ''}">`;
      for (let k = pg; k < Math.min(pg + per, pages); k++) {
        html += `<div class="page"><div class="pgnum">Página ${k + 1}</div><div class="pockets">`;
        for (let i = 0; i < 9; i++) { const idx = k * 9 + i, e = E[idx]; html += e ? tile(e, idx, `Página ${k + 1}, bolsillo ${i + 1}`) : '<div class="tile empty"><div class="img"></div></div>'; }
        html += '</div></div>';
      }
      el.innerHTML = html + '</div>';
      const turn = d => { const nx = (albumPage[akey] || 0) + d * per; if (nx < 0 || nx >= pages) return; albumPage[akey] = nx; albumAnim[akey] = d > 0 ? 'fromR' : 'fromL'; draw(); albumAnim[akey] = ''; };
      el.querySelectorAll('[data-pg]').forEach(b => b.onclick = () => turn(+b.dataset.pg));
      swipePages(el, turn);
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
      draw();
    });
    el.querySelectorAll('[data-open]').forEach(t => t.onclick = () => location.hash = '#/card/' + encodeURIComponent(t.dataset.open));
  };
  return draw;
}
function browserControls(kind = 'set') {
  return `<div class="between" style="flex-wrap:wrap;gap:8px">
    <div class="pills">${[[false, 'Set básico'], [true, 'Máster set']].map(([k, l]) => `<button class="pill ${MASTER === k ? 'on' : ''}" data-ms="${k}">${l}</button>`).join('')}</div>
    <label class="row muted" style="gap:8px;font-size:13px">Ordenar<select data-sort="${kind}">${SORTS[kind].map(([k, l]) => `<option value="${k}" ${SORT[kind] === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <div class="pills">${[['grid', 'Cuadrícula'], ['album', 'Álbum']].map(([k, l]) => `<button class="pill ${browseMode === k ? 'on' : ''}" data-bm="${k}">${l}</button>`).join('')}</div>
    ${browseMode === 'grid' ? `<div class="pills">${[['all', 'Todas'], ['have', 'Tengo'], ['miss', 'Me faltan']].map(([k, l]) => `<button class="pill ${browseFilter === k ? 'on' : ''}" data-sf="${k}">${l}</button>`).join('')}</div>` : ''}</div>`;
}
function wireControls(rerender) {
  $view.querySelectorAll('[data-bm]').forEach(b => b.onclick = () => { browseMode = b.dataset.bm; rerender(); });
  $view.querySelectorAll('[data-sf]').forEach(b => b.onclick = () => { browseFilter = b.dataset.sf; rerender(); });
  $view.querySelectorAll('[data-sort]').forEach(s => s.onchange = () => { SORT[s.dataset.sort] = s.value; rerender(); });
  $view.querySelectorAll('[data-ms]').forEach(b => b.onclick = () => { MASTER = b.dataset.ms === 'true'; rerender(); });
}

function viewSet(setId) {
  const s = q(`SELECT set_id, lang, COALESCE(name_es,name_en,name_ja,name_local) name, serie, release_date, card_count, cm_expansion_id FROM sets WHERE set_id=?`, [setId])[0];
  if (!s) { $view.innerHTML = '<p>Set no encontrado.</p>'; return; }
  const cards = q(`SELECT c.card_id, c.set_id, c.local_id, ${NAME} name, c.rarity, c.image_base,
    (c.name_es IS NULL AND s.lang='es' AND s.release_date >= '2019') no_es FROM cards c JOIN sets s USING(set_id) WHERE c.set_id=?
    ORDER BY CAST(c.local_id AS INTEGER), c.local_id`, [setId]);
  const ib = (cards.find(c => c.image_base) || {}).image_base;
  const vmap = variantsOf(cards.map(c => c.card_id));
  const sealed = s.cm_expansion_id ? q(`SELECT p.cm_product_id, p.name, p.category, pr.trend, pr.avg30, pr.low FROM cm_products p LEFT JOIN prices pr USING(cm_product_id)
    WHERE p.kind='sealed' AND p.cm_expansion_id=? ORDER BY pr.trend DESC`, [s.cm_expansion_id]) : [];
  const vtypes = [...new Set(cards.flatMap(c => uniqVariants(vmap[c.card_id]).filter(v => v && !v.stamp).map(vLabel)))];
  const hidT = (COL.setHide || {})[setId] || [];
  const nHidden = cards.filter(c => (COL.hide || {})[c.card_id] || c.no_es).length;
  $view.innerHTML = `<div class="stack">
    <div class="row"><a href="#/sets" class="pill" style="display:flex;align-items:center">←</a></div>
    <div class="sethero"><div class="herologo">${setLogo(ib, 'biglogo', s.name)}</div><div class="col" style="align-items:center;text-align:center"><h1>${esc(s.name)}</h1><span class="muted">${esc(s.serie)} · ${esc(s.release_date || '')} · ${esc(LANGS[s.lang] || s.lang)}</span></div></div>
    <div class="card col" style="gap:8px" id="sethead"></div>
    ${browserControls()}
    ${MASTER ? `<div class="col" style="gap:6px"><span class="muted" style="font-size:13px">Versiones que cuentan en este set (desmarca las que no existen en tu idioma):</span>
      <div class="pills">${vtypes.map(t => `<button class="pill ${hidT.includes(t) ? '' : 'on'}" data-vt="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>` : ''}
    ${!SHOW_NON_ES && nHidden ? `<span class="muted" style="font-size:13px">${nHidden} carta${nHidden > 1 ? 's' : ''} oculta${nHidden > 1 ? 's' : ''} porque no existe${nHidden > 1 ? 'n' : ''} en español. <a href="#/settings">Cambiar en Ajustes</a></span>` : ''}
    <div id="grid"></div>
    ${sealed.length ? `<div class="col" style="gap:10px"><h2>Producto sellado</h2>${sealedTiles(sealed.map(x => Object.assign(x, { set_name: s.name })), ib)}</div>` : ''}
    <p class="muted">Precios: ${PRICE_LABEL().toLowerCase()}${s.lang === 'es' ? ' (español e inglés juntos)' : ''}.</p></div>`;
  wireControls(() => viewSet(setId));
  $view.querySelectorAll('[data-vt]').forEach(b => b.onclick = () => { COL.setHide ||= {}; const l = COL.setHide[setId] ||= []; const t = b.dataset.vt; const i = l.indexOf(t); if (i >= 0) l.splice(i, 1); else l.push(t); if (!l.length) delete COL.setHide[setId]; saveCol(); viewSet(setId); });
  wireSealedTiles(() => viewSet(setId));
  cardBrowser('set:' + setId, cards, vmap, document.getElementById('grid'), document.getElementById('sethead'),
    { kind: 'set', sub: c => `${c.local_id}${s.card_count ? '/' + s.card_count : ''} · ${c.rarity || ''}` })();
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
    <div class="row"><a href="${x.set_id ? '#/set/' + encodeURIComponent(x.set_id) : '#/sealed'}" class="pill" style="display:flex;align-items:center">←</a><span class="muted">${esc(x.set_name || '')} · ${esc(SEALED_LABEL[x.category] || x.category)}</span></div>
    <div class="row" style="align-items:flex-start;gap:16px;flex-wrap:wrap">
      <div class="col" style="gap:8px;align-items:flex-start"><div style="width:180px;position:relative">${sealedArt(x, x.ib, 'sealart big')}</div>
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
let illLang = 'ja', illQuery = '', illOrden = true;
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
  const item = (name, n) => { const o = ownBy[name.toLowerCase()] || 0; return `<a class="item" href="#/illustrator/${encodeURIComponent(name)}"><div class="col" style="flex:1"><b>${esc(name)} ${COL.illustrators[name] ? '<span class="up">★</span>' : ''}</b><span class="muted">${n} cartas</span>
    ${o ? `<div class="bar" style="margin-top:4px"><div style="width:${o / n * 100}%"></div></div>` : ''}</div><span class="muted">${o ? o + '/' + n : ''}</span></a>`; };
  const draw = () => {
    const ql = illQuery.toLowerCase();
    document.getElementById('ills').innerHTML = rows.filter(r => !ql || r.name.toLowerCase().includes(ql)).slice(0, 300).map(r => item(r.name, r.n)).join('') || '<p class="muted">Sin resultados.</p>';
  };
  $view.innerHTML = `<div class="stack"><div class="row"><a href="#/sets" class="pill" style="display:flex;align-items:center">←</a><h1>Ilustradores</h1></div>
    ${favs.length ? `<div class="col"><h2>Mis colecciones</h2><div class="list">${favs.map(f => item(f, total[f.toLowerCase()] || 0)).join('')}</div></div>` : '<div class="card muted">Entra en un ilustrador y pulsa "Seguir" para tenerlo aquí como colección.</div>'}
    <div class="pills">${[['ja', 'Japonés'], ['es', 'Español / inglés'], ['all', 'Todos los idiomas']].map(([k, l]) => `<button class="pill ${illLang === k ? 'on' : ''}" data-il="${k}">${l}</button>`).join('')}</div>
    <input type="search" id="iq" placeholder="Buscar ilustrador…" value="${esc(illQuery)}">
    <div class="list" id="ills"></div></div>`;
  $view.querySelectorAll('[data-il]').forEach(b => b.onclick = () => { illLang = b.dataset.il; viewIllustrators(); });
  document.getElementById('iq').oninput = e => { illQuery = e.target.value; draw(); };
  draw();
}
function viewIllustrator(name) {
  const ord = (window.ORDEN || {})[name.toLowerCase()];
  if (ord && illLang === ord.lang && illOrden) return viewOrden(name, ord);
  const cards = q(`SELECT c.card_id, c.set_id, c.local_id, ${NAME} name, c.rarity, c.image_base, s.lang, s.release_date,
    (c.name_es IS NULL AND s.lang='es' AND s.release_date >= '2019') no_es,
    COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name FROM cards c JOIN sets s USING(set_id)
    WHERE c.illustrator = ? COLLATE NOCASE AND ${langCond(illLang)} ORDER BY s.release_date, s.set_id, CAST(c.local_id AS INTEGER)`, [name]);
  const vmap = variantsOf(cards.map(c => c.card_id));
  const fav = !!COL.illustrators[name];
  $view.innerHTML = `<div class="stack">
    <div class="row"><a href="#/illustrators" class="pill" style="display:flex;align-items:center">←</a><div class="col" style="flex:1"><h1>${esc(name)}</h1><span class="muted">Ilustrador · ${cards.length} cartas</span></div>
      <button class="pill ${fav ? 'on' : ''}" id="fav">${fav ? '★ Siguiendo' : '☆ Seguir'}</button></div>
    <div class="pills">${[['ja', 'Japonés'], ['es', 'Español / inglés'], ['all', 'Todos los idiomas']].map(([k, l]) => `<button class="pill ${illLang === k ? 'on' : ''}" data-il="${k}">${l}</button>`).join('')}</div>
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
function ordenPrice(name, e, vmap) { if (e.id) return COL.cards[e.id] ? vPrice(ownedVariant(e.id, vmap[e.id])) : cheapest(vmap[e.id]); return e.cm ? rPrice(e.pr) : null; }
function ordenImg(e, cls = '') { return e.id ? cardImg(e, cls ? 'high' : 'low', cls, e.n) : e.img ? `<img ${cls ? `class="${cls}"` : ''} loading="lazy" alt="${esc(e.n)}" src="${esc(ORDEN_IMG + e.img)}" onerror="this.remove()">` : ''; }
function viewOrden(name, ord) {
  const { E, vmap } = ordenData(ord);
  $view.innerHTML = `<div class="stack">
    <div class="row"><a href="#/illustrators" class="pill" style="display:flex;align-items:center">←</a><div class="col" style="flex:1"><h1>${esc(name)}</h1><span class="muted">${esc(ord.titulo)} · ${E.length} ilustraciones</span></div>
      <button class="pill ${COL.illustrators[name] ? 'on' : ''}" id="fav">${COL.illustrators[name] ? '★ Siguiendo' : '☆ Seguir'}</button></div>
    <div class="pills">${[['ja', 'Japonés'], ['es', 'Español / inglés'], ['all', 'Todos los idiomas']].map(([k, l]) => `<button class="pill ${illLang === k ? 'on' : ''}" data-il="${k}">${l}</button>`).join('')}</div>
    ${ordenTabs(true)}
    <div class="card col" style="gap:8px" id="ohead"></div>
    <div class="between" style="flex-wrap:wrap;gap:8px">
      <div class="pills">${[['grid', 'Cuadrícula'], ['album', 'Álbum']].map(([k, l]) => `<button class="pill ${browseMode === k ? 'on' : ''}" data-bm="${k}">${l}</button>`).join('')}</div>
      ${browseMode === 'grid' ? `<div class="pills">${[['all', 'Todas'], ['have', 'Tengo'], ['miss', 'Me faltan']].map(([k, l]) => `<button class="pill ${browseFilter === k ? 'on' : ''}" data-sf="${k}">${l}</button>`).join('')}</div>` : ''}</div>
    <div id="ogrid"></div>
    <p class="muted">Una carta por ilustración, la primera vez que salió en japonés, en orden de lanzamiento. Las reimpresiones con el mismo dibujo están en la nota de cada carta. Fotos de las cartas que no están en la base de datos: CollectHolo.</p></div>`;
  document.getElementById('fav').onclick = () => { if (COL.illustrators[name]) delete COL.illustrators[name]; else COL.illustrators[name] = { since: PRICE_DATE }; saveCol(); viewOrden(name, ord); };
  $view.querySelectorAll('[data-il]').forEach(b => b.onclick = () => { illLang = b.dataset.il; viewIllustrator(name); });
  $view.querySelectorAll('[data-ord]').forEach(b => b.onclick = () => { illOrden = b.dataset.ord === '1'; viewIllustrator(name); });
  wireControls(() => viewOrden(name, ord));
  const el = document.getElementById('ogrid'), headEl = document.getElementById('ohead'), akey = 'orden:' + name;
  const tile = (e, i, pocket) => { const has = ordenOwned(name, e), p = ordenPrice(name, e, vmap);
    return `<div class="tile ${has ? 'has' : 'miss'}" data-oi="${i}" title="${pocket ? esc(pocket) : ''}">
      <div class="img"><span class="fbn">${esc(e.n)}</span>${ordenImg(e)}<span class="vtag">#${e.o}</span>
        <button class="own" data-oown="${i}" aria-label="${has ? 'Quitar de' : 'Añadir a'} mi colección: ${esc(e.n)}">${has ? '✓' : '＋'}</button></div>
      <span class="num">${esc(e.d.slice(0, 4))} · ${esc(e.s)}</span><span class="nm">${esc(e.n)}</span><span class="pr">${eur(p)}</span></div>`; };
  const draw = () => {
    let have = 0, val = 0, miss = 0;
    E.forEach(e => { const p = ordenPrice(name, e, vmap) || 0; if (ordenOwned(name, e)) { have++; val += e.id ? cardValue(e.id, p) : p * ((COL.extra[ordenKey(name, e).slice(2)] || {}).qty || 1); } else miss += p; });
    const pc = have / E.length * 100, next = E.find(e => !ordenOwned(name, e));
    headEl.innerHTML = `<div class="between"><b>Tienes ${have} de ${E.length}</b><b class="up" style="font-size:22px">${Math.round(pc)} %</b></div>
      <div class="bar"><div style="width:${pc}%"></div></div>
      <div class="between muted" style="flex-wrap:wrap"><span>Tu parte vale <b style="color:var(--tx)">${eur(val)}</b></span><span>Lo que falta (con precio): <b style="color:var(--tx)">${eur(miss)}</b></span></div>
      ${next ? `<span class="muted">Siguiente en tu orden: <b style="color:var(--tx)">#${next.o} ${esc(next.n)}</b> · ${esc(next.s)} (${esc(next.d.slice(0, 4))})</span>` : ''}`;
    if (browseMode === 'album') {
      const pages = Math.ceil(E.length / 9), per = window.innerWidth >= 760 ? 2 : 1;
      let pg = albumPage[akey] || 0; pg = Math.min(pg - pg % per, (pages - 1) - (pages - 1) % per); albumPage[akey] = pg;
      let html = `<div class="between pgnav"><button class="pill pgbtn" data-pg="-1" ${pg === 0 ? 'disabled' : ''} aria-label="Página anterior">←</button>
        <span class="pgtxt">Página ${pg + 1}${per === 2 && pg + 2 <= pages ? '–' + (pg + 2) : ''} de ${pages}</span>
        <button class="pill pgbtn" data-pg="1" ${pg + per >= pages ? 'disabled' : ''} aria-label="Página siguiente">→</button></div><div class="spread ${albumAnim[akey] || ''}">`;
      for (let k = pg; k < Math.min(pg + per, pages); k++) {
        html += `<div class="page"><div class="pgnum">Página ${k + 1}</div><div class="pockets">`;
        for (let i = 0; i < 9; i++) { const idx = k * 9 + i, e = E[idx]; html += e ? tile(e, idx, `Página ${k + 1}, bolsillo ${i + 1}`) : '<div class="tile empty"><div class="img"></div></div>'; }
        html += '</div></div>';
      }
      el.innerHTML = html + '</div>';
      const turn = d => { const nx = (albumPage[akey] || 0) + d * per; if (nx < 0 || nx >= pages) return; albumPage[akey] = nx; albumAnim[akey] = d > 0 ? 'fromR' : 'fromL'; draw(); albumAnim[akey] = ''; };
      el.querySelectorAll('[data-pg]').forEach(b => b.onclick = () => turn(+b.dataset.pg));
      swipePages(el, turn);
    } else {
      const idx = E.map((e, i) => i).filter(i => browseFilter === 'all' || (browseFilter === 'have') === ordenOwned(name, E[i]));
      const years = {}; idx.forEach(i => (years[E[i].d.slice(0, 4)] ||= []).push(i));
      el.innerHTML = Object.entries(years).map(([y, is]) => { const tot = E.filter(e => e.d.startsWith(y)), got = tot.filter(e => ordenOwned(name, e)).length;
        return `<div class="between" style="margin:14px 0 8px"><h2>${esc(y)}</h2><span class="muted">${got}/${tot.length}</span></div><div class="grid">${is.map(i => tile(E[i], i)).join('')}</div>`; }).join('')
        || '<p class="muted">Nada que mostrar con este filtro.</p>';
    }
    el.querySelectorAll('[data-oown]').forEach(b => b.onclick = ev => { ev.stopPropagation(); ordenToggle(name, E[+b.dataset.oown], vmap); draw(); });
    el.querySelectorAll('[data-oi]').forEach(t => t.onclick = () => { const e = E[+t.dataset.oi]; if (e.id) location.hash = '#/card/' + encodeURIComponent(e.id); else ordenSheet(name, e, vmap, draw); });
  };
  draw();
}
// Ficha de una carta que no está en la base de datos: foto grande, datos y botón de Cardmarket
function ordenSheet(name, e, vmap, redraw) {
  const p = ordenPrice(name, e, vmap), cmUrl = 'https://www.cardmarket.com/es/Pokemon/Products/Singles?' + (e.cm ? 'idProduct=' + e.cm + '&' : '') + 'searchString=' + encodeURIComponent(e.n);
  const box = document.createElement('div'); box.className = 'sheet';
  const paint = () => { const has = ordenOwned(name, e);
    box.innerHTML = `<div class="sheetin" role="dialog" aria-label="${esc(e.n)}"><button class="pill sheetx" aria-label="Cerrar">✕</button>
      <div class="cardhero">${ordenImg(e, 'hero') || `<div class="hero" style="display:flex;align-items:center;justify-content:center;padding:12px;text-align:center" >${esc(e.n)}<br>Sin foto</div>`}
        <h1>${esc(e.n)}</h1><span class="muted">#${e.o} · ${esc(e.s)} · ${esc(e.no)} · ${esc(e.d)}</span>
        <div class="big">${eur(p)}</div>${e.cm ? `<span class="muted">${PRICE_LABEL()}</span>` : '<span class="muted">Sin precio: no está enlazada con Cardmarket</span>'}
        <a class="btn cmbtn" target="_blank" rel="noopener" href="${esc(cmUrl)}">Ver en Cardmarket ↗</a>
        ${e.note ? `<span class="muted" style="color:var(--down)">${esc(e.note)}</span>` : ''}
        <button class="btn ${has ? 'warn' : ''}" id="stog" style="width:100%;max-width:340px">${has ? 'Quitar de la colección' : '＋ La tengo'}</button></div></div>`;
    box.querySelector('.sheetx').onclick = () => box.remove();
    box.querySelector('#stog').onclick = () => { ordenToggle(name, e, vmap); paint(); redraw(); }; };
  box.onclick = ev => { if (ev.target === box) box.remove(); };
  paint(); document.body.appendChild(box);
  window.addEventListener('hashchange', () => box.remove(), { once: true });
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

function viewCard(cardId) {
  const c = q(`SELECT c.*, COALESCE(c.name_es,c.name_en,c.name_ja,c.name_local) name, s.region, s.card_count, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name FROM cards c JOIN sets s USING(set_id) WHERE card_id=?`, [cardId])[0];
  if (!c) { $view.innerHTML = '<p>Carta no encontrada.</p>'; return; }
  const vs = variantsOf([cardId])[cardId] || [];
  const e = COL.cards[cardId];
  const order = q(`SELECT card_id FROM cards WHERE set_id=? ORDER BY CAST(local_id AS INTEGER), local_id`, [c.set_id]).map(r => r.card_id);
  const idx = order.indexOf(cardId), albumPos = idx >= 0 ? `Álbum del set: página ${Math.floor(idx / 9) + 1}, bolsillo ${idx % 9 + 1}` : '';
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
    $view.innerHTML = `<div class="stack">
      <div class="row"><a href="#/set/${encodeURIComponent(c.set_id)}" class="pill" style="display:flex;align-items:center">←</a><span class="muted">${esc(c.set_name)} · ${esc(c.local_id)}${c.card_count ? '/' + c.card_count : ''} · ${esc(c.rarity || '')}</span></div>
      <div class="cardhero">${cardImg(c, 'high', 'hero', c.name)}
        <h1>${esc(c.name)}</h1>${c.name_ja && c.name_ja !== c.name ? `<span class="muted">${esc(c.name_ja)}</span>` : ''}${c.name_en && c.name_en !== c.name ? `<span class="muted">${esc(c.name_en)}</span>` : ''}
        <div class="big">${eur(p)}</div><span class="muted">${PRICE_LABEL()}${hol ? ' (reverse holo)' : ''}${PRICE_MODE === 'low' ? ' · cualquier idioma y estado' : ''}</span>
        ${sel && sel.ambiguous ? '<span class="down" style="font-size:13px">Ojo: este precio podría corresponder a otra versión de la carta.</span>' : ''}
        ${sel ? `<a class="btn cmbtn" target="_blank" rel="noopener" href="${cmLink(sel, c)}">Ver en Cardmarket ↗</a>` : ''}
        ${vs.length > 1 ? `<label class="f" style="width:100%;max-width:340px;text-align:left">Versión<select id="vsel">${vs.map((v, i) => `<option value="${i}" ${v === sel ? 'selected' : ''}>${esc(vLabel(v))} — ${eur(vPrice(v))}</option>`).join('')}</select></label>` : `<span class="muted">${sel ? esc(vLabel(sel)) : 'Sin precio en Cardmarket'}</span>`}
        ${c.illustrator ? `<a href="#/illustrator/${encodeURIComponent(c.illustrator)}" style="font-size:14px">Ilustración: ${esc(c.illustrator)} →</a>` : ''}${albumPos ? `<span class="muted">${albumPos}</span>` : ''}
        <div class="row" style="flex-wrap:wrap;gap:6px;justify-content:center"><label class="pill" style="display:flex;align-items:center;cursor:pointer;font-size:13px">${CUSTOM_IMG[cardId] ? 'Cambiar foto' : 'Poner mi foto'}<input type="file" id="cimg" accept="image/*" hidden></label>
          <button class="pill" id="curl" style="font-size:13px">Enlace</button>${CUSTOM_IMG[cardId] ? '<button class="pill" id="cdel" style="font-size:13px">Quitar</button>' : ''}</div></div>
      ${sel ? `<div class="card"><table><tr><th>Cardmarket</th><th>Mínimo</th><th>Tendencia</th><th>Media 7 d</th><th>Media 30 d</th></tr>
        <tr><td>${hol ? 'Reverse holo' : 'Precio'}</td><td>${eur(hol ? sel.low_holo : sel.low)}</td><td>${eur(hol ? sel.trend_holo : sel.trend)}</td><td>${eur(hol ? sel.avg7_holo : sel.avg7)}</td><td>${eur(hol ? sel.avg30_holo : sel.avg30)}</td></tr></table>
        <span class="muted" style="font-size:12px;display:block;margin-top:8px">El botón de Cardmarket abre esta carta dentro de su set; si hay varias versiones, elige la de la misma rareza.</span></div>` : ''}
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
    return Object.assign(a, { now, low, ratio, hit: !!a.target && now != null && now <= a.target, lowHit: !!a.target && low != null && low <= a.target, info: info[a.card] || {} });
  }).sort((x, y) => (x.ratio == null) - (y.ratio == null) || (x.ratio ?? 0) - (y.ratio ?? 0) || (x.now ?? 1e9) - (y.now ?? 1e9));
}
function viewWishlist() {
  const list = alertStatus();
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
        <a href="#/card/${encodeURIComponent(a.card)}" style="display:flex;gap:12px;align-items:center;flex:1;color:var(--tx)">${img(a.info.image_base, 'thumb', '', a.card)}<div class="col" style="flex:1"><b>${esc(a.info.name)} · ${esc(a.info.local_id)}</b><span class="muted">${esc(a.info.set_name)} · ${esc(vLabel(a.vr || { variant: a.variant }))}</span>
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
  q(`SELECT p.cm_product_id, p.name, p.category, pr.trend, pr.avg30, pr.avg7, pr.low, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name
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
  let cost = 0, val = 0;
  const rows = ids.map(id => { const e = COL.sealed[id], r = info[id] || {}, now = rPrice(r), qty = e.qty || 1;
    if (now != null) val += now * qty; if (e.buy != null && now != null) cost += e.buy * qty;
    const mom = r.avg30 && now != null ? (now - r.avg30) / r.avg30 * 100 : null;
    return { id, e, r, now, qty, mom }; }).sort((a, b) => (b.now || 0) * b.qty - (a.now || 0) * a.qty);
  const withBuy = rows.filter(x => x.e.buy != null && x.now != null);
  const gain = withBuy.reduce((t, x) => t + (x.now - x.e.buy) * x.qty, 0);
  $view.innerHTML = `<div class="stack"><div class="row"><a href="#/more" class="pill" style="display:flex;align-items:center">←</a><h1>Sellado</h1></div>
    <div class="card col" style="gap:6px"><span class="muted">Valor de tu sellado</span><div class="big">${eur(val)}</div>
      ${withBuy.length ? `<span class="${gain >= 0 ? 'up' : 'down'}" style="font-weight:600">${gain >= 0 ? '+' : '−'}${eur(Math.abs(gain))} sobre lo que pagaste (${pct(cost ? gain / cost * 100 : 0)})</span>` : '<span class="muted">Pon el precio de compra de cada producto para ver si se revaloriza.</span>'}</div>
    <label class="f">Añadir producto sellado<input type="search" id="sq2" placeholder="Busca: Pitch Black Elite Trainer Box, Booster Box…"></label><div class="list" id="sres"></div>
    <div class="list">${rows.map(x => { const g = x.e.buy != null && x.now != null ? (x.now - x.e.buy) * x.qty : null;
      const verdict = x.mom == null ? '' : x.mom > 5 ? '<span class="up">Subiendo (tendencia por encima de su media de 30 días)</span>' : x.mom < -5 ? '<span class="down">Bajando respecto a su media de 30 días</span>' : 'Estable';
      return `<div class="item" style="flex-wrap:wrap"><div class="col" style="flex:1;min-width:200px"><a href="#/sealeditem/${x.id}" style="color:var(--tx)"><b>${esc(x.r.name || ('Producto ' + x.id))}</b></a><span class="muted">${esc((x.r.category || '').replace('Pokémon ', ''))}${x.r.set_name ? ' · ' + esc(x.r.set_name) : ''}</span>
        <span style="font-size:13px">Hoy ${eur(x.now)}/ud${x.e.buy != null ? ` · pagaste ${eur(x.e.buy)}/ud` : ''}${g != null ? ` · <span class="${g >= 0 ? 'up' : 'down'}">${g >= 0 ? '+' : '−'}${eur(Math.abs(g))} (${pct((x.now - x.e.buy) / x.e.buy * 100)})</span>` : ''}</span>
        <span class="muted" style="font-size:12px">${verdict}${(hist[x.id] || []).length > 1 ? ' · ' + (hist[x.id].length) + ' días de historial' : ''}</span></div>
        <div class="row"><label class="f">Uds<input type="number" min="0" value="${x.qty}" data-sq="${x.id}" style="width:70px"></label><label class="f">€/ud pagado<input type="number" step="0.01" min="0" value="${x.e.buy ?? ''}" data-sb="${x.id}" style="width:100px"></label></div></div>`; }).join('') || '<p class="muted">No tienes producto sellado apuntado.</p>'}</div>
    <p class="muted">"Subiendo/Bajando" compara el precio de tendencia con su media de 30 días en Cardmarket. Es una pista, no una predicción.</p></div>`;
  $view.querySelectorAll('[data-sq]').forEach(i => i.onchange = () => { const k = parseInt(i.value, 10); if (!k) delete COL.sealed[i.dataset.sq]; else COL.sealed[i.dataset.sq].qty = k; saveCol(); viewSealed(); });
  $view.querySelectorAll('[data-sb]').forEach(i => i.onchange = () => { COL.sealed[i.dataset.sb].buy = parseNum(i.value); saveCol(); viewSealed(); });
  const sq = document.getElementById('sq2'); let t = null;
  sq.oninput = () => { clearTimeout(t); t = setTimeout(() => {
    const v = sq.value.trim(), box = document.getElementById('sres'); if (v.length < 2) { box.innerHTML = ''; return; }
    const rs = q(`SELECT p.cm_product_id, p.name, p.category, pr.trend FROM cm_products p LEFT JOIN prices pr USING(cm_product_id) WHERE p.kind='sealed' AND p.name LIKE ? ORDER BY p.cm_product_id DESC LIMIT 15`, ['%' + v + '%']);
    box.innerHTML = rs.map(r => `<div class="item"><div class="col" style="flex:1"><b>${esc(r.name)}</b><span class="muted">${esc(r.category.replace('Pokémon ', ''))}</span></div><b>${eur(r.trend)}</b><button class="pill" data-sadd="${r.cm_product_id}">＋</button></div>`).join('') || '<p class="muted">Sin resultados (los nombres de sellado están en inglés).</p>';
    box.querySelectorAll('[data-sadd]').forEach(b => b.onclick = () => { const id = b.dataset.sadd; if (COL.sealed[id]) COL.sealed[id].qty = (COL.sealed[id].qty || 1) + 1; else COL.sealed[id] = { qty: 1 }; saveCol(); viewSealed(); });
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

function viewMore() {
  const n = k => Object.keys(COL[k] || {}).length;
  $view.innerHTML = `<div class="stack"><h1>Más</h1><div class="list">
    <a class="item" href="#/expenses"><div class="col" style="flex:1"><b>Gastos</b><span class="muted">${COL.purchases.length} compras apuntadas · gasto por mes y valor actual</span></div>→</a>
    <a class="item" href="#/sealed"><div class="col" style="flex:1"><b>Sellado</b><span class="muted">${n('sealed')} producto${n('sealed') === 1 ? '' : 's'} · precio de compra frente a precio actual</span></div>→</a>
    <a class="item" href="#/sell"><div class="col" style="flex:1"><b>Lista de venta</b><span class="muted">${n('sell')} carta${n('sell') === 1 ? '' : 's'} · precio sugerido y exportar</span></div>→</a>
    <a class="item" href="#/illustrators"><div class="col" style="flex:1"><b>Ilustradores</b><span class="muted">${n('illustrators')} colecciones que sigues</span></div>→</a>
    <a class="item" href="#/settings"><div class="col" style="flex:1"><b>Ajustes</b><span class="muted">Base de datos, copias de seguridad</span></div>→</a></div></div>`;
}

let searchQ = '';
function viewSearch() {
  $view.innerHTML = `<div class="stack"><h1>Buscar</h1><input type="search" id="s" placeholder="Nombre de la carta (español, inglés o japonés)…" value="${esc(searchQ)}" autofocus><div class="list" id="res"></div></div>`;
  const inp = document.getElementById('s');
  let t = null;
  const run = () => {
    searchQ = inp.value.trim();
    if (searchQ.length < 2) { document.getElementById('res').innerHTML = '<p class="muted">Escribe al menos 2 letras.</p>'; return; }
    const like = '%' + searchQ + '%';
    const rows = q(`SELECT c.card_id, COALESCE(c.name_es,c.name_en,c.name_ja,c.name_local) name, c.local_id, c.rarity, c.image_base, s.region, s.release_date, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name
      FROM cards c JOIN sets s USING(set_id) WHERE c.name_es LIKE ? OR c.name_en LIKE ? OR c.name_ja LIKE ? ORDER BY s.release_date DESC LIMIT 80`, [like, like, like]);
    const vm = variantsOf(rows.map(r => r.card_id));
    document.getElementById('res').innerHTML = rows.map(r => `<a class="item" href="#/card/${encodeURIComponent(r.card_id)}">${img(r.image_base, 'thumb', '', r.card_id)}<div class="col" style="flex:1"><b>${esc(r.name)} ${COL.cards[r.card_id] ? '<span class="up">✓</span>' : ''}</b><span class="muted">${esc(r.set_name)} · ${esc(r.local_id)} · ${esc(r.rarity || '')}${r.region === 'asia' ? ' · JP' : ''}</span></div><b>${eur(cheapest(vm[r.card_id]))}</b></a>`).join('') || '<p class="muted">Sin resultados.</p>';
  };
  inp.oninput = () => { clearTimeout(t); t = setTimeout(run, 200); };
  if (searchQ) run();
}

function viewSettings() {
  const days = HAS_HISTORY ? q('SELECT COUNT(DISTINCT day) n FROM history')[0].n : 0;
  $view.innerHTML = `<div class="stack"><div class="row"><a href="#/more" class="pill" style="display:flex;align-items:center">←</a><h1>Ajustes</h1></div>
    ${syncCard()}
    <div class="card col" style="gap:10px" id="pushcard"></div>
    <div class="card col" style="gap:10px"><b>Base de datos</b><span class="muted">Precios del ${PRICE_DATE.split('-').reverse().join('/')} · ${days} día${days === 1 ? '' : 's'} de historial</span>
      <span class="muted">${ONLINE ? 'Se actualiza sola cada vez que abres la app y hay precios nuevos.' : 'Para actualizar: descarga <b>9bolsillos.db</b> de tu repositorio de GitHub (Releases → datos) y cárgala aquí.'}</span>
      <label class="btn sec" style="display:flex;align-items:center;justify-content:center;cursor:pointer">Cargar base de datos nueva<input type="file" id="dbf" accept=".db" hidden></label></div>
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
  for (const k of ['cards', 'sealed', 'alerts', 'illustrators', 'sell', 'hide', 'extra']) out[k] = Object.assign({}, a[k] || {}, b[k] || {});
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
  const tab = { '': 'home', sets: 'sets', set: 'sets', card: 'sets', illustrators: 'more', illustrator: 'sets', search: 'search', alerts: 'wish', wish: 'wish', settings: 'more', more: 'more', expenses: 'more', sealed: 'more', sealeditem: 'sets', sell: 'more' }[a || ''] || 'home';
  $tabs.querySelectorAll('a').forEach(x => x.classList.toggle('on', x.dataset.t === tab));
  window.scrollTo(0, 0);
  try {
    if (!a) viewHome();
    else if (a === 'sets') viewSets();
    else if (a === 'set') viewSet(b);
    else if (a === 'illustrators') viewIllustrators();
    else if (a === 'illustrator') viewIllustrator(b);
    else if (a === 'card') viewCard(b);
    else if (a === 'search') viewSearch();
    else if (a === 'alerts' || a === 'wish') viewWishlist();
    else if (a === 'expenses') viewExpenses();
    else if (a === 'sealed') viewSealed();
    else if (a === 'sealeditem') viewSealedItem(b);
    else if (a === 'sell') viewSell();
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
