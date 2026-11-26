"""Más avisos al móvil (los llama notify.py cada día):

- Chollos de sellado: producto en español a buen precio (con envío) en alguna tienda con stock.
- Precio objetivo de sellado: «avísame si la ETB X baja de 55 €».
- Resumen de la semana (domingos): cuánto ha cambiado tu colección y qué se ha movido más.
- Cartas nuevas de Tomokazu Komiya en sets japoneses.

Cada usuario puede apagarlos en Ajustes (chollos, weeklyOff, komiyaOff en su colección).
"""
import hashlib, json, os, re, urllib.parse
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

ENVIO_DEF = {'Toy Planet': (4.95, 59.99), 'Metamorph Center': (4.95, 200), 'CardZone': (4.95, 200), 'Central TCG': (4.95, 150), 'AllinTCG': (4.95, 200),
             'Pokemillon': (4.95, 180), 'Alfriki': (4.95, 180), 'JJCollection': (4.95, 150), 'Darizard9': (9.99, None)}
CM_SHIP = 6.0


def eur(v):
    return f'{v:,.2f} €'.replace(',', 'X').replace('.', ',').replace('X', '.')


def median(a):
    b = sorted(x for x in a if x is not None)
    if not b:
        return None
    n = len(b)
    return b[n // 2] if n % 2 else (b[n // 2 - 1] + b[n // 2]) / 2


def ship(shop, p, envio):
    c, f = ENVIO_DEF.get(shop, (4.95, None))
    u = (envio or {}).get(shop)
    if u:
        c, f = u.get('c', c), u.get('f')
    return 0 if f is not None and p >= f else c


def shop_view(offers, trend, envio):
    """Igual que en la app: precio con envío, fuera lo que está muy lejos de Cardmarket."""
    o = [dict(x, tot=round(x['p'] + ship(x['s'], x['p'], envio), 2)) for x in offers or []
         if trend is None or trend * 0.4 <= x['p'] <= trend * 2.5]
    stock = sorted([x for x in o if x.get('a')], key=lambda x: x['tot'])
    ref = median([trend + CM_SHIP if trend is not None else None] + [x['tot'] for x in stock])
    return stock, ref


class Push:
    def __init__(self, a, subs, webpush, WebPushException, claims, api):
        self.a, self.subs, self.webpush, self.err, self.claims, self.api = a, subs, webpush, WebPushException, claims, api
        self.sent = 0

    def send(self, uid, title, body, url, tag):
        payload = json.dumps({'title': title, 'body': body, 'url': url, 'tag': tag})
        ok = False
        for s in [s for s in self.subs if s['user_id'] == uid]:
            if self.a.dry:
                print('DRY', uid[:8], title, '|', body.replace('\n', ' / ')); ok = True
                continue
            try:
                self.webpush(subscription_info=s['sub'], data=payload, vapid_private_key=os.environ['VAPID_PRIVATE_KEY'], vapid_claims=dict(self.claims), ttl=12 * 3600)
                ok = True; self.sent += 1
            except self.err as e:
                code = getattr(e.response, 'status_code', None)
                if code in (404, 410):
                    self.api('DELETE', 'push_subs?endpoint=eq.' + urllib.parse.quote(s['endpoint'], safe=''))
                else:
                    print('Avisos: error enviando:', code, str(e)[:200])
        return ok

    def log(self, uid, rows, now):
        if rows and not self.a.dry:
            self.api('POST', 'push_log', [{'user_id': uid, 'alert_key': k, 'last_price': p, 'notified_at': now} for k, p in rows], prefer='resolution=merge-duplicates')

    def unlog(self, uid, keys):
        if not self.a.dry:
            for k in keys:
                self.api('DELETE', f'push_log?user_id=eq.{uid}&alert_key=eq.{urllib.parse.quote(k)}')


def run(a, db, subs, users, webpush, WebPushException, claims, now, api):
    P = Push(a, subs, webpush, WebPushException, claims, api)
    site = a.site.rstrip('/')
    try:
        shops = json.load(open('tiendas.json', encoding='utf-8'))
    except Exception:
        shops = {}
    cols = api('GET', 'collections?select=user_id,data&user_id=in.(' + ','.join(users) + ')') or []
    logs = {}
    for l in api('GET', 'push_log?select=user_id,alert_key,last_price') or []:
        logs[(l['user_id'], l['alert_key'])] = l.get('last_price')
    price = {r[0]: r[1:] for r in db.execute('SELECT cm_product_id, trend, low, trend_holo FROM prices')}

    def best_now(cm, envio):
        tr, low, _ = price.get(cm, (None, None, None))
        stock, ref = shop_view(shops.get(str(cm)), tr, envio)
        opts = ([(stock[0]['tot'], stock[0]['s'], stock[0]['t'])] if stock else []) + ([(low + CM_SHIP, 'Cardmarket', None)] if low is not None else [])
        return (min(opts) if opts else None), stock, ref

    madrid = datetime.now(ZoneInfo('Europe/Madrid'))
    for col in cols:
        uid, d = col['user_id'], col.get('data') or {}
        envio = d.get('envio') or {}

        # 1) chollos de sellado
        mode = d.get('chollos') or 'all'
        if mode != 'off' and shops:
            watch = set(map(str, (d.get('chollosWatch') or {}).keys()))
            hits, clear = [], []
            for cm, offers in shops.items():
                if cm.startswith('_') or (mode == 'marked' and cm not in watch):
                    continue
                tr = price.get(int(cm), (None,))[0]
                stock, ref = shop_view(offers, tr, envio)
                key = 'ch:' + cm
                # con una sola tienda la referencia es poco fiable: para avisar, al menos dos con stock
                good = len(stock) >= 2 and ref and stock[0]['tot'] <= ref * 0.92
                if not good:
                    if (uid, key) in logs:
                        clear.append(key)
                    continue
                last = logs.get((uid, key))
                if last is not None and stock[0]['tot'] > last * 0.95:
                    continue
                hits.append((key, stock[0], ref))
            P.unlog(uid, clear)
            if hits:
                hits.sort(key=lambda h: h[1]['tot'] / h[2])
                lines = [f"{h[1]['t'][:60]}: {eur(h[1]['tot'])} en {h[1]['s']} (−{round((1 - h[1]['tot'] / h[2]) * 100)} %)" for h in hits[:4]]
                if len(hits) > 4:
                    lines.append(f'y {len(hits) - 4} más')
                t = '🏷️ Chollo de sellado' if len(hits) == 1 else f'🏷️ {len(hits)} chollos de sellado'
                if P.send(uid, t, '\n'.join(lines), site + '/#/ofertas', '9b-chollos'):
                    P.log(uid, [(k, o['tot']) for k, o, _ in hits], now)

        # 2) precio objetivo de sellado
        hits, clear = [], []
        for cm, al in (d.get('sealedAlerts') or {}).items():
            tgt = (al or {}).get('target')
            if not tgt:
                continue
            b, _, _ = best_now(int(cm), envio)
            key = 'sa:' + str(cm)
            if not b or b[0] > tgt:
                if (uid, key) in logs:
                    clear.append(key)
                continue
            last = logs.get((uid, key))
            if last is not None and b[0] > last * 0.95:
                continue
            name = b[2] or (db.execute('SELECT name FROM cm_products WHERE cm_product_id=?', (int(cm),)).fetchone() or ['Producto'])[0]
            hits.append((key, cm, b, tgt, name))
        P.unlog(uid, clear)
        if hits:
            lines = [f'{n[:60]}: {eur(b[0])} en {b[1]} (objetivo {eur(t)})' for _, _, b, t, n in hits[:4]]
            url = site + (f'/#/sealeditem/{hits[0][1]}' if len(hits) == 1 else '/#/wish')
            if P.send(uid, '🎯 Sellado a tu precio', '\n'.join(lines), url, '9b-sellado'):
                P.log(uid, [(k, b[0]) for k, _, b, _, _ in hits], now)

        # 3) resumen de la semana (domingo)
        if madrid.weekday() == 6 and not d.get('weeklyOff'):
            key = 'week:' + madrid.strftime('%G-%V')
            if (uid, key) not in logs:
                body = weekly(db, d, shops, envio)
                if body and P.send(uid, '📊 Tu semana en 9Bolsillos', body, site + '/#/', '9b-semana'):
                    P.log(uid, [(key, 0)], now)

        # 4) cartas nuevas de Komiya
        if not d.get('komiyaOff'):
            new = komiya_new(db)
            todo = [r for r in new if (uid, 'kom:' + r[0]) not in logs]
            if todo:
                lines = [f'{r[1]} · {r[2]} ({r[3]})' for r in todo[:4]] + ([f'y {len(todo) - 4} más'] if len(todo) > 4 else [])
                t = '✨ Carta nueva de Tomokazu Komiya' if len(todo) == 1 else f'✨ {len(todo)} cartas nuevas de Tomokazu Komiya'
                if P.send(uid, t, '\n'.join(lines), site + '/#/illustrator/' + urllib.parse.quote('Tomokazu Komiya'), '9b-komiya'):
                    P.log(uid, [('kom:' + r[0], 0) for r in todo], now)
        # 5) cartas que te faltan, rebajadas (sets en español que tienes empezados)
        if not d.get('radarOff'):
            hits, clear = radar(db, d), []
            keys = {h[0] for h in hits}
            clear = [k for (u, k) in logs if u == uid and k.startswith('rd:') and k not in keys]
            P.unlog(uid, clear)
            new = [h for h in hits if logs.get((uid, h[0])) is None or h[2] <= logs[(uid, h[0])] * 0.95]
            if new:
                new.sort(key=lambda h: h[3])
                lines = [f'{n} ({sn}): {eur(pr)} (−{round(-dif * 100)} %)' for _, n, pr, dif, sn in new[:4]] + ([f'y {len(new) - 4} más'] if len(new) > 4 else [])
                t = '📉 Una carta que te falta está rebajada' if len(new) == 1 else f'📉 {len(new)} cartas que te faltan, rebajadas'
                if P.send(uid, t, '\n'.join(lines), site + '/#/buy', '9b-radar'):
                    P.log(uid, [(k, pr) for k, _, pr, _, _ in new], now)

        # 6) preventas de sets nuevos en español
        if not d.get('preventaOff'):
            pv = [x for x in (shops.get('_preventas') or []) if x.get('a')]
            new = [x for x in pv if (uid, 'pv:' + hashlib.md5(x['u'].encode()).hexdigest()[:16]) not in logs]
            if new:
                by = {}
                for x in new:
                    by.setdefault((x['set'], x['ty']), []).append(x)
                lines = []
                for (st, ty), xs in sorted(by.items()):
                    b = min(xs, key=lambda x: x['p'] + ship(x['s'], x['p'], envio))
                    lines.append(f"{TIPO.get(ty, ty)} {st}: desde {eur(b['p'] + ship(b['s'], b['p'], envio))} en {b['s']}")
                sets_ = sorted({x['set'] for x in new})
                if P.send(uid, '🆕 Preventa: ' + ', '.join(sets_), '\n'.join(lines[:5]), site + '/#/ofertas', '9b-preventa'):
                    P.log(uid, [('pv:' + hashlib.md5(x['u'].encode()).hexdigest()[:16], x['p']) for x in new], now)

        # 7) metas: el día 1 de cada mes
        if madrid.day == 1 and d.get('goals') and not d.get('goalsOff'):
            key = 'goal:' + madrid.strftime('%Y-%m')
            if (uid, key) not in logs:
                body = goals(db, d)
                if body and P.send(uid, '🎯 Cómo van tus metas', body, site + '/#/metas', '9b-metas'):
                    P.log(uid, [(key, 0)], now)
    return P.sent


TIPO = {'etb': 'ETB', 'etbpc': 'ETB Pokémon Center', 'box': 'Caja de sobres', 'box18': 'Caja de 18 sobres', 'bundle': 'Lote de 6 sobres', 'bb': 'Combina y Combate',
        'blister': 'Blíster', 'pack': 'Sobre'}


def radar(db, d):
    """Cartas que te faltan de tus sets en español empezados, hoy un 15 % o más por debajo de su media de 30 días (desde 2 €)."""
    cards = d.get('cards') or {}
    sets = {e.get('set') for e in cards.values() if e.get('set')}
    if not sets:
        return []
    q = f"""SELECT c.card_id, COALESCE(c.name_es, c.name_en), COALESCE(s.name_es, s.name_en), v.variant, p.trend, p.avg30, p.trend_holo, p.avg30_holo
        FROM cards c JOIN sets s USING(set_id) JOIN card_variants v ON v.card_id = c.card_id JOIN prices p ON p.cm_product_id = v.cm_product_id
        WHERE s.lang = 'es' AND c.set_id IN ({','.join('?' * len(sets))})"""
    best = {}
    for cid, n, sn, var, tr, a30, trh, a30h in db.execute(q, list(sets)):
        if cid in cards:
            continue
        rev = 'rev' in (var or '').lower()
        t, a = (trh, a30h) if rev else (tr, a30)
        if t is None or not a:
            continue
        if cid not in best or t < best[cid][0]:
            best[cid] = (t, a, n, sn)
    out = []
    for cid, (t, a, n, sn) in best.items():
        if t >= 2 and t <= a * 0.85:
            out.append(('rd:' + cid, n, t, t / a - 1, sn))
    return out


def goals(db, d):
    lines = []
    cards = d.get('cards') or {}
    try:
        txt = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'app', 'orden.js'), encoding='utf-8').read()
        kom_ids = set(re.findall(r'"id":"([^"]+)"', txt))
        kom_cms = set(re.findall(r'"cm":(\d+)', txt))
    except Exception:
        kom_ids, kom_cms = set(), set()
    for g in d.get('goals') or []:
        if g.get('type') == 'set':
            r = db.execute("SELECT COALESCE(name_es, name_en) FROM sets WHERE set_id=?", (g.get('set'),)).fetchone()
            ids = [x[0] for x in db.execute('SELECT card_id FROM cards WHERE set_id=?', (g.get('set'),))]
            have = sum(1 for i in ids if i in cards)
            lines.append(f"{r[0] if r else g.get('set')}: {have} de {len(ids)} ({round(have / len(ids) * 100) if ids else 0} %), meta {g.get('year')}")
        elif g.get('type') == 'kom':
            have = sum(1 for i in kom_ids if i in cards) + sum(1 for c in kom_cms if c in (d.get('extra') or {}))
            lines.append(f"Komiya {g.get('year')}: {have - (g.get('base') or 0)} de {g.get('target')} nuevas")
    return '\n'.join(lines)


def komiya_new(db):
    """Cartas de Komiya en sets japoneses posteriores a la última de la lista hecha a mano (orden.js)."""
    try:
        txt = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'app', 'orden.js'), encoding='utf-8').read()
        last = max(re.findall(r'"d":"([\d-]+)"', txt))
    except Exception:
        return []
    return db.execute("""SELECT c.card_id, COALESCE(c.name_ja, c.name_en, c.name_local), COALESCE(s.name_ja, s.name_en, s.name_local), s.release_date
        FROM cards c JOIN sets s USING(set_id) WHERE c.illustrator LIKE 'Tomokazu Komiya' AND s.lang = 'ja' AND s.release_date > ?""", (last,)).fetchall()


def weekly(db, d, shops, envio):
    days = [r[0] for r in db.execute('SELECT DISTINCT day FROM history ORDER BY day')]
    if not days:
        return None
    today = days[-1]
    target = int((datetime.strptime(str(today), '%Y%m%d') - timedelta(days=7)).strftime('%Y%m%d'))
    past = max([x for x in days if x <= target], default=days[0])
    if (datetime.strptime(str(today), '%Y%m%d') - datetime.strptime(str(past), '%Y%m%d')).days < 6:
        past = today   # aún no hay una semana de historial: solo el valor de hoy
    def val(cm, rev, day):
        r = db.execute('SELECT trend_c, trend_holo_c FROM history WHERE cm_product_id=? AND day=?', (cm, day)).fetchone()
        if not r:
            return None
        v = r[1] if rev and r[1] is not None else r[0]
        return v / 100 if v is not None else None
    now_t = then_t = 0.0
    moves = []
    for cid, e in (d.get('cards') or {}).items():
        cm, qty = e.get('cm'), e.get('qty') or 1
        if not cm:
            continue
        rev = 'rev' in (e.get('variant') or '').lower()
        a, b = val(cm, rev, today), val(cm, rev, past)
        if a is None:
            continue
        now_t += a * qty
        then_t += (b if b is not None else a) * qty
        if b is not None and past != today:
            moves.append(((a - b) * qty, cid))
    for cm, e in (d.get('sealed') or {}).items():
        a, b = val(int(cm), False, today), val(int(cm), False, past)
        if a is not None:
            now_t += a * (e.get('qty') or 1); then_t += (b if b is not None else a) * (e.get('qty') or 1)
    if not now_t:
        return None
    lines = [f'Tu colección vale {eur(now_t)}' + (f' ({"+" if now_t >= then_t else "−"}{eur(abs(now_t - then_t))} en {round((datetime.strptime(str(today), "%Y%m%d") - datetime.strptime(str(past), "%Y%m%d")).days)} días)' if past != today else '') + '.']
    moves.sort()
    def nm(cid):
        r = db.execute('SELECT COALESCE(name_es, name_en, name_ja, name_local) FROM cards WHERE card_id=?', (cid,)).fetchone()
        return r[0] if r else cid
    up = [m for m in reversed(moves) if m[0] > 0.5][:2]
    down = [m for m in moves if m[0] < -0.5][:1]
    if up:
        lines.append('Suben: ' + ', '.join(f'{nm(c)} +{eur(v)}' for v, c in up))
    if down:
        lines.append('Baja: ' + ', '.join(f'{nm(c)} −{eur(-v)}' for v, c in down))
    n = 0
    for cm, offers in (shops or {}).items():
        if cm.startswith('_'):
            continue
        tr = (db.execute('SELECT trend FROM prices WHERE cm_product_id=?', (int(cm),)).fetchone() or [None])[0]
        stock, ref = shop_view(offers, tr, envio)
        if len(stock) >= 2 and ref and stock[0]['tot'] <= ref * 0.92:
            n += 1
    if n:
        lines.append(f'Hoy hay {n} chollo{"s" if n > 1 else ""} de sellado en tiendas.')
    return '\n'.join(lines)
