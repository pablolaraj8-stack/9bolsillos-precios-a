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
function setLogo(base, cls, style = '') {
  if (!base) return `<div class="${cls}" style="${style}"></div>`;
  const dir = base.replace(/\/[^/]+$/, '');
  const urls = dir.includes('/en/') ? [dir.replace('/en/', '/es/') + '/logo.webp', dir + '/logo.webp'] : [dir + '/logo.webp', ''];
  return `<img class="${cls}" style="${style}" loading="lazy" alt="" src="${esc(urls[0])}" data-fb="${esc(urls[1])}" onerror="${IMG_ERR}">`;
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
  try { const c = JSON.parse(localStorage.getItem(STORE_KEY)); if (c && c.cards) return Object.assign({ sealed: {}, alerts: {}, illustrators: {}, purchases: [], sell: {} }, c); } catch (e) {}
  return { cards: {}, sealed: {}, alerts: {}, illustrators: {}, purchases: [], sell: {} };
}
let COL = loadCol();
function saveCol() { localStorage.setItem(STORE_KEY, JSON.stringify(COL)); }

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
  if (!db.exec("SELECT 1 FROM pragma_table_info('cards') WHERE name='illustrator'").length) throw new Error('Base de datos antigua: carga la versión nueva (con ilustradores)');
}

/* ---------- precios ---------- */
// Precio de referencia de una variante: reverse usa el precio holo de Cardmarket
function vPrice(v) {
  if (!v) return null;
  if (v.variant === 'reverse') return v.trend_holo ?? v.avg30_holo ?? v.low_holo ?? null;
  return v.trend ?? v.avg30 ?? v.low ?? null;
}
const VSQL = `SELECT v.card_id, v.cm_product_id, v.variant, v.subtype, v.stamp, v.ambiguous,
  p.low, p.trend, p.avg, p.avg1, p.avg7, p.avg30, p.low_holo, p.trend_holo, p.avg7_holo, p.avg30_holo
  FROM card_variants v LEFT JOIN prices p ON p.cm_product_id = v.cm_product_id`;
function variantsOf(cardIds) {
  if (!cardIds.length) return {};
  const out = {};
  for (let i = 0; i < cardIds.length; i += 400) {
    const part = cardIds.slice(i, i + 400);
    q(`${VSQL} WHERE v.card_id IN (${part.map(() => '?').join(',')})`, part).forEach(v => (out[v.card_id] ||= []).push(v));
  }
  return out;
}
const vLabel = v => [v.variant === 'normal' ? 'Normal' : v.variant === 'reverse' ? 'Reverse holo' : v.variant === 'holo' ? 'Holo' : v.variant || 'Estándar',
  v.subtype, v.stamp].filter(Boolean).join(' · ');
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
let homePeriod = 30;
function viewHome() {
  const ids = Object.keys(COL.cards);
  const vmap = variantsOf(ids);
  let total = 0, n = 0, intV = 0, jpV = 0, cost = 0, costVal = 0;
  const owned = [];
  const regions = {};
  if (ids.length) q(`SELECT c.card_id, CASE WHEN s.lang='es' THEN 'int' ELSE 'asia' END region FROM cards c JOIN sets s USING(set_id) WHERE c.card_id IN (${ids.map(() => '?').join(',')})`, ids).forEach(r => regions[r.card_id] = r.region);
  ids.forEach(id => {
    const e = COL.cards[id], v = ownedVariant(id, vmap[id]), p = vPrice(v), qty = e.qty || 1;
    if (p != null) { total += p * qty; regions[id] === 'asia' ? jpV += p * qty : intV += p * qty; }
    if (e.buy && p != null) { cost += e.buy * qty; costVal += p * qty; }
    n += qty; owned.push({ id, v, p, qty, e });
  });
  const sealedIds = Object.keys(COL.sealed).map(Number);
  let sealedV = 0;
  if (sealedIds.length) q(`SELECT cm_product_id, trend, avg30, low FROM prices WHERE cm_product_id IN (${sealedIds.map(() => '?').join(',')})`, sealedIds)
    .forEach(r => { const p = r.trend ?? r.avg30 ?? r.low; if (p != null) sealedV += p * (COL.sealed[r.cm_product_id].qty || 1); });
  total += sealedV;

  // historial del portfolio
  const hist = historyFor([...new Set(owned.filter(o => o.v).map(o => o.v.cm_product_id).concat(sealedIds))]);
  const byDay = {};
  const want = {}; owned.forEach(o => { if (o.v) (want[o.v.cm_product_id] ||= []).push(o); });
  hist.forEach(h => {
    let s = 0;
    (want[h.cm_product_id] || []).forEach(o => { const c = o.v.variant === 'reverse' ? h.trend_holo_c : h.trend_c; if (c != null) s += c / 100 * o.qty; });
    if (COL.sealed[h.cm_product_id] && h.trend_c != null) s += h.trend_c / 100 * (COL.sealed[h.cm_product_id].qty || 1);
    byDay[h.day] = (byDay[h.day] || 0) + s;
  });
  let days = Object.keys(byDay).map(Number).sort();
  if (homePeriod) { const last = days[days.length - 1]; if (last) { const d = new Date(String(last).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')); d.setDate(d.getDate() - homePeriod); const lim = +d.toISOString().slice(0, 10).replace(/-/g, ''); days = days.filter(x => x >= lim); } }
  const pts = days.map(d => [d, byDay[d]]);
  let change = '';
  if (pts.length >= 2) { const a = pts[0][1], b = pts[pts.length - 1][1], d = b - a; change = `<div class="${d >= 0 ? 'up' : 'down'}" style="font-weight:600">${d >= 0 ? '+' : '−'}${eur(Math.abs(d))} (${pct(a ? d / a * 100 : 0)}) desde el ${dayToStr(pts[0][0])}</div>`; }
  else if (cost) { const d = costVal - cost; change = `<div class="${d >= 0 ? 'up' : 'down'}" style="font-weight:600">${d >= 0 ? '+' : '−'}${eur(Math.abs(d))} (${pct(d / cost * 100)}) en las cartas con precio de compra</div>`; }

  // mayores subidas: precio actual vs media de 30 días (hasta tener historial)
  const movers = owned.filter(o => o.v && o.p != null).map(o => {
    const base = o.v.variant === 'reverse' ? o.v.avg30_holo : o.v.avg30;
    return Object.assign(o, { ch: base ? (o.p - base) / base * 100 : null });
  }).filter(o => o.ch != null && o.p >= 1).sort((a, b) => b.ch - a.ch).slice(0, 5);
  const names = {};
  if (movers.length) q(`SELECT c.card_id, COALESCE(c.name_es,c.name_en,c.name_ja,c.name_local) name, c.local_id, c.image_base, COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name FROM cards c JOIN sets s USING(set_id) WHERE c.card_id IN (${movers.map(() => '?').join(',')})`, movers.map(m => m.id)).forEach(r => names[r.card_id] = r);

  const alertsHit = alertStatus().filter(a => a.hit).length;
  const periods = [[7, '1S'], [30, '1M'], [90, '3M'], [365, '1A'], [0, 'Todo']];
  $view.innerHTML = `<div class="stack">
    <div class="between"><h1>9Bolsillos</h1><a class="pill" style="display:flex;align-items:center" href="#/settings">Ajustes</a></div>
    ${alertsHit ? `<a class="alertbox" href="#/wish" style="color:var(--tx)"><b class="up">${alertsHit} alerta${alertsHit > 1 ? 's' : ''} de precio</b> ${alertsHit > 1 ? 'han saltado' : 'ha saltado'}. Ver →</a>` : ''}
    <div class="col"><span class="muted">Valor de tu colección · precios del ${PRICE_DATE.split('-').reverse().join('/')}</span>
      <div class="big">${eur(total)}</div>${change}
      <span class="muted">${n} carta${n === 1 ? '' : 's'}${sealedIds.length ? ` · ${sealedIds.length} producto${sealedIds.length > 1 ? 's' : ''} sellado${sealedIds.length > 1 ? 's' : ''}` : ''}${cost ? ` · pagaste ${eur(cost)} por las que tienen precio de compra` : ''}</span></div>
    <div class="col" style="gap:10px">${chartSvg(pts)}
      <div class="pills">${periods.map(([d, l]) => `<button class="pill ${homePeriod === d ? 'on' : ''}" data-p="${d}">${l}</button>`).join('')}</div></div>
    ${total ? `<div class="card col" style="gap:10px"><b>Reparto</b>
      <div class="bar" style="display:flex;gap:2px;background:none">${[[intV, 'var(--up)'], [jpV, 'var(--down)'], [sealedV, 'var(--blue)']].filter(x => x[0] > 0).map(x => `<div style="width:${x[0] / total * 100}%;background:${x[1]};border-radius:3px"></div>`).join('')}</div>
      <div class="row muted" style="gap:18px;flex-wrap:wrap"><span>Español/inglés <b style="color:var(--tx)">${eur(intV)}</b></span><span>Japonés y otros <b style="color:var(--tx)">${eur(jpV)}</b></span><span>Sellado <b style="color:var(--tx)">${eur(sealedV)}</b></span></div></div>` : ''}
    ${movers.length ? `<div class="col"><h2>Mayores subidas <span class="muted">(vs media 30 días)</span></h2><div class="list">${movers.map(m => {
      const r = names[m.id] || {}; return `<a class="item" href="#/card/${encodeURIComponent(m.id)}">${img(r.image_base, 'thumb', '', m.id)}<div class="col" style="flex:1"><b>${esc(r.name)} · ${esc(r.local_id)}</b><span class="muted">${esc(r.set_name)}</span></div><div class="col" style="align-items:flex-end"><b>${eur(m.p)}</b><span class="${m.ch >= 0 ? 'up' : 'down'}" style="font-size:13px">${pct(m.ch)}</span></div></a>`;
    }).join('')}</div></div>` : ''}
    ${!ids.length && !sealedIds.length ? `<div class="card col" style="gap:10px"><b>Empieza tu colección</b><span class="muted">Entra en Colección, abre un set y toca el botón ＋ de cada carta que tengas.</span><a class="btn" style="display:flex;align-items:center;justify-content:center" href="#/sets">Ver sets</a></div>` : ''}
  </div>`;
  $view.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { homePeriod = +b.dataset.p; viewHome(); });
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
      return `<a class="item" href="#/set/${encodeURIComponent(r.set_id)}"><div class="logobox">${setLogo(r.ib, 'setlogo')}</div><div class="col" style="flex:1"><b>${esc(r.name)}</b><span class="muted">${esc(r.serie)} · ${r.release_date ? esc(r.release_date.slice(0, 4)) : ''} · ${r.n} cartas${setsFilter === 'otros' || setsFilter === 'mine' ? ' · ' + esc(LANGS[r.lang] || r.lang) : ''}</span>
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
const albumPage = {};
function cardBrowser(key, cards0, vmap, el, headEl, opts = {}) {
  const kind = opts.kind || 'set', mode = SORT[kind];
  const pr = c => { const p = COL.cards[c.card_id] ? vPrice(ownedVariant(c.card_id, vmap[c.card_id])) : cheapest(vmap[c.card_id]); return p ?? -1; };
  const num = c => [parseInt(c.local_id, 10) || 0, c.local_id || ''];
  const byRel = (a, b) => (a.release_date || '').localeCompare(b.release_date || '') || (a.set_id || '').localeCompare(b.set_id || '') || num(a)[0] - num(b)[0];
  const cards = cards0.slice().sort(mode === 'new' ? (a, b) => byRel(b, a) : mode === 'old' ? byRel : mode === 'price_desc' ? (a, b) => pr(b) - pr(a) : mode === 'price_asc' ? (a, b) => (pr(a) < 0) - (pr(b) < 0) || pr(a) - pr(b) : mode === 'name' ? (a, b) => (a.name || '').localeCompare(b.name || '', 'es') : (a, b) => num(a)[0] - num(b)[0] || num(a)[1].localeCompare(num(b)[1]));
  const perSpread = () => window.innerWidth >= 760 ? 2 : 1;
  const draw = () => {
    let have = 0, missCost = 0, val = 0;
    cards.forEach(c => { if (COL.cards[c.card_id]) { have++; val += (vPrice(ownedVariant(c.card_id, vmap[c.card_id])) || 0) * (COL.cards[c.card_id].qty || 1); } else missCost += cheapest(vmap[c.card_id]) || 0; });
    const p = cards.length ? have / cards.length * 100 : 0;
    headEl.innerHTML = `<div class="between"><b>Tienes ${have} de ${cards.length}</b><b class="up" style="font-size:22px">${Math.round(p)} %</b></div>
      <div class="bar"><div style="width:${p}%"></div></div>
      <div class="between muted" style="flex-wrap:wrap"><span>Tu parte vale <b style="color:var(--tx)">${eur(val)}</b></span><span>Completarlo hoy: <b style="color:var(--tx)">${eur(missCost)}</b></span></div>`;
    const tile = (c, pocket) => {
      const has = !!COL.cards[c.card_id], pr = has ? vPrice(ownedVariant(c.card_id, vmap[c.card_id])) : cheapest(vmap[c.card_id]);
      return `<div class="tile ${has ? 'has' : 'miss'}" data-open="${esc(c.card_id)}" title="${pocket ? esc(pocket) : ''}">
        <div class="img"><span class="fbn" ${c.image_base || CUSTOM_IMG[c.card_id] ? 'style="display:none"' : ''}>${esc(c.name)}</span>${cardImg(c, 'low', '', '')}
          <button class="own" data-own="${esc(c.card_id)}" aria-label="${has ? 'Quitar de' : 'Añadir a'} mi colección: ${esc(c.name)}">${has ? '✓' : '＋'}</button></div>
        <span class="num">${esc(opts.sub ? opts.sub(c) : c.local_id)}</span>
        <span class="nm">${esc(c.name)}</span><span class="pr">${eur(pr)}</span></div>`;
    };
    if (browseMode === 'album') {
      // El álbum siempre muestra todas las cartas en su bolsillo: las que faltan quedan en gris
      const pages = Math.max(1, Math.ceil(cards.length / 9)), per = perSpread();
      let pg = albumPage[key] || 0; pg = Math.min(pg - pg % per, (pages - 1) - (pages - 1) % per); albumPage[key] = pg;
      let html = `<div class="between" style="margin-bottom:10px"><button class="pill" data-pg="-1" ${pg === 0 ? 'disabled' : ''} aria-label="Página anterior">←</button>
        <b>Página ${pg + 1}${per === 2 && pg + 2 <= pages ? '–' + (pg + 2) : ''} de ${pages}</b>
        <button class="pill" data-pg="1" ${pg + per >= pages ? 'disabled' : ''} aria-label="Página siguiente">→</button></div><div class="spread">`;
      for (let k = pg; k < Math.min(pg + per, pages); k++) {
        html += `<div class="page"><div class="pgnum">Página ${k + 1}</div><div class="pockets">`;
        for (let i = 0; i < 9; i++) {
          const c = cards[k * 9 + i];
          html += c ? tile(c, `Página ${k + 1}, bolsillo ${i + 1}`) : '<div class="tile empty"><div class="img"></div></div>';
        }
        html += '</div></div>';
      }
      el.innerHTML = html + '</div>';
      el.querySelectorAll('[data-pg]').forEach(b => b.onclick = () => { albumPage[key] = Math.max(0, (albumPage[key] || 0) + (+b.dataset.pg) * per); draw(); });
    } else {
      const list = cards.filter(c => browseFilter === 'all' || (browseFilter === 'have' ? COL.cards[c.card_id] : !COL.cards[c.card_id]));
      el.innerHTML = `<div class="grid">${list.map(c => tile(c)).join('')}</div>` + (list.length ? '' : '<p class="muted">Nada que mostrar con este filtro.</p>');
    }
    el.querySelectorAll('[data-own]').forEach(b => b.onclick = ev => {
      ev.stopPropagation(); const id = b.dataset.own;
      if (COL.cards[id]) delete COL.cards[id];
      else { const c = cards.find(x => x.card_id === id), v = (vmap[id] || []).slice().sort((a, b) => (vPrice(a) ?? 1e9) - (vPrice(b) ?? 1e9))[0]; COL.cards[id] = { set: c.set_id, cm: v ? v.cm_product_id : null, variant: v ? v.variant : null, qty: 1 }; }
      saveCol(); draw();
    });
    el.querySelectorAll('[data-open]').forEach(t => t.onclick = () => location.hash = '#/card/' + encodeURIComponent(t.dataset.open));
  };
  return draw;
}
function browserControls(kind = 'set') {
  return `<div class="between" style="flex-wrap:wrap;gap:8px">
    <label class="row muted" style="gap:8px;font-size:13px">Ordenar<select data-sort="${kind}">${SORTS[kind].map(([k, l]) => `<option value="${k}" ${SORT[kind] === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <div class="pills">${[['grid', 'Cuadrícula'], ['album', 'Álbum']].map(([k, l]) => `<button class="pill ${browseMode === k ? 'on' : ''}" data-bm="${k}">${l}</button>`).join('')}</div>
    ${browseMode === 'grid' ? `<div class="pills">${[['all', 'Todas'], ['have', 'Tengo'], ['miss', 'Me faltan']].map(([k, l]) => `<button class="pill ${browseFilter === k ? 'on' : ''}" data-sf="${k}">${l}</button>`).join('')}</div>` : ''}</div>`;
}
function wireControls(rerender) {
  $view.querySelectorAll('[data-bm]').forEach(b => b.onclick = () => { browseMode = b.dataset.bm; rerender(); });
  $view.querySelectorAll('[data-sf]').forEach(b => b.onclick = () => { browseFilter = b.dataset.sf; rerender(); });
  $view.querySelectorAll('[data-sort]').forEach(s => s.onchange = () => { SORT[s.dataset.sort] = s.value; rerender(); });
}

function viewSet(setId) {
  const s = q(`SELECT set_id, lang, COALESCE(name_es,name_en,name_ja,name_local) name, serie, release_date, card_count, cm_expansion_id FROM sets WHERE set_id=?`, [setId])[0];
  if (!s) { $view.innerHTML = '<p>Set no encontrado.</p>'; return; }
  const cards = q(`SELECT c.card_id, c.set_id, c.local_id, ${NAME} name, c.rarity, c.image_base FROM cards c WHERE c.set_id=?
    ORDER BY CAST(c.local_id AS INTEGER), c.local_id`, [setId]);
  const ib = (cards.find(c => c.image_base) || {}).image_base;
  const vmap = variantsOf(cards.map(c => c.card_id));
  const sealed = s.cm_expansion_id ? q(`SELECT p.cm_product_id, p.name, p.category, pr.trend, pr.avg30, pr.low FROM cm_products p LEFT JOIN prices pr USING(cm_product_id)
    WHERE p.kind='sealed' AND p.cm_expansion_id=? ORDER BY pr.trend DESC`, [s.cm_expansion_id]) : [];
  $view.innerHTML = `<div class="stack">
    <div class="row"><a href="#/sets" class="pill" style="display:flex;align-items:center">←</a></div>
    <div class="sethero">${setLogo(ib, 'biglogo')}<div class="col" style="align-items:center;text-align:center"><h1>${esc(s.name)}</h1><span class="muted">${esc(s.serie)} · ${esc(s.release_date || '')} · ${esc(LANGS[s.lang] || s.lang)}</span></div></div>
    <div class="card col" style="gap:8px" id="sethead"></div>
    ${browserControls()}
    <div id="grid"></div>
    ${sealed.length ? `<div class="col"><h2>Producto sellado</h2><div class="list">${sealed.map(x => `<div class="item"><div class="col" style="flex:1"><b>${esc(x.name)}</b><span class="muted">${esc(x.category.replace('Pokémon ', ''))}</span></div>
      <b>${eur(x.trend ?? x.avg30 ?? x.low)}</b><button class="pill ${COL.sealed[x.cm_product_id] ? 'on' : ''}" data-sealed="${x.cm_product_id}">${COL.sealed[x.cm_product_id] ? '✓ Tengo ' + (COL.sealed[x.cm_product_id].qty || 1) : '＋'}</button></div>`).join('')}</div></div>` : ''}
    <p class="muted">Precios: tendencia de Cardmarket${s.lang === 'es' ? ' (español e inglés juntos)' : ''}.</p></div>`;
  wireControls(() => viewSet(setId));
  $view.querySelectorAll('[data-sealed]').forEach(b => b.onclick = () => {
    const id = b.dataset.sealed, cur = COL.sealed[id];
    if (!cur) COL.sealed[id] = { qty: 1, set: setId };
    else { const n = prompt('¿Cuántas unidades tienes? (0 para quitarlo)', cur.qty || 1); if (n === null) return; const k = parseInt(n, 10); if (!k) delete COL.sealed[id]; else cur.qty = k; }
    saveCol(); viewSet(setId);
  });
  cardBrowser('set:' + setId, cards, vmap, document.getElementById('grid'), document.getElementById('sethead'),
    { kind: 'set', sub: c => `${c.local_id}${s.card_count ? '/' + s.card_count : ''} · ${c.rarity || ''}` })();
}

/* ---------- ilustradores ---------- */
let illLang = 'ja', illQuery = '';
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
  const cards = q(`SELECT c.card_id, c.set_id, c.local_id, ${NAME} name, c.rarity, c.image_base, s.lang, s.release_date,
    COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local) set_name FROM cards c JOIN sets s USING(set_id)
    WHERE c.illustrator = ? COLLATE NOCASE AND ${langCond(illLang)} ORDER BY s.release_date, s.set_id, CAST(c.local_id AS INTEGER)`, [name]);
  const vmap = variantsOf(cards.map(c => c.card_id));
  const fav = !!COL.illustrators[name];
  $view.innerHTML = `<div class="stack">
    <div class="row"><a href="#/illustrators" class="pill" style="display:flex;align-items:center">←</a><div class="col" style="flex:1"><h1>${esc(name)}</h1><span class="muted">Ilustrador · ${cards.length} cartas</span></div>
      <button class="pill ${fav ? 'on' : ''}" id="fav">${fav ? '★ Siguiendo' : '☆ Seguir'}</button></div>
    <div class="pills">${[['ja', 'Japonés'], ['es', 'Español / inglés'], ['all', 'Todos los idiomas']].map(([k, l]) => `<button class="pill ${illLang === k ? 'on' : ''}" data-il="${k}">${l}</button>`).join('')}</div>
    <div class="card col" style="gap:8px" id="ihead"></div>
    ${browserControls('ill')}
    <div id="grid"></div>
    <p class="muted">Ordenadas por fecha de salida del set. Precios: tendencia de Cardmarket.${illLang === 'ja' ? ' En japonés la lista está incompleta: a la base de datos le faltan muchos sets antiguos (DP, BW, XY…) y el ilustrador de algunas cartas.' : ''}</p></div>`;
  document.getElementById('fav').onclick = () => { if (fav) delete COL.illustrators[name]; else COL.illustrators[name] = { since: PRICE_DATE }; saveCol(); viewIllustrator(name); };
  $view.querySelectorAll('[data-il]').forEach(b => b.onclick = () => { illLang = b.dataset.il; viewIllustrator(name); });
  wireControls(() => viewIllustrator(name));
  cardBrowser('ill:' + name + ':' + illLang, cards, vmap, document.getElementById('grid'), document.getElementById('ihead'),
    { kind: 'ill', sub: c => `${c.set_name} · ${c.local_id}${illLang === 'all' ? ' · ' + (c.lang === 'ja' ? 'JP' : c.lang.toUpperCase()) : ''}` })();
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
    const h = sel ? historyFor([sel.cm_product_id]).map(r => [r.day, (sel.variant === 'reverse' ? r.trend_holo_c : r.trend_c)]).filter(r => r[1] != null).map(r => [r[0], r[1] / 100]) : [];
    const p = vPrice(sel), hol = sel && sel.variant === 'reverse';
    const al = sel ? COL.alerts[sel.cm_product_id + '|' + (sel.variant || '')] : null;
    const sl = COL.sell[cardId];
    const profit = e && e.buy && p != null ? (p - e.buy) * (e.qty || 1) : null;
    $view.innerHTML = `<div class="stack">
      <div class="row"><a href="#/set/${encodeURIComponent(c.set_id)}" class="pill" style="display:flex;align-items:center">←</a><span class="muted">${esc(c.set_name)} · ${esc(c.local_id)}${c.card_count ? '/' + c.card_count : ''} · ${esc(c.rarity || '')}</span></div>
      <div class="row" style="align-items:flex-start;gap:16px;flex-wrap:wrap">
        <div class="col" style="gap:8px;align-items:flex-start">${cardImg(c, 'high', 'hero', c.name)}
          <div class="row" style="flex-wrap:wrap;gap:6px;max-width:180px"><label class="pill" style="display:flex;align-items:center;cursor:pointer;font-size:13px">${CUSTOM_IMG[cardId] ? 'Cambiar foto' : 'Poner mi foto'}<input type="file" id="cimg" accept="image/*" hidden></label>
          <button class="pill" id="curl" style="font-size:13px">Enlace</button>${CUSTOM_IMG[cardId] ? '<button class="pill" id="cdel" style="font-size:13px">Quitar</button>' : ''}</div></div>
        <div class="col" style="gap:8px;flex:1;min-width:200px">
          <h1>${esc(c.name)}</h1>${c.illustrator ? `<a href="#/illustrator/${encodeURIComponent(c.illustrator)}" style="font-size:14px">Ilustración: ${esc(c.illustrator)} →</a>` : ''}${albumPos ? `<span class="muted">${albumPos}</span>` : ''}${c.name_en && c.name_en !== c.name ? `<span class="muted">${esc(c.name_en)}</span>` : ''}${c.name_ja && c.name_ja !== c.name ? `<span class="muted">${esc(c.name_ja)}</span>` : ''}
          <div class="big">${eur(p)}</div><span class="muted">Tendencia en Cardmarket${hol ? ' (reverse holo)' : ''}</span>
          ${sel && sel.ambiguous ? '<span class="down" style="font-size:13px">Ojo: este precio podría corresponder a otra versión de la carta.</span>' : ''}
          ${vs.length > 1 ? `<label class="f">Versión<select id="vsel">${vs.map((v, i) => `<option value="${i}" ${v === sel ? 'selected' : ''}>${esc(vLabel(v))} — ${eur(vPrice(v))}</option>`).join('')}</select></label>` : `<span class="muted">${sel ? esc(vLabel(sel)) : 'Sin precio en Cardmarket'}</span>`}
        </div></div>
      ${sel ? `<div class="card"><table><tr><th>Cardmarket</th><th>Mínimo</th><th>Tendencia</th><th>Media 7 d</th><th>Media 30 d</th></tr>
        <tr><td>${hol ? 'Reverse holo' : 'Precio'}</td><td>${eur(hol ? sel.low_holo : sel.low)}</td><td>${eur(hol ? sel.trend_holo : sel.trend)}</td><td>${eur(hol ? sel.avg7_holo : sel.avg7)}</td><td>${eur(hol ? sel.avg30_holo : sel.avg30)}</td></tr></table>
        <a style="display:inline-block;margin-top:10px" target="_blank" rel="noopener" href="https://www.cardmarket.com/es/Pokemon/Products/Search?searchString=${encodeURIComponent(c.name_en || c.name)}">Buscar en Cardmarket ↗</a></div>` : ''}
      <div class="col" style="gap:8px"><h2>Evolución del precio</h2>${chartSvg(h, 700, 140)}</div>
      <div class="card col" style="gap:12px"><b>${e ? 'En tu colección' : 'No la tienes'}</b>
        ${e ? `<div class="row" style="flex-wrap:wrap"><label class="f">Cantidad<input type="number" id="qty" min="1" value="${e.qty || 1}" style="width:90px"></label>
          <label class="f">Precio de compra (€/ud)<input type="number" id="buy" step="0.01" min="0" value="${e.buy ?? ''}" style="width:150px"></label></div>
          ${profit != null ? `<span class="${profit >= 0 ? 'up' : 'down'}" style="font-weight:700">${profit >= 0 ? '+' : '−'}${eur(Math.abs(profit))} (${pct((p - e.buy) / e.buy * 100)})</span>` : ''}
          <div class="row"><button class="btn" id="save">Guardar</button><button class="btn warn" id="del">Quitar</button></div>`
        : `<button class="btn" id="add">＋ La tengo</button>`}</div>
      ${sel ? `<div class="card col" style="gap:12px"><b>${al ? '♥ En tu lista de deseos' : 'Lista de deseos'}</b>
        <label class="f" for="tg">Precio objetivo (opcional): te avisa si esta versión baja de</label>
        <div class="row" style="flex-wrap:wrap"><input type="number" id="tg" step="0.01" min="0" value="${al && al.target ? al.target : ''}" placeholder="${p != null ? (Math.floor(p * 0.9 * 100) / 100) : ''}" style="flex:1;min-width:120px">
        <button class="btn" id="setal">${al ? 'Guardar' : '♡ La quiero'}</button>${al ? '<button class="btn sec" id="delal">Quitar</button>' : ''}</div></div>` : ''}
      ${e ? `<div class="card col" style="gap:12px"><b>${sl ? 'A la venta' : 'Vender'}</b>
        ${sl ? `<span class="muted">Pides ${eur(sl.price)} · ${esc(sl.cond)} · ${esc(sl.lang)} · ${sl.qty} ud.</span><div class="row"><a class="btn sec" style="display:flex;align-items:center" href="#/sell">Ver lista de venta</a><button class="btn warn" id="unsell">Quitar de venta</button></div>`
        : `<span class="muted">Precio sugerido: ${eur(p)} (tendencia) · mínimo actual ${eur(hol ? sel && sel.low_holo : sel && sel.low)}</span><button class="btn sec" id="sell">Poner a la venta</button>`}</div>` : ''}
    </div>`;
    const ci = document.getElementById('cimg'); if (ci) ci.onchange = async ev => { const f = ev.target.files[0]; if (!f) return; try { const u = await resizeImage(f); CUSTOM_IMG[cardId] = u; await idbPut('img:' + cardId, u); toast('Imagen guardada'); draw(); } catch (e) { alert(e.message); } };
    const cu = document.getElementById('curl'); if (cu) cu.onclick = async () => { const u = prompt('Pega el enlace de una imagen de la carta (https://…)'); if (!u || !/^https:\/\//.test(u.trim())) return; CUSTOM_IMG[cardId] = u.trim(); await idbPut('img:' + cardId, u.trim()); draw(); };
    const cd = document.getElementById('cdel'); if (cd) cd.onclick = async () => { delete CUSTOM_IMG[cardId]; await idbDel('img:' + cardId); draw(); };
    const vsel = document.getElementById('vsel'); if (vsel) vsel.onchange = () => { sel = vs[+vsel.value]; if (COL.cards[cardId]) { COL.cards[cardId].cm = sel.cm_product_id; COL.cards[cardId].variant = sel.variant; saveCol(); } draw(); };
    const add = document.getElementById('add'); if (add) add.onclick = () => { COL.cards[cardId] = { set: c.set_id, cm: sel ? sel.cm_product_id : null, variant: sel ? sel.variant : null, qty: 1 }; saveCol(); viewCard(cardId); };
    const save = document.getElementById('save'); if (save) save.onclick = () => { const b = document.getElementById('buy').value; Object.assign(COL.cards[cardId], { qty: Math.max(1, parseInt(document.getElementById('qty').value, 10) || 1), buy: b === '' ? null : parseFloat(b) }); saveCol(); toast('Guardado'); viewCard(cardId); };
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
  return list.map(a => {
    const r = pr[a.cm] || {}, now = vPrice(Object.assign({ variant: a.variant }, r));
    const low = a.variant === 'reverse' ? r.low_holo : r.low;
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
        <a href="#/card/${encodeURIComponent(a.card)}" style="display:flex;gap:12px;align-items:center;flex:1;color:var(--tx)">${img(a.info.image_base, 'thumb', '', a.card)}<div class="col" style="flex:1"><b>${esc(a.info.name)} · ${esc(a.info.local_id)}</b><span class="muted">${esc(a.info.set_name)} · ${esc(vLabel({ variant: a.variant }))}</span>
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
    if (cur) cur.qty = (cur.qty || 1) + 1; else COL.cards[a.card] = { set: a.card.slice(0, a.card.lastIndexOf('-')), cm: a.cm, variant: a.variant, qty: 1, buy: price };
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
  if (pu.cm && sealed[pu.cm]) { const r = sealed[pu.cm]; const p = r.trend ?? r.avg30 ?? r.low; return p != null ? p * (pu.qty || 1) : null; }
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
      if (linkPick.card) { const cur = COL.cards[linkPick.card]; if (cur) cur.qty = (cur.qty || 1) + qty; else COL.cards[linkPick.card] = { set: linkPick.card.slice(0, linkPick.card.lastIndexOf('-')), cm: linkPick.cm, variant: linkPick.variant, qty, buy: unit }; }
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
  const rows = ids.map(id => { const e = COL.sealed[id], r = info[id] || {}, now = r.trend ?? r.avg30 ?? r.low ?? null, qty = e.qty || 1;
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
      return `<div class="item" style="flex-wrap:wrap"><div class="col" style="flex:1;min-width:200px"><b>${esc(x.r.name || ('Producto ' + x.id))}</b><span class="muted">${esc((x.r.category || '').replace('Pokémon ', ''))}${x.r.set_name ? ' · ' + esc(x.r.set_name) : ''}</span>
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
  const rows = ids.map(id => { const e = COL.sell[id], vs = vm[id] || [], v = vs.find(x => x.cm_product_id === e.cm && (x.variant || '') === (e.variant || '')) || vs[0], sug = vPrice(v), low = v ? (v.variant === 'reverse' ? v.low_holo : v.low) : null; return { id, e, v, sug, low, i: info[id] || {} }; });
  const total = rows.reduce((t, r) => t + (r.e.price || 0) * (r.e.qty || 1), 0), sugT = rows.reduce((t, r) => t + (r.sug || 0) * (r.e.qty || 1), 0);
  const COND = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'], CL = { MT: 'Mint', NM: 'Near Mint', EX: 'Excelente', GD: 'Bueno', LP: 'Ligeramente jugada', PL: 'Jugada', PO: 'Pobre' };
  const wtext = r => `${r.i.name} ${r.i.local_id}${r.i.card_count ? '/' + r.i.card_count : ''} ${r.i.set_name} - ${r.e.lang} ${r.e.cond}\n\nCarta Pokémon TCG ${r.i.name} (${r.i.set_name}, ${r.i.local_id}${r.i.card_count ? '/' + r.i.card_count : ''}${r.i.rarity ? ', ' + r.i.rarity : ''}${r.v && r.v.variant === 'reverse' ? ', reverse holo' : ''}).\nIdioma: ${r.e.lang}. Estado: ${CL[r.e.cond] || r.e.cond}.\nSale de funda directamente. Envío protegido con top loader.\nPrecio: ${eur(r.e.price)}${r.e.qty > 1 ? ' por unidad (' + r.e.qty + ' disponibles)' : ''}.`;
  $view.innerHTML = `<div class="stack"><div class="row"><a href="#/more" class="pill" style="display:flex;align-items:center">←</a><h1>Lista de venta</h1></div>
    <div class="card col" style="gap:6px"><span class="muted">${rows.length} carta${rows.length === 1 ? '' : 's'} a la venta · lo que pides</span><div class="big">${eur(total)}</div><span class="muted">Según la tendencia de Cardmarket valdrían ${eur(sugT)}</span>
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
    if (c) { c.qty = (c.qty || 1) - (e.qty || 1); if (c.qty <= 0) delete COL.cards[id]; }
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
    <div class="card col" style="gap:10px"><b>Base de datos</b><span class="muted">Precios del ${PRICE_DATE.split('-').reverse().join('/')} · ${days} día${days === 1 ? '' : 's'} de historial</span>
      <span class="muted">${ONLINE ? 'Se actualiza sola cada vez que abres la app y hay precios nuevos.' : 'Para actualizar: descarga <b>9bolsillos.db</b> de tu repositorio de GitHub (Releases → datos) y cárgala aquí.'}</span>
      <label class="btn sec" style="display:flex;align-items:center;justify-content:center;cursor:pointer">Cargar base de datos nueva<input type="file" id="dbf" accept=".db" hidden></label></div>
    <div class="card col" style="gap:10px"><b>Tu colección</b><span class="muted">${Object.keys(COL.cards).length} cartas, ${Object.keys(COL.sealed).length} sellados, ${Object.keys(COL.alerts).length} deseos, ${COL.purchases.length} compras y ${Object.keys(COL.sell).length} a la venta. Se guardan solo en este navegador: haz copias de vez en cuando.</span>
      <div class="row" style="flex-wrap:wrap"><button class="btn sec" id="exp">Exportar copia</button>
      <label class="btn sec" style="display:flex;align-items:center;cursor:pointer">Importar copia<input type="file" id="imp" accept=".json" hidden></label></div></div>
    <div class="card col" style="gap:10px"><b>Datos</b><span class="muted">Cartas y sets: TCGdex (licencia MIT). Precios: guía pública de Cardmarket. Imágenes: TCGdex. 9Bolsillos no está afiliado a Pokémon, Cardmarket ni TCGdex.</span></div>
  </div>`;
  document.getElementById('dbf').onchange = async ev => { const f = ev.target.files[0]; if (!f) return; try { const b = await f.arrayBuffer(); openDb(b); await idbPut('db', b); await idbPut('db_date', PRICE_DATE); toast('Base de datos actualizada'); viewSettings(); } catch (e) { alert('No se pudo cargar: ' + e.message); } };
  document.getElementById('exp').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(Object.assign({}, COL, { images: CUSTOM_IMG }), null, 1)], { type: 'application/json' })); a.download = `9bolsillos-coleccion-${new Date().toISOString().slice(0, 10)}.json`; a.click(); };
  document.getElementById('imp').onchange = async ev => { const f = ev.target.files[0]; if (!f) return; try { const c = JSON.parse(await f.text()); if (!c.cards) throw new Error('formato'); if (!confirm('Esto sustituye tu colección actual por la de la copia. ¿Seguir?')) return; const imgs = c.images || {}; delete c.images; COL = Object.assign({ sealed: {}, alerts: {}, illustrators: {}, purchases: [], sell: {} }, c); saveCol(); for (const [k, v] of Object.entries(imgs)) { CUSTOM_IMG[k] = v; await idbPut('img:' + k, v); } toast('Colección importada'); viewSettings(); } catch (e) { alert('Archivo no válido'); } };
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

/* ---------- router ---------- */
function route() {
  if (!DB) return;
  const h = decodeURIComponent(location.hash.slice(1) || '/');
  const [, a, b] = h.split('/');
  const tab = { '': 'home', sets: 'sets', set: 'sets', card: 'sets', illustrators: 'more', illustrator: 'sets', search: 'search', alerts: 'wish', wish: 'wish', settings: 'more', more: 'more', expenses: 'more', sealed: 'more', sell: 'more' }[a || ''] || 'home';
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
    else if (a === 'sell') viewSell();
    else if (a === 'more') viewMore();
    else if (a === 'settings') viewSettings();
    else viewHome();
  } catch (e) { console.error(e); $view.innerHTML = `<p class="down">Error: ${esc(e.message)}</p>`; }
}
function start() { $tabs.hidden = false; route(); }
window.addEventListener('hashchange', route);

// Descarga automática cuando la app está publicada en internet (GitHub Pages)
const ONLINE = location.protocol.startsWith('http');
async function autoUpdate() {
  const v = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : null);
  if (!v || !v.prices_date) return false;
  const want = v.prices_date + '|' + (v.built_at || '');
  const have = await idbGet('db_ver');
  if (have === want && await idbGet('db')) return false;
  $view.innerHTML = `<div class="center"><h1>9Bolsillos</h1><p>Descargando precios del ${esc(v.prices_date.split('-').reverse().join('/'))}…</p><p class="muted" id="prog"></p></div>`;
  const r = await fetch('9bolsillos.db?v=' + encodeURIComponent(want), { cache: 'no-store' });
  if (!r.ok) throw new Error('No se pudo descargar la base de datos (' + r.status + ')');
  const total = +r.headers.get('content-length') || 0, reader = r.body.getReader(), parts = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    parts.push(value); got += value.length;
    const pg = document.getElementById('prog'); if (pg) pg.textContent = total ? Math.round(got / total * 100) + ' %' : (got / 1048576).toFixed(1) + ' MB';
  }
  const bytes = new Uint8Array(got); let off = 0; parts.forEach(p => { bytes.set(p, off); off += p.length; });
  openDb(bytes.buffer);
  await idbPut('db', bytes.buffer); await idbPut('db_ver', want);
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
