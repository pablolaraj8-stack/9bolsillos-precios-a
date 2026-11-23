"""Envía los avisos de precio al móvil (Web Push) después de actualizar los precios.

Lo ejecuta el workflow diario. Necesita estos secretos de GitHub:
  SUPABASE_URL          https://xxxx.supabase.co
  SUPABASE_SECRET_KEY   sb_secret_...  (NUNCA en la web ni en config.js)
  VAPID_PRIVATE_KEY     clave privada de avisos (la del LEEME)
  VAPID_SUBJECT         mailto:tu-email  (opcional)

Un deseo con precio objetivo avisa cuando la tendencia o la oferta más baja quedan por
debajo del objetivo. No repite el aviso salvo que el precio baje otro 5 % o el deseo
deje de cumplirse y vuelva a cumplirse.
"""
import argparse, json, os, sqlite3, sys, urllib.request, urllib.error
from datetime import datetime, timezone


def api(method, path, body=None, prefer=None):
    url = os.environ['SUPABASE_URL'].rstrip('/') + '/rest/v1/' + path
    h = {'apikey': os.environ['SUPABASE_SECRET_KEY'], 'Content-Type': 'application/json'}
    if prefer:
        h['Prefer'] = prefer
    req = urllib.request.Request(url, method=method, headers=h,
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=30) as r:
        t = r.read()
        return json.loads(t) if t else None


def price_of(db, cm, variant):
    r = db.execute('SELECT trend, avg30, low, trend_holo, avg30_holo, low_holo FROM prices WHERE cm_product_id=?', (cm,)).fetchone()
    if not r:
        return None, None
    holo = False
    if variant == 'reverse':
        # el reverse usa los precios "holo" del producto salvo que tenga producto propio
        n = db.execute('SELECT COUNT(DISTINCT variant) FROM card_variants WHERE cm_product_id=?', (cm,)).fetchone()[0]
        holo = n > 1
    t, a, l = (r[3], r[4], r[5]) if holo else (r[0], r[1], r[2])
    return (t if t is not None else a), l


def card_name(db, card_id):
    r = db.execute("""SELECT COALESCE(c.name_es,c.name_en,c.name_ja,c.name_local), COALESCE(s.name_es,s.name_en,s.name_ja,s.name_local), c.local_id
                      FROM cards c JOIN sets s USING(set_id) WHERE card_id=?""", (card_id,)).fetchone()
    return f'{r[0]} ({r[1]} {r[2]})' if r else card_id


def eur(v):
    return f'{v:,.2f} €'.replace(',', 'X').replace('.', ',').replace('X', '.')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default='9bolsillos.db')
    ap.add_argument('--site', default='https://example.github.io/9bolsillos/')
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    for k in ('SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'VAPID_PRIVATE_KEY'):
        if not os.environ.get(k):
            print(f'Avisos: falta el secreto {k}; no se envía nada.')
            return
    from pywebpush import webpush, WebPushException

    db = sqlite3.connect(a.db)
    subs = api('GET', 'push_subs?select=endpoint,user_id,sub')
    if not subs:
        print('Avisos: nadie ha activado los avisos.')
        return
    users = sorted({s['user_id'] for s in subs})
    cols = api('GET', 'collections?select=user_id,alerts:data->alerts&user_id=in.(' + ','.join(users) + ')')
    logs = {(l['user_id'], l['alert_key']): l for l in api('GET', 'push_log?select=user_id,alert_key,last_price') or []}
    now = datetime.now(timezone.utc).isoformat()
    claims = {'sub': os.environ.get('VAPID_SUBJECT') or 'mailto:avisos@9bolsillos.app'}
    sent = 0

    for col in cols or []:
        uid, alerts = col['user_id'], col.get('alerts') or {}
        hits, clear = [], []
        for key, al in alerts.items():
            tgt = al.get('target')
            if not tgt or not al.get('cm'):
                continue
            trend, low = price_of(db, al['cm'], al.get('variant'))
            best = min([p for p in (trend, low) if p is not None], default=None)
            prev = logs.get((uid, key))
            if best is None or best > tgt:
                if prev:
                    clear.append(key)
                continue
            if prev and prev.get('last_price') is not None and best > prev['last_price'] * 0.95:
                continue
            hits.append((key, al, trend, low, best))
        for key in clear:
            if not a.dry:
                api('DELETE', f'push_log?user_id=eq.{uid}&alert_key=eq.{urllib.parse.quote(key)}')
        if not hits:
            continue
        hits.sort(key=lambda h: h[4] / (h[1]['target'] or 1))
        lines = []
        for key, al, trend, low, best in hits[:4]:
            how = 'oferta más baja' if low is not None and (trend is None or low < trend) and low <= al['target'] else 'tendencia'
            lines.append(f"{card_name(db, al['card'])}: {eur(best)} ({how}, objetivo {eur(al['target'])})")
        if len(hits) > 4:
            lines.append(f'y {len(hits) - 4} más')
        title = '¡Una carta de tus deseos ha bajado!' if len(hits) == 1 else f'¡{len(hits)} cartas de tus deseos han bajado!'
        payload = json.dumps({'title': title, 'body': '\n'.join(lines), 'url': a.site.rstrip('/') + '/#/wish', 'tag': '9b-deseos'})
        delivered = False
        for s in [s for s in subs if s['user_id'] == uid]:
            if a.dry:
                print('DRY', uid[:8], title, '|', ' / '.join(lines)); delivered = True
                continue
            try:
                webpush(subscription_info=s['sub'], data=payload, vapid_private_key=os.environ['VAPID_PRIVATE_KEY'],
                        vapid_claims=dict(claims), ttl=12 * 3600)
                delivered = True; sent += 1
            except WebPushException as e:
                code = getattr(e.response, 'status_code', None)
                if code in (404, 410):  # suscripción caducada: se borra
                    api('DELETE', 'push_subs?endpoint=eq.' + urllib.parse.quote(s['endpoint'], safe=''))
                else:
                    print('Avisos: error enviando:', code, str(e)[:200])
        if delivered and not a.dry:
            api('POST', 'push_log', [{'user_id': uid, 'alert_key': k, 'last_price': b, 'notified_at': now} for k, _, _, _, b in hits],
                prefer='resolution=merge-duplicates')
    print(f'Avisos: {sent} notificaciones enviadas.')


if __name__ == '__main__':
    import urllib.parse
    try:
        main()
    except Exception as e:  # los avisos nunca deben romper la actualización de precios
        print('Avisos: fallo', type(e).__name__, str(e)[:300])
        sys.exit(0)
