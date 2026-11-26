"""Fotos del producto sellado de cada set en español, sacadas de WikiDex (archivos cuyo nombre lleva el nombre del set).

  python3 sellado.py --db 9bolsillos.db --prev sellado_prev.json --out sellado.json

Usa la API pública de WikiDex despacio (1 petición por segundo) y guarda lo ya encontrado: cada día solo se
miran los sets nuevos y, una vez al mes, los que no tenían fotos.
Salida: {set_id: [{"t": tipo, "n": nombre en español, "u": url de la miniatura}], "_v": versión}
"""
import argparse, datetime, json, re, sqlite3, time, urllib.parse, urllib.request

API = "https://www.wikidex.net/api.php"
UA = {"User-Agent": "9Bolsillos/1.0 (app personal de coleccion Pokemon; github.com/pablolaraj8-stack/9bolsillos-precios-a)"}
VERSION = 3
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


# TCGplayer (edición inglesa, vía el catálogo público de tcgcsv.com): solo para los tipos que WikiDex no tiene
TCGCSV = "https://tcgcsv.com/tcgplayer/3"
TIPOS_EN = [
    ("etbpc", r"Pok[ée]mon Center.*Elite Trainer Box"),
    ("etb", r"Elite Trainer Box"),
    ("bb", r"Build (&|and) Battle"),
    ("box", r"Booster Box|Booster Display"),
    ("bundle", r"Booster Bundle"),
    ("blister", r"Blister|Checklane|3 Pack|3-Pack|Three"),
    ("tin", r"\bTin\b"),
    ("premium", r"Premium Collection|Special Collection|\bCollection\b"),
    ("deck", r"Theme Deck|League Battle Deck|Battle Deck"),
    ("booster", r"Booster Pack|Sleeved Booster"),
]
FUERA_EN = re.compile(r"\bCase\b|Code Card|Bundle Case|Display Case|Art Bundle|Set of|\[Set", re.I)
_GRUPOS = None


def tcgcsv(path):
    u = f"{TCGCSV}/{path}"
    return json.loads(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=40).read())


def _n(t):
    return re.sub(r"[^a-z0-9]", "", re.sub(r"\s*&\s*", " and ", (t or "").lower()))


def tcgplayer(nombre_en, fecha, ya):
    global _GRUPOS
    if _GRUPOS is None:
        _GRUPOS = tcgcsv("groups").get("results", [])
        time.sleep(0.5)
    objetivo = _n(nombre_en)
    if not objetivo:
        return []
    # TCGplayer antepone la serie: «SV08: Surging Sparks», «SM - Burning Shadows», «XY - Roaring Skies»
    cands = [g for g in _GRUPOS if _n(g.get("name", "")).endswith(objetivo)]
    if not cands:
        return []
    def gap(g):
        try:
            return abs((datetime.date.fromisoformat(g.get("publishedOn", "")[:10]) - datetime.date.fromisoformat(fecha[:10])).days)
        except Exception:
            return 9999
    g = min(cands, key=gap)
    if gap(g) > 200:
        return []
    prods = tcgcsv(f"{g['groupId']}/products").get("results", [])
    time.sleep(0.5)
    out = []
    for pr in prods:
        name = pr.get("name") or ""
        if any(e.get("name") == "Number" for e in pr.get("extendedData") or []):
            continue  # es una carta, no producto sellado
        if FUERA_EN.search(name) or not pr.get("imageUrl"):
            continue
        t = next((t for t, rx in TIPOS_EN if re.search(rx, name, re.I)), None)
        if not t or t in ya:
            continue
        out.append({"t": t, "n": name, "u": pr["imageUrl"].replace("_200w.", "_400w."), "en": 1})
    return out


def api(params):
    u = API + "?" + urllib.parse.urlencode(dict(params, format="json", formatversion=2))
    return json.loads(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30).read())


def tipo(nombre):
    for t, rx in TIPOS:
        if re.search(rx, nombre, re.I):
            return t
    return None


def buscar(nombre_set, nombre_en=None, fecha="", pause=1.0):
    out = buscar_wikidex(nombre_set, pause)
    if nombre_en:
        try:
            out += tcgplayer(nombre_en, fecha or "", {x["t"] for x in out})
        except Exception as e:
            print("TCGplayer no ha respondido para", nombre_en, e)
    orden = [t for t, _ in TIPOS]
    return sorted(out, key=lambda x: (orden.index(x["t"]), x.get("en", 0), x["n"]))


def buscar_wikidex(nombre_set, pause=1.0):
    # 1) archivos con el nombre del set en el título
    r = api({"action": "query", "list": "search", "srnamespace": 6, "srsearch": f'intitle:"{nombre_set}"', "srlimit": 50})
    time.sleep(pause)
    files = [x["title"] for x in r.get("query", {}).get("search", [])]
    # 2) imágenes que salen en la página de la expansión (ahí suelen estar la ETB, las cajas y los blísteres)
    r = api({"action": "query", "list": "search", "srsearch": f'intitle:"{nombre_set}" TCG', "srlimit": 10})
    time.sleep(pause)
    pag = next((x["title"] for x in r.get("query", {}).get("search", []) if "(TCG):" in x["title"] and x["title"].lower().endswith(nombre_set.lower())), None)
    if pag:
        im = api({"action": "query", "titles": pag, "prop": "images", "imlimit": 200, "redirects": 1})
        time.sleep(pause)
        files += [i["title"] for p in im.get("query", {}).get("pages", []) for i in p.get("images", [])]
    files = list(dict.fromkeys(files))
    elegidos = []
    for f in files:
        n = re.sub(r"^Archivo:", "", f)
        n = re.sub(r"\.(png|jpe?g|webp|gif)$", "", n, flags=re.I)
        if nombre_set.lower() not in n.lower() or FUERA.search(f):
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
        norm = {x["from"]: x["to"] for x in d.get("query", {}).get("normalized", [])}
        for p in d.get("query", {}).get("pages", []):
            ii = (p.get("imageinfo") or [{}])[0]
            if ii.get("thumburl") or ii.get("url"):
                urls[p["title"]] = ii.get("thumburl") or ii["url"]
        for f, n, t in lote:
            u = urls.get(norm.get(f, f))
            if u:
                out.append({"t": t, "n": n, "u": u})
    return out


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
    hoy = datetime.date.today().isoformat()
    mes = (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
    db = sqlite3.connect(a.db)
    sets = db.execute("""SELECT s.set_id, s.name_es, s.name_en, s.release_date FROM sets s WHERE s.lang = 'es' AND s.name_es IS NOT NULL AND s.cm_expansion_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM cm_products p WHERE p.kind = 'sealed' AND p.cm_expansion_id = s.cm_expansion_id)
        ORDER BY s.release_date DESC""").fetchall()
    out, hechos = {"_v": VERSION}, 0
    for sid, nombre, nombre_en, fecha in sets:
        p = prev.get(sid)
        if p and (p.get("fotos") or p.get("d", "") > mes):
            out[sid] = p
            continue
        if hechos >= a.max:
            if p:
                out[sid] = p
            continue
        try:
            fotos = buscar(nombre, nombre_en, fecha)
        except Exception as e:
            print("WikiDex no ha respondido para", nombre, e)
            if p:
                out[sid] = p
            continue
        hechos += 1
        out[sid] = {"d": hoy, "fotos": fotos}
    json.dump(out, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    con = sum(1 for k, v in out.items() if k != "_v" and v.get("fotos"))
    print(f"Sellado: {len(sets)} sets en español con producto · {con} con fotos (WikiDex + TCGplayer) · {hechos} consultados hoy")


if __name__ == "__main__":
    main()
