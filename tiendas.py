"""Precios del producto sellado EN ESPAÑOL en tiendas españolas.

Lee el catálogo público de cada tienda (Shopify publica /products.json para que lo usen buscadores y
comparadores; ninguna lo prohíbe en su robots.txt), despacio y una vez al día. No se usa ninguna tienda que
bloquee estas lecturas. Cada anuncio se empareja con su producto de Cardmarket (set + tipo).
Salida: {cm_product_id: [{"s": tienda, "t": título, "p": precio, "a": hay stock, "u": url}], "_d": fecha, "_tiendas": {...}}
"""
import argparse, datetime, json, re, sqlite3, time, unicodedata, urllib.request

UA = {"User-Agent": "9Bolsillos/1.0 (app personal; compara precios una vez al día; github.com/pablolaraj8-stack/9bolsillos-precios-a)",
      "Accept": "application/json"}
TIENDAS = {  # dominio: nombre que se ve en la app
    "metamorphcenter.com": "Metamorph Center", "cardzone.es": "CardZone", "iberiancollect.com": "Iberian Collect",
    "tcg-collection.com": "TCG-Collection", "centraltcg.com": "Central TCG", "pokezilla.com": "Pokezilla",
    "allintcg.com": "AllinTCG", "grillecards.com": "Grillecards", "pokedealtcg.es": "PokeDealTCG",
    "pokemillon.es": "Pokemillon", "ryucards.es": "RyuCards", "todohits.com": "TodoHits", "unsobremas.com": "UnSobreMas",
    "tcglevel.com": "TCG Level", "elbazartcg.com": "ElBazarTCG", "darizard9.com": "Darizard9", "alfriki.com": "Alfriki",
    "jjcollection.es": "JJCollection", "sunnystore.es": "Sunny Store", "toyplanet.com": "Toy Planet",
}  # y El Corte Inglés, aparte (eci.py)
MAX_PAGINAS = 30

def norm(t):
    t = unicodedata.normalize("NFKD", t or "")
    t = "".join(c for c in t if not unicodedata.combining(c)).lower()
    t = re.sub(r"\.?\s*[º°ª]", "", t)
    return " " + re.sub(r"[^a-z0-9]+", " ", t).strip() + " "

ES = re.compile(r"espa[nñ]ol|castellano|\[esp?\]|\(esp?\)|\bes\b|\besp\b", re.I)
FUERA = re.compile(r"ingl[eé]s|english|\[en\]|\(en\)|\ben\]|japon|\bjp\b|\bjap\b|chin[oa]|\bch\b|corean|\bkr\b|\bkor\b|"
                   r"aleman|franc[eé]s|italian|portugu|da[nñ]ad|damaged|abiert|protector|funda|acr[ií]lic|participaci|apertura|"
                   r"case\b|\bx\s?\d+\b|\d+\s?x\b|pack de \d|lote|display de|caja de \d+ (etb|bundles)|vac[ií]a|empty|sin pl[aá]stico|"
                   r"one piece|yu-?gi|magic|lorcana|dragon ball|digimon|riftbound|topps|funko|star wars|union arena|gundam", re.I)
TIPOS = [  # (tipo, expresión en el título de la tienda, cómo se llama en Cardmarket)
    ("etbpc", r"pok[eé]mon center", None),
    ("etb", r"\betb\b|entrenador [eé]lite|entrenador de [eé]lite|elite trainer", r"^(?!.*(Pok[ée]mon Center|Case|\d+ Elite|Empty|Display)).*Elite Trainer Box"),
    ("box18", r"18 sobres|\(18|half", r"Booster Box \(18 Boosters\)$"),
    ("box", r"booster box|display|caja de sobres|36 sobres|caja 36|caja de 36", r"^(?!.*(Case|\(18|Sleeved)).*Booster Box$"),
    ("bundle", r"bundle|6 sobres|caja 6|pack de 6", r"Booster Bundle$"),
    ("bb", r"combina y combate|build\s?(&|and|y)\s?battle", r"Build & Battle Box$"),
    ("blister", r"bl[ií]ster|checklane|3 sobres", "BLISTER"),
    ("pack", r"\bsobre\b(?!s)|booster pack|sobre suelto", r"^(?!.*(Sleeved|\(|Fun Pack)).*Booster$"),
]


def get(url, tries=2):
    for i in range(tries):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30))
        except Exception as e:
            err = e
            time.sleep(5 if getattr(e, "code", 0) != 429 else 60)
    raise err


def catalogo(dom):
    out = []
    for base in (f"https://{dom}/collections/pokemon/products.json", f"https://{dom}/products.json"):
        out = []
        for page in range(1, MAX_PAGINAS + 1):
            try:
                ps = get(f"{base}?limit=250&page={page}").get("products", [])
            except Exception:
                break
            out += ps
            time.sleep(1.2)
            if len(ps) < 250:
                break
        if len(out) > 20:
            return out
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--informe", default="")
    a = ap.parse_args()
    db = sqlite3.connect(a.db)
    sets = [(norm(n), e) for n, e in db.execute("SELECT name_es, cm_expansion_id FROM sets WHERE lang='es' AND name_es IS NOT NULL AND cm_expansion_id IS NOT NULL")]
    sets.sort(key=lambda x: -len(x[0]))
    # nombres de serie que también son set base: si el título trae otro set además («Espada y Escudo Choque Rebelde»), manda el otro
    series = {norm(n) for (n,) in db.execute("SELECT DISTINCT serie FROM sets WHERE serie IS NOT NULL")} | {norm(x) for x in ("Escarlata y Púrpura", "Espada y Escudo", "Sol y Luna", "Megaevolución", "XY", "Negro y Blanco")}
    prods = {}
    for pid, name, exp in db.execute("SELECT cm_product_id, name, cm_expansion_id FROM cm_products WHERE kind='sealed'"):
        prods.setdefault(exp, []).append((pid, name))

    def emparejar(titulo):
        t = norm(titulo)
        if FUERA.search(titulo):
            return None, "fuera"
        found = [(n, e) for n, e in sets if n in t]
        if len(found) > 1:
            found = [f for f in found if f[0] not in series] or found
        exp = found[0][1] if found else None
        if not exp:
            return None, "sin set"
        tipo = next(((ty, cmrx) for ty, rx, cmrx in TIPOS if re.search(rx, titulo, re.I)), None)
        if not tipo or not tipo[1]:
            return None, "sin tipo"
        ty, cmrx = tipo
        cands = prods.get(exp, [])
        if cmrx == "BLISTER":
            hits = [(pid, n) for pid, n in cands if re.search(r"Blister", n) and not re.search(r"Display|Case", n)
                    and (m := re.search(r":\s*(.+?)\s+(\d-Pack|Premium Checklane)", n)) and norm(m.group(1)) in t]
        else:
            hits = [(pid, n) for pid, n in cands if re.search(cmrx, n)]
        if len(hits) > 1:
            # varias versiones (Mega Lucario / Mega Gardevoir, Koraidon / Miraidon…): manda la palabra que sale en el título
            base = set(norm(" ".join(n for _, n in hits)).split())
            def score(n):
                own = set(norm(n).split()) - {w for w in base if all(w in norm(m).split() for _, m in hits)}
                return sum(1 for w in own if len(w) > 2 and f" {w} " in t)
            sc = sorted(((score(n), -len(n), pid) for pid, n in hits), reverse=True)
            if sc[0][0] > 0 and (len(sc) == 1 or sc[0][0] > sc[1][0]):
                return sc[0][2], ty
            plain = [(pid, n) for pid, n in hits if not re.search(r"\(|Enhanced|Version|Sleeved", n)]
            if len(plain) == 1 and sc[0][0] == 0:
                return plain[0][0], ty
        return (hits[0][0], ty) if len(hits) == 1 else (None, f"{len(hits)} candidatos")

    out, info, hoy, sueltos = {}, {}, datetime.date.today().isoformat(), []
    for dom, nombre in TIENDAS.items():
        try:
            cat = catalogo(dom)
        except Exception as e:
            info[nombre] = {"error": str(e)[:80]}; continue
        n = 0
        for p in cat:
            titulo = p.get("title") or ""
            if not re.search(r"pok[eé]mon|etb|entrenador|booster|sobre|bl[ií]ster|bundle|combina", titulo + " " + (p.get("vendor") or "") + " " + (p.get("product_type") or ""), re.I):
                continue
            # anuncios en español: lo dice el título, o usa el nombre español del set y no menciona otro idioma
            pid, why = emparejar(titulo)
            if not pid:
                if why != "fuera" and why != "sin set":
                    sueltos.append(f"{nombre}: {titulo} [{why}]")
                continue
            vs = p.get("variants") or [{}]
            v = min(vs, key=lambda x: float(x.get("price") or 1e9))
            try:
                precio = float(v.get("price"))
            except Exception:
                continue
            if precio <= 0:
                continue
            out.setdefault(str(pid), []).append({"s": nombre, "t": titulo[:120], "p": round(precio, 2), "a": any(x.get("available") for x in vs),
                                                 "u": f"https://{dom}/products/{p.get('handle')}"})
            n += 1
        info[nombre] = {"dominio": dom, "productos": len(cat), "emparejados": n}
        print(f"{nombre:>18}: {len(cat)} productos en catálogo · {n} de sellado en español emparejados")
    # El Corte Inglés no es Shopify: sus fichas de producto (eci.py)
    try:
        import eci
        n = 0
        prods = eci.productos()
        for q in prods:
            pid, why = emparejar(q["t"])
            if pid:
                out.setdefault(str(pid), []).append({"s": "El Corte Inglés", "t": q["t"][:120], "p": q["p"], "a": q["a"], "u": q["u"]}); n += 1
            else:
                sueltos.append(f"El Corte Inglés: {q['t']} [{why}]")
        info["El Corte Inglés"] = {"dominio": "elcorteingles.es", "productos": len(prods), "emparejados": n}
        print(f"   El Corte Inglés: {len(prods)} productos de Pokémon JCC · {n} emparejados")
    except Exception as e:
        info["El Corte Inglés"] = {"error": str(e)[:80]}
    for k in out:
        out[k].sort(key=lambda x: (not x["a"], x["p"]))
    out["_d"] = hoy
    out["_tiendas"] = info
    json.dump(out, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    if a.informe:
        json.dump({"tiendas": info, "sin_emparejar": sueltos, "emparejados": {k: v for k, v in out.items() if not k.startswith("_")}}, open(a.informe, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print(f"Tiendas: {len(out) - 2} productos de Cardmarket con precio en alguna tienda")


if __name__ == "__main__":
    main()
