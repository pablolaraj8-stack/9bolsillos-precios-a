"""Aviso al móvil cuando El Corte Inglés tiene en stock producto sellado de Pokémon (JCC).

Lo ejecuta «Stock El Corte Inglés» varias veces al día. Avisa una vez por producto cada vez
que vuelve a haber stock: si se agota, se olvida y el siguiente reabastecimiento avisa otra vez.
Cada usuario puede apagarlo en Ajustes (colección: eciOff).
"""
import argparse, json, os, sys, urllib.parse
from datetime import datetime, timezone

from notify import api
import eci


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', default='https://example.github.io/9bolsillos/')
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    prods = eci.productos()
    print(f'El Corte Inglés: {len(prods)} productos de Pokémon JCC · {sum(p["a"] for p in prods)} con stock')
    for p in prods:
        print(('  STOCK ' if p['a'] else '  agot. ') + f'{p["p"]:>7.2f} € {p["t"]}')
    if a.dry or not all(os.environ.get(k) for k in ('SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'VAPID_PRIVATE_KEY')):
        print('Avisos: modo prueba o faltan secretos; no se envía nada.')
        return
    from pywebpush import webpush, WebPushException
    subs = api('GET', 'push_subs?select=endpoint,user_id,sub') or []
    users = sorted({s['user_id'] for s in subs})
    if not users or not prods:
        return
    off = {c['user_id'] for c in api('GET', 'collections?select=user_id,off:data->eciOff&user_id=in.(' + ','.join(users) + ')') or [] if c.get('off')}
    logs = {(l['user_id'], l['alert_key']) for l in api('GET', 'push_log?select=user_id,alert_key&alert_key=like.eci:*') or []}
    now = datetime.now(timezone.utc).isoformat()
    claims = {'sub': os.environ.get('VAPID_SUBJECT') or 'mailto:avisos@example.com'}
    stock = {'eci:' + p['id']: p for p in prods if p['a']}
    agotados = {'eci:' + p['id'] for p in prods if not p['a']}
    for uid in users:
        # lo que se ha agotado se olvida: cuando vuelva, avisa de nuevo
        for k in [k for (u, k) in logs if u == uid and k in agotados]:
            api('DELETE', f'push_log?user_id=eq.{uid}&alert_key=eq.{urllib.parse.quote(k)}')
        if uid in off:
            continue
        nuevos = [(k, p) for k, p in stock.items() if (uid, k) not in logs]
        if not nuevos:
            continue
        nuevos.sort(key=lambda kp: -kp[1]['p'])
        lineas = [f"{p['t'].replace(' Bandai', '').replace(' JCC Pokémon', '').replace(' de JCC', '')}: {p['p']:.2f} €".replace('.', ',') for _, p in nuevos[:4]]
        if len(nuevos) > 4:
            lineas.append(f'y {len(nuevos) - 4} más')
        titulo = '🛒 Hay stock en El Corte Inglés' if len(nuevos) == 1 else f'🛒 {len(nuevos)} productos con stock en El Corte Inglés'
        # con un solo producto, el aviso abre directamente su ficha en El Corte Inglés
        url = nuevos[0][1]['u'] if len(nuevos) == 1 else a.site.rstrip('/') + '/#/ofertas'
        payload = json.dumps({'title': titulo, 'body': '\n'.join(lineas), 'url': url, 'tag': '9b-eci'})
        ok = False
        for s in [s for s in subs if s['user_id'] == uid]:
            try:
                webpush(subscription_info=s['sub'], data=payload, vapid_private_key=os.environ['VAPID_PRIVATE_KEY'], vapid_claims=dict(claims), ttl=3 * 3600)
                ok = True
            except WebPushException as e:
                code = getattr(e.response, 'status_code', None)
                if code in (404, 410):
                    api('DELETE', 'push_subs?endpoint=eq.' + urllib.parse.quote(s['endpoint'], safe=''))
                else:
                    print('Avisos: error enviando:', code, str(e)[:200])
        if ok:
            api('POST', 'push_log', [{'user_id': uid, 'alert_key': k, 'last_price': p['p'], 'notified_at': now} for k, p in nuevos],
                prefer='resolution=merge-duplicates')
            print(f'Avisos: enviado a {uid[:8]} ({len(nuevos)} productos)')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # un fallo aquí nunca debe romper nada
        print('Avisos El Corte Inglés: fallo', type(e).__name__, str(e)[:300])
        sys.exit(0)
