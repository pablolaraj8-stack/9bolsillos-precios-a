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

# Logos de sets en español e imágenes de cartas que TCGdex aún no tiene: se sacan de CollectHolo
# (su lista de sets y la de cartas de cada set son públicas). Si falla, la app sigue con lo de TCGdex.
def collectholo_fill():
    import unicodedata, urllib.request, time
    norm = lambda t: re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", (t or "").lower()).encode("ascii", "ignore").decode())
    def get(path):
        req = urllib.request.Request("https://www.collectholo.com" + path, headers={"User-Agent": "9Bolsillos/1.0 (uso personal)", "Accept": "application/json"})
        return json.load(urllib.request.urlopen(req, timeout=30))
    try:
        ch = get("/api/sets?lang=es").get("sets", [])
    except Exception as e:
        print("CollectHolo: no disponible:", e); return {}, {}
    by_name, by_date = {}, {}
    for x in ch:
        for k in (x.get("name"), x.get("explore_set_name"), x.get("name_en")):
            if k: by_name.setdefault(norm(k), x)
        by_date.setdefault(((x.get("release_date") or "").replace("/", "-"), x.get("total")), x)
    con = sqlite3.connect(a.db)
    logos, imgs, recent = {}, {}, []
    for sid, es, en, rd, n in con.execute("SELECT set_id, name_es, name_en, release_date, card_count FROM sets WHERE lang='es'"):
        x = by_name.get(norm(es)) or by_name.get(norm(en)) or by_date.get((rd, n))
        if not x: continue
        logo = (x.get("images") or {}).get("logo")
        if logo: logos[sid] = logo
        if rd and rd >= time.strftime("%Y-%m-%d", time.gmtime(time.time() - 400 * 86400)): recent.append((sid, x["id"]))
    # Imágenes: solo sets del último año (los antiguos ya los tiene TCGdex). Se empareja por número y, si no cuadra, por nombre.
    for sid, chid in recent:
        try:
            cards = get(f"/api/sets/{chid}/binder").get("cards", [])
        except Exception as e:
            print("CollectHolo: sin cartas de", chid, e); continue
        by_num, by_nm = {}, {}
        for c in cards:
            if not c.get("isDefaultVariant", True) or not c.get("smallImageUrl"): continue
            by_num.setdefault(str(c.get("number", "")).lstrip("0"), []).append(c)
            by_nm.setdefault(norm(c.get("name")), []).append(c)
        for cid, local, nm_es, nm_en in con.execute("SELECT card_id, local_id, name_es, name_en FROM cards WHERE set_id=?", (sid,)):
            cand = by_num.get(str(local).lstrip("0"), [])
            hit = next((c for c in cand if norm(c.get("name")) in (norm(nm_en), norm(nm_es))), None)
            if not hit:
                same = by_nm.get(norm(nm_en)) or by_nm.get(norm(nm_es)) or []
                hit = same[0] if len(same) == 1 else None
            if hit: imgs[cid] = hit["smallImageUrl"]
        time.sleep(0.5)
    con.close()
    print(f"CollectHolo: {len(logos)} logos, {len(imgs)} imágenes de cartas ({len(recent)} sets recientes)")
    return logos, imgs
_logos, _imgs = collectholo_fill()
with open(os.path.join(a.out, "logos.js"), "w", encoding="utf-8") as f:
    f.write("window.SET_LOGOS = " + json.dumps(_logos, separators=(",", ":")) + ";\n")
    f.write("window.IMG_FB = " + json.dumps(_imgs, separators=(",", ":")) + ";\n")

# Copia completa comprimida (la app la usa la primera vez o cuando cambia el catálogo)
db.close()
with open(a.db, "rb") as f:
    gz("9bolsillos.db.gz", f.read())

json.dump({"prices_date": meta.get("prices_date"), "built_at": meta.get("built_at", ""), "catalog_ver": catalog_ver, "app_ver": os.environ.get("GITHUB_SHA", "")[:7],
           "history_days": sorted(days), "schema": 2}, open(os.path.join(a.out, "version.json"), "w"))
sizes = {n: os.path.getsize(os.path.join(a.out, n)) for n in os.listdir(a.out) if n.endswith(".gz")}
print("catálogo", catalog_ver, "| base", round(sizes["9bolsillos.db.gz"] / 1e6, 1), "MB | precios del día",
      round(sizes["prices-latest.json.gz"] / 1e6, 2), "MB | días de historial", len(days))
