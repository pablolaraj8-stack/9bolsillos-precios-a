"""Datos del widget de la pantalla de inicio: un JSON pequeño por usuario en _site/w/<token secreto>.json.

Solo el valor total, el cambio de hoy y la serie del último mes; nada de las cartas.
Solo para quien ha activado el widget en la app (colección: widgetToken).
"""
import argparse, json, os, re, sqlite3, sys
from datetime import datetime
from zoneinfo import ZoneInfo


def eur(v):
    return f'{v:,.2f} €'.replace(',', 'X').replace('.', ',').replace('X', '.')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    if not (os.environ.get('SUPABASE_URL') and os.environ.get('SUPABASE_SECRET_KEY')):
        print('Widget: faltan los secretos de Supabase; nada que hacer.'); return
    from notify import api
    cols = api('GET', 'collections?select=user_id,data&data->>widgetToken=not.is.null') or []
    db = sqlite3.connect(a.db)
    days = [r[0] for r in db.execute('SELECT DISTINCT day FROM history ORDER BY day')][-31:]
    os.makedirs(os.path.join(a.out, 'w'), exist_ok=True)
    n = 0
    for c in cols:
        d = c.get('data') or {}
        tok = d.get('widgetToken')
        if not tok or not re.fullmatch(r'[0-9a-f]{32}', tok):
            continue
        items = []   # (cm, reverse, unidades)
        for e in (d.get('cards') or {}).values():
            if e.get('cm'):
                items.append((e['cm'], 'rev' in (e.get('variant') or '').lower(), len(e.get('copies') or []) or e.get('qty') or 1))
        for cm, e in (d.get('sealed') or {}).items():
            items.append((int(cm), False, e.get('qty') or 1))
        for cm, e in (d.get('extra') or {}).items():
            items.append((int(cm), False, (e or {}).get('qty') or 1))
        serie = []
        for day in days:
            tot = 0.0
            for cm, rev, qn in items:
                r = db.execute('SELECT trend_c, trend_holo_c FROM history WHERE cm_product_id=? AND day=?', (cm, day)).fetchone()
                if r:
                    v = r[1] if rev and r[1] is not None else r[0]
                    tot += (v or 0) / 100 * qn
            serie.append(round(tot, 2))
        if not serie:
            continue
        hoy, ayer = serie[-1], (serie[-2] if len(serie) > 1 else serie[-1])
        ult = datetime.strptime(str(days[-1]), '%Y%m%d')
        out = {'valor': hoy, 'valor_txt': eur(hoy), 'cambio': round(hoy - ayer, 2), 'cambio_txt': eur(abs(hoy - ayer)),
               'serie': serie, 'fecha_txt': 'Precios del ' + ult.strftime('%d/%m'), 'generado': datetime.now(ZoneInfo('Europe/Madrid')).isoformat(timespec='minutes')}
        json.dump(out, open(os.path.join(a.out, 'w', tok + '.json'), 'w'), ensure_ascii=False)
        n += 1
    print(f'Widget: datos para {n} usuario(s)')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:   # el widget nunca debe romper la publicación
        print('Widget: fallo', type(e).__name__, str(e)[:300]); sys.exit(0)
