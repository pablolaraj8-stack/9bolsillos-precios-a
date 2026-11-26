"""Más avisos al móvil (los llama notify.py cada día):

- Chollos de sellado: producto en español a buen precio (con envío) en alguna tienda con stock.
- Precio objetivo de sellado: «avísame si la ETB X baja de 55 €».
- Resumen de la semana (domingos): cuánto ha cambiado tu colección y qué se ha movido más.
- Cartas nuevas de Tomokazu Komiya en sets japoneses.

Cada usuario puede apagarlos en Ajustes (chollos, weeklyOff, komiyaOff en su colección).
"""
import json, os, re, urllib.parse
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
    return P.sent


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
