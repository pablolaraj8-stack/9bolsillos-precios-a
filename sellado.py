"""Fotos del producto sellado de cada set en español, sacadas de WikiDex (archivos cuyo nombre lleva el nombre del set).

  python3 sellado.py --db 9bolsillos.db --prev sellado_prev.json --out sellado.json

Usa la API pública de WikiDex despacio (1 petición por segundo) y guarda lo ya encontrado: cada día solo se
miran los sets nuevos y, una vez al mes, los que no tenían fotos.
Salida: {set_id: [{"t": tipo, "n": nombre en español, "u": url de la miniatura}], "_v": versión}
"""
import argparse, datetime, json, re, sqlite3, time, unicodedata, urllib.parse, urllib.request

API = "https://www.wikidex.net/api.php"
UA = {"User-Agent": "9Bolsillos/1.0 (app personal de coleccion Pokemon; github.com/pablolaraj8-stack/9bolsillos-precios-a)"}
VERSION = 2
BUSQUEDA = 3   # sube este número para volver a buscar ya mismo los sets que se quedaron sin fotos
# tipo de producto según el nombre del archivo en WikiDex (en español)
TIPOS = [
    ("etbpc", r"Caja de Entrenador [ÉE]lite.*Pok[ée]mon Center|Pok[ée]mon Center.*Caja de Entrenador"),
    ("etb", r"Caja de Entrenador [ÉE]lite"),
    ("bb", r"Combina y Combate"),
    ("box", r"Caja de (36 )?sobres|Caja de refuerzo|Display"),
    ("bundle", r"Lote de (6 )?sobres|Paquete de (6 )?sobres"),
    ("blister", r"Bl[íi]ster"),
    ("tin", r"Minilata|Lata"),
    ("premium", r"Colecci[óo]n pr[ée]mium|Colecci[óo]n especial|Colecci[óo]n"),
    ("deck", r"Baraja"),
    ("booster", r"^Sobre "),
]
FUERA = re.compile(r"TCG\)|Logo|S[íi]mbolo|Icono|Promo|Rareza|Ilustraci[óo]n|\.svg$", re.I)


def api(params):
    u = API + "?" + urllib.parse.urlencode(dict(params, format="json", formatversion=2))
    return json.loads(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30).read())


def tipo(nombre):
    for t, rx in TIPOS:
        if re.search(rx, nombre, re.I):
            return t
    return None


def norm(t):
    """Compara nombres sin tildes, mayúsculas ni signos: «30.º», «30º» y «30°» cuentan igual."""
    t = unicodedata.normalize("NFKD", re.sub(r"\.?\s*[º°ª]", "", t))
    t = "".join(c for c in t if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def buscar(nombre_set, pause=1.0):
    files = []
    # 1) archivos cuyo nombre EMPIEZA por el nombre del set (p. ej. «Celebración 30.º Aniversario Caja de Entrenador Élite.png»).
    #    Es una lista exacta, no depende del buscador, así que no falla con signos como «30.º».
    r = api({"action": "query", "list": "allimages", "aiprefix": nombre_set, "ailimit": 200})
    time.sleep(pause)
    files += ["Archivo:" + x["name"].replace("_", " ") for x in r.get("query", {}).get("allimages", [])]
    # 2) archivos con el nombre del set en cualquier parte del título («Caja de Entrenador Élite Destinos de Paldea.png»)
    for q in (f'intitle:"{nombre_set}"', " ".join("intitle:" + w for w in norm(nombre_set).split() if len(w) > 1)):
        r = api({"action": "query", "list": "search", "srnamespace": 6, "srsearch": q, "srlimit": 50})
        time.sleep(pause)
        files += [x["title"] for x in r.get("query", {}).get("search", [])]
    # 3) imágenes que salen en la página de la expansión (ahí suelen estar la ETB, las cajas y los blísteres)
    r = api({"action": "query", "list": "search", "srsearch": f'intitle:"{nombre_set}" TCG', "srlimit": 10})
    time.sleep(pause)
    ns = norm(nombre_set)
    pag = next((x["title"] for x in r.get("query", {}).get("search", [])
                if norm(x["title"]) == ns + " tcg" or ("(TCG):" in x["title"] and norm(x["title"]).endswith(ns))), None)
    if pag:
        im = api({"action": "query", "titles": pag, "prop": "images", "imlimit": 200, "redirects": 1})
        time.sleep(pause)
        files += [i["title"] for p in im.get("query", {}).get("pages", []) for i in p.get("images", [])]
    files = list(dict.fromkeys(files))
    elegidos = []
    for f in files:
        n = re.sub(r"^Archivo:", "", f)
        n = re.sub(r"\.(png|jpe?g|webp|gif)$", "", n, flags=re.I)
        if ns not in norm(n) or FUERA.search(f):
            continue
        t = tipo(n)
        if t:
            elegidos.append((f, n, t))
    if not elegidos:
        return []
    out = []
    for i in range(0, len(elegidos), 40):
        lote = elegidos[i:i + 40]
        d = api({"action": "query", "titles": "|".join(f for f, _, _ in lote), "prop": "imageinfo", "iiprop": "url", "iiurlwidth": 500})
        time.sleep(pause)
        urls = {}
        renom = {x["from"]: x["to"] for x in d.get("query", {}).get("normalized", [])}
        for p in d.get("query", {}).get("pages", []):
            ii = (p.get("imageinfo") or [{}])[0]
            if ii.get("thumburl") or ii.get("url"):
                urls[p["title"]] = ii.get("thumburl") or ii["url"]
        for f, n, t in lote:
            u = urls.get(renom.get(f, f))
            if u:
                out.append({"t": t, "n": n, "u": u})
    orden = [t for t, _ in TIPOS]
    return sorted(out, key=lambda x: (orden.index(x["t"]), x["n"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--prev")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max", type=int, default=400, help="sets como mucho por ejecución")
    a = ap.parse_args()
    prev = {}
    try:
        prev = json.load(open(a.prev, encoding="utf-8")) if a.prev else {}
    except Exception:
        prev = {}
    if prev.get("_v") != VERSION:
        prev = {}
    if prev.get("_b") != BUSQUEDA:   # búsqueda mejorada: se conservan los sets con fotos y se reintentan los vacíos
        prev = {k: v for k, v in prev.items() if k == "_v" or (isinstance(v, dict) and v.get("fotos"))}
    hoy = datetime.date.today().isoformat()
    mes = (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
    db = sqlite3.connect(a.db)
    sets = db.execute("""SELECT s.set_id, s.name_es FROM sets s WHERE s.lang = 'es' AND s.name_es IS NOT NULL AND s.cm_expansion_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM cm_products p WHERE p.kind = 'sealed' AND p.cm_expansion_id = s.cm_expansion_id)
        ORDER BY s.release_date DESC""").fetchall()
    out, hechos = {"_v": VERSION, "_b": BUSQUEDA}, 0
    for sid, nombre in sets:
        p = prev.get(sid)
        if p and (p.get("fotos") or p.get("d", "") > mes):
            out[sid] = p
            continue
        if hechos >= a.max:
            if p:
                out[sid] = p
            continue
        try:
            fotos = buscar(nombre)
        except Exception as e:
            print("WikiDex no ha respondido para", nombre, e)
            if p:
                out[sid] = p
            continue
        hechos += 1
        out[sid] = {"d": hoy, "fotos": fotos}
    json.dump(out, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    con = sum(1 for k, v in out.items() if not k.startswith("_") and v.get("fotos"))
    print(f"Sellado: {len(sets)} sets en español con producto · {con} con fotos de WikiDex · {hechos} consultados hoy")


if __name__ == "__main__":
    main()
