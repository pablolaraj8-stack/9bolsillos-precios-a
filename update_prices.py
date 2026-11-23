"""
Añade la guía de precios del día a 9bolsillos.db.

- Tabla `prices`: SOLO los precios del último día (todos los campos de Cardmarket).
- Tabla `history`: historial compacto (tendencia en céntimos) de las cartas y el sellado
  que valen al menos 0,25 €. Diario los últimos N días (90 por defecto); más antiguo,
  solo el lunes de cada semana. Así la base sigue siendo ligera para la app.
- Si la guía ya estaba cargada (misma fecha), no hace nada.

Uso:
  python3 update_prices.py --db 9bolsillos.db --prices price_guide_6.json [--keep-daily 90]
"""
import argparse, datetime as dt, json, sqlite3, sys

FIELDS = ["low", "trend", "avg", "avg1", "avg7", "avg30",
          "low-holo", "trend-holo", "avg-holo", "avg1-holo", "avg7-holo", "avg30-holo"]
MIN_TREND = 0.25

HISTORY_SCHEMA = """
CREATE TABLE IF NOT EXISTS history(
  cm_product_id INTEGER, day INTEGER, trend_c INTEGER, trend_holo_c INTEGER,
  PRIMARY KEY(cm_product_id, day)) WITHOUT ROWID;
"""


def cents(v):
    return int(round(v * 100)) if isinstance(v, (int, float)) and v >= MIN_TREND else None


def apply(db, prices_path, keep_daily=90):
    d = json.load(open(prices_path, encoding="utf-8"))
    rows = d["priceGuides"]
    date = d["createdAt"][:10]
    dt.date.fromisoformat(date)
    if len(rows) < 1000:
        raise ValueError("muy pocos productos")
    db.executescript(HISTORY_SCHEMA)
    last = db.execute("SELECT value FROM meta WHERE key='prices_date'").fetchone()
    if last and last[0] >= date:
        return f"Los precios del {date} ya estaban cargados. Nada que hacer."

    db.execute("DELETE FROM prices")
    db.executemany("INSERT INTO prices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   [(p["idProduct"], date, *[p.get(f) for f in FIELDS]) for p in rows])

    tracked = {r[0] for r in db.execute(
        "SELECT cm_product_id FROM card_variants UNION SELECT cm_product_id FROM cm_products WHERE kind='sealed'")}
    day = int(date.replace("-", ""))
    hist = []
    for p in rows:
        if p["idProduct"] in tracked:
            t, th = cents(p.get("trend")), cents(p.get("trend-holo"))
            if t is not None or th is not None:
                hist.append((p["idProduct"], day, t, th))
    db.executemany("INSERT OR REPLACE INTO history VALUES (?,?,?,?)", hist)
    db.execute("INSERT OR REPLACE INTO meta VALUES ('prices_date', ?)", (date,))

    cutoff = int((dt.date.fromisoformat(date) - dt.timedelta(days=keep_daily)).strftime("%Y%m%d"))
    old = [r[0] for r in db.execute("SELECT DISTINCT day FROM history WHERE day < ?", (cutoff,))]
    drop = [x for x in old if dt.datetime.strptime(str(x), "%Y%m%d").weekday() != 0]
    db.executemany("DELETE FROM history WHERE day = ?", [(x,) for x in drop])
    db.commit()
    db.execute("VACUUM")
    days = db.execute("SELECT COUNT(DISTINCT day) FROM history").fetchone()[0]
    return (f"OK: precios del {date} añadidos ({len(rows)} productos, {len(hist)} al historial). "
            f"Fechas en el historial: {days}." + (f" Compactados {len(drop)} días antiguos." if drop else ""))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="9bolsillos.db")
    ap.add_argument("--prices", required=True)
    ap.add_argument("--keep-daily", type=int, default=90)
    a = ap.parse_args()
    try:
        print(apply(sqlite3.connect(a.db), a.prices, a.keep_daily))
    except Exception as e:
        sys.exit(f"ERROR: el archivo de precios no es válido ({e}). ¿Ha cambiado el enlace de Cardmarket?")
