"""
Prepara los archivos de datos de la web para que la app descargue poco cada día:

  9bolsillos.db.gz         base completa comprimida (solo se baja si cambia el catálogo)
  prices-latest.json.gz    precios del día de los productos que usa la app (~1 MB)
  history-AAAAMMDD.json.gz historial de un día (los últimos 21 días)
  version.json             qué hay publicado (fecha de precios, versión del catálogo, días de historial)

Uso: python3 export_web.py --db 9bolsillos.db --out _site
"""
import argparse, gzip, hashlib, json, os, sqlite3

ap = argparse.ArgumentParser()
ap.add_argument("--db", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--days", type=int, default=21)
a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
db = sqlite3.connect(a.db)
meta = dict(db.execute("SELECT key, value FROM meta"))
has_extra = db.execute("SELECT 1 FROM sqlite_master WHERE name='cm_extra'").fetchone()

# Versión del catálogo: cambia solo si cambian sets, cartas, variantes o productos
h = hashlib.sha1()
# (las cartas sueltas nuevas de Cardmarket entran cada día y no cambian nada visible hasta que TCGdex las enlaza,
#  así que no fuerzan una descarga completa; el sellado sí)
for sql in ("SELECT * FROM sets ORDER BY set_id", "SELECT * FROM cards ORDER BY card_id",
            "SELECT * FROM card_variants ORDER BY card_id, cm_product_id, variant",
            "SELECT * FROM cm_products WHERE kind='sealed' ORDER BY cm_product_id"):
    for row in db.execute(sql):
        h.update(repr(row).encode())
catalog_ver = h.hexdigest()[:16]

def gz(name, obj):
    data = json.dumps(obj, separators=(",", ":")).encode() if not isinstance(obj, bytes) else obj
    with gzip.open(os.path.join(a.out, name), "wb", compresslevel=9) as f:
        f.write(data)

tracked_sql = ("SELECT cm_product_id FROM card_variants UNION SELECT cm_product_id FROM cm_products WHERE kind='sealed'"
               + (" UNION SELECT cm_product_id FROM cm_extra" if has_extra else ""))
cols = ["low", "trend", "avg", "avg1", "avg7", "avg30", "low_holo", "trend_holo", "avg_holo", "avg1_holo", "avg7_holo", "avg30_holo"]
# Cartas de las listas "Mi orden" (app/orden.js) enlazadas con Cardmarket: también necesitan su precio diario
import re
orden_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app", "orden.js")
orden_ids = sorted({int(x) for x in re.findall(r'"cm":(\d+)', open(orden_path, encoding="utf-8").read())}) if os.path.exists(orden_path) else []
if orden_ids:
    tracked_sql += " UNION SELECT cm_product_id FROM prices WHERE cm_product_id IN (" + ",".join(map(str, orden_ids)) + ")"
rows = db.execute(f"SELECT cm_product_id, {', '.join(cols)} FROM prices WHERE cm_product_id IN ({tracked_sql})").fetchall()
gz("prices-latest.json.gz", {"date": meta.get("prices_date"), "cols": cols, "rows": rows})

days = [r[0] for r in db.execute("SELECT DISTINCT day FROM history ORDER BY day DESC LIMIT ?", (a.days,))]
for d in days:
    gz(f"history-{d}.json.gz", db.execute("SELECT cm_product_id, trend_c, trend_holo_c FROM history WHERE day = ?", (d,)).fetchall())

# Copia completa comprimida (la app la usa la primera vez o cuando cambia el catálogo)
db.close()
with open(a.db, "rb") as f:
    gz("9bolsillos.db.gz", f.read())

json.dump({"prices_date": meta.get("prices_date"), "built_at": meta.get("built_at", ""), "catalog_ver": catalog_ver,
           "history_days": sorted(days), "schema": 2}, open(os.path.join(a.out, "version.json"), "w"))
sizes = {n: os.path.getsize(os.path.join(a.out, n)) for n in os.listdir(a.out) if n.endswith(".gz")}
print("catálogo", catalog_ver, "| base", round(sizes["9bolsillos.db.gz"] / 1e6, 1), "MB | precios del día",
      round(sizes["prices-latest.json.gz"] / 1e6, 2), "MB | días de historial", len(days))
