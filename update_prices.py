"""
Añade la guía de precios del día a 9bolsillos.db y mantiene el historial ligero.

- Si la guía ya estaba cargada (misma fecha), no hace nada.
- Guarda precios DIARIOS de los últimos N días (por defecto 90).
  Más antiguos: solo se conserva el del lunes de cada semana.

Uso:
  python3 update_prices.py --db 9bolsillos.db --prices price_guide_6.json [--keep-daily 90]
"""
import argparse, datetime as dt, json, sqlite3, sys

FIELDS = ["low", "trend", "avg", "avg1", "avg7", "avg30",
          "low-holo", "trend-holo", "avg-holo", "avg1-holo", "avg7-holo", "avg30-holo"]

ap = argparse.ArgumentParser()
ap.add_argument("--db", default="9bolsillos.db")
ap.add_argument("--prices", required=True)
ap.add_argument("--keep-daily", type=int, default=90)
a = ap.parse_args()

try:
    d = json.load(open(a.prices, encoding="utf-8"))
    rows = d["priceGuides"]
    date = d["createdAt"][:10]
    dt.date.fromisoformat(date)
    assert len(rows) > 1000
except Exception as e:
    sys.exit(f"ERROR: el archivo de precios no es válido ({e}). ¿Ha cambiado el enlace de Cardmarket?")

db = sqlite3.connect(a.db)
if db.execute("SELECT 1 FROM prices WHERE date = ? LIMIT 1", (date,)).fetchone():
    print(f"Los precios del {date} ya estaban cargados. Nada que hacer.")
    sys.exit(0)

db.executemany("INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
               [(p["idProduct"], date, *[p.get(f) for f in FIELDS]) for p in rows])
db.execute("INSERT OR REPLACE INTO meta VALUES ('prices_date', ?)", (date,))

# Retención: diario los últimos N días, semanal (lunes) para lo anterior
cutoff = (dt.date.fromisoformat(date) - dt.timedelta(days=a.keep_daily)).isoformat()
old = [r[0] for r in db.execute("SELECT DISTINCT date FROM prices WHERE date < ?", (cutoff,))]
drop = [x for x in old if dt.date.fromisoformat(x).weekday() != 0]
db.executemany("DELETE FROM prices WHERE date = ?", [(x,) for x in drop])
db.commit()
if drop:
    db.execute("VACUUM")

days = db.execute("SELECT COUNT(DISTINCT date) FROM prices").fetchone()[0]
print(f"OK: precios del {date} añadidos ({len(rows)} productos). Fechas en el historial: {days}."
      + (f" Compactados {len(drop)} días antiguos." if drop else ""))
