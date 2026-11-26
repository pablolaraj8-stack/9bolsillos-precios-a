"""Fotos de las cartas que TCGdex no tiene.

Mira en la API de TCGdex qué cartas no tienen imagen y las busca en otras fuentes:
  1. CollectHolo (sets en español y japoneses: misma carta, mismo idioma)
  2. pokemontcg.io (cartas internacionales: la misma ilustración, en inglés)
Solo sets en español/internacionales y japoneses (los que se coleccionan aquí).
Salida: {card_id: url, ..., "_v": n}. Si una fuente falla, se conservan las fotos de ayer (--prev).
"""
import argparse, json, re, sqlite3, time, unicodedata, urllib.parse, urllib.request
import concurrent.futures as cf

VERSION = 1
UA = {"User-Agent": "9Bolsillos/1.0 (uso personal; https://github.com/pablolaraj8-stack/9bolsillos-precios-a)", "Accept": "application/json"}
# Promos japonesas: TCGdex y CollectHolo las llaman distinto
CH_MANUAL = {"SV-P": "svp_ja", "M-P": "mp_ja", "S-P": "swshp_ja", "SM-P": "smp_ja", "XY-P": "xyp_ja", "BW-P": "bwp_ja",
             "DP-P": "dpp_ja", "DPt-P": "ptp_ja", "L-P": "lp_ja", "ADV-P": "advp_ja", "PCG-P": "pcgp_ja"}


def get(url, tries=4):
    for i in range(tries):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40))
        except Exception as e:
            err = e
            # 429 = vamos demasiado rápido: se espera de verdad antes de volver a preguntar
            time.sleep(45 * (i + 1) if getattr(e, "code", 0) == 429 else 3 * (i + 1))
    raise err


norm = lambda t: re.sub(r"[^a-z0-9぀-ヿ一-鿿]", "", unicodedata.normalize("NFKC", (t or "")).lower())
num = lambda n: re.sub(r"^0+(?=.)", "", str(n or "").strip().upper())


def day(d):
    try:
        return time.mktime(time.strptime((d or "")[:10].replace("/", "-"), "%Y-%m-%d")) / 86400
    except Exception:
        return None


def pick(cands, rd):
    """Entre sets con el mismo nombre, el de fecha más cercana (máx. 120 días)."""
    d0 = day(rd)
    best = None
    for c in cands:
        d1 = day(c.get("release_date") or c.get("releaseDate"))
        gap = abs(d1 - d0) if d0 is not None and d1 is not None else 9999
        if gap <= 120 and (best is None or gap < best[0]):
            best = (gap, c)
    if best:
        return best[1]
    return cands[0] if len(cands) == 1 and d0 is None else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--prev", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--informe", default="")
    a = ap.parse_args()
    prev = {}
    try:
        prev = json.load(open(a.prev, encoding="utf-8")) if a.prev else {}
        if prev.get("_v") != VERSION:
            prev = {k: v for k, v in prev.items() if k != "_v"}
    except Exception:
        prev = {}
    con = sqlite3.connect(a.db)
    sets = [dict(zip(("id", "region", "lang", "es", "en", "ja", "local", "rd", "n"), r)) for r in con.execute(
        "SELECT set_id, region, lang, name_es, name_en, name_ja, name_local, release_date, card_count FROM sets WHERE region='int' OR lang='ja'")]
    ids_db = {r[0] for r in con.execute("SELECT card_id FROM cards")}
    nombres = {r[0]: {norm(x) for x in r[1:] if x} for r in con.execute("SELECT card_id, name_en, name_es, name_ja, name_local FROM cards")}

    # 1) Qué cartas no tienen imagen en TCGdex (una petición por set)
    def sin_imagen(s):
        lang = "en" if s["region"] == "int" else "ja"
        try:
            d = get(f"https://api.tcgdex.net/v2/{lang}/sets/{urllib.parse.quote(s['id'])}")
        except Exception:
            return s["id"], None
        return s["id"], [c["localId"] for c in d.get("cards", []) if not c.get("image") and f"{s['id']}-{c['localId']}" in ids_db]
    with cf.ThreadPoolExecutor(8) as ex:
        falta = {k: v for k, v in ex.map(sin_imagen, sets) if v}
    total_falta = sum(len(v) for v in falta.values())
    print(f"TCGdex: {total_falta} cartas sin imagen en {len(falta)} sets")

    out, informe = {}, {"sets": {}}
    def casar(sid, locs, by_num, by_nom):
        """Por número; si no cuadra, por nombre cuando solo hay una carta con ese nombre."""
        res = {}
        for l in locs:
            u = by_num.get(num(l))
            if not u:
                hits = {x for n in nombres.get(f"{sid}-{l}", ()) for x in by_nom.get(n, [])}
                u = next(iter(hits)) if len(hits) == 1 else None
            res[l] = u
        return res

    def poner(sid, cards, fuente):
        hechos = 0
        for local, url in cards.items():
            cid = f"{sid}-{local}"
            if cid not in out and url:
                out[cid] = url; hechos += 1
        if hechos:
            informe["sets"].setdefault(sid, {}).update({fuente: hechos})
        return hechos

    def binder(chid):
        cards = get(f"https://www.collectholo.com/api/sets/{chid}/binder").get("cards", [])
        by, nom = {}, {}
        for c in cards:
            if c.get("smallImageUrl") and c.get("isDefaultVariant", True):
                by.setdefault(num(c.get("number")), c["smallImageUrl"])
                for k in ("name", "name_en"):
                    if c.get(k):
                        nom.setdefault(norm(c[k]), []).append(c["smallImageUrl"])
        return by, nom

    # 2) CollectHolo: misma carta en el mismo idioma
    ch = {}
    for lang in ("es", "ja"):
        try:
            ch[lang] = get(f"https://www.collectholo.com/api/sets?lang={lang}").get("sets", [])
        except Exception as e:
            print("CollectHolo no disponible:", lang, e); ch[lang] = []
    for s in sets:
        locs = falta.get(s["id"])
        if not locs:
            continue
        lang = "es" if s["region"] == "int" else "ja"
        pool = ch.get(lang) or []
        x = next((c for c in pool if c["id"] == CH_MANUAL.get(s["id"])), None) if lang == "ja" else None
        if not x:
            names = {norm(n) for n in (s["es"], s["en"], s["ja"], s["local"]) if n}
            cands = [c for c in pool if names & {norm(c.get("name")), norm(c.get("name_en")), norm(c.get("explore_set_name"))} - {""}]
            x = pick(cands, s["rd"]) if cands else None
        if not x and s["n"]:
            same = [c for c in pool if c.get("total") == s["n"] and day(c.get("release_date")) is not None and day(s["rd"]) is not None and abs(day(c["release_date"]) - day(s["rd"])) <= 3]
            x = same[0] if len(same) == 1 else None
        if not x:
            continue
        try:
            by, nom = binder(x["id"])
        except Exception as e:
            print("CollectHolo sin cartas de", x["id"], e); continue
        n = poner(s["id"], casar(s["id"], locs, by, nom), "collectholo:" + x["id"])
        print(f"  {s['id']:>12} → CollectHolo {x['id']}: {n}/{len(locs)}")
        time.sleep(2.5)

    # 3) pokemontcg.io: cartas internacionales que aún faltan (misma ilustración, en inglés)
    try:
        pt = get("https://api.pokemontcg.io/v2/sets?pageSize=250").get("data", [])
    except Exception as e:
        print("pokemontcg.io no disponible:", e); pt = []
    for s in sets:
        if s["region"] != "int":
            continue
        locs = [l for l in falta.get(s["id"], []) if f"{s['id']}-{l}" not in out]
        if not locs or not pt:
            continue
        en = norm(s["en"])
        cands = [p for p in pt if norm(p["name"]) == en]
        if not cands and en.startswith("mcdonald"):
            yr = (s["rd"] or "")[:4]
            cands = [p for p in pt if "mcdonald" in norm(p["name"]) and yr in p["name"]]
        kit = re.search(r"trainer\s*kit.*\((.+)\)", s["en"] or "", re.I)
        if not cands and kit:
            poke = norm(kit.group(1))
            cands = [p for p in pt if "trainerkit" in norm(p["name"]) and poke in norm(p["name"])]
        x = pick(cands, s["rd"]) if cands else None
        if not x:
            same = [p for p in pt if day(p.get("releaseDate")) is not None and day(s["rd"]) is not None and abs(day(p["releaseDate"]) - day(s["rd"])) <= 3 and p.get("total") == s["n"]]
            x = same[0] if len(same) == 1 else None
        if not x:
            continue
        try:
            cards = get(f"https://api.pokemontcg.io/v2/cards?q=set.id:{x['id']}&pageSize=250&select=number,name,images").get("data", [])
        except Exception as e:
            print("pokemontcg.io sin cartas de", x["id"], e); continue
        by, nom = {}, {}
        for c in cards:
            u = (c.get("images") or {}).get("small")
            by[num(c.get("number"))] = u
            nom.setdefault(norm(c.get("name")), []).append(u)
        n = poner(s["id"], casar(s["id"], locs, by, nom), "pokemontcg:" + x["id"])
        print(f"  {s['id']:>12} → pokemontcg.io {x['id']}: {n}/{len(locs)}")
        time.sleep(0.3)

    # Si hoy una fuente no respondió, se conservan las fotos de ayer
    for k, v in prev.items():
        if k != "_v" and k not in out and k.rsplit("-", 1)[0] in falta:
            out[k] = v
    out["_v"] = VERSION
    json.dump(out, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"Fotos encontradas: {len(out) - 1} de {total_falta} cartas sin imagen")
    if a.informe:
        informe["sin_foto"] = {sid: [l for l in locs if f"{sid}-{l}" not in out] for sid, locs in falta.items()}
        informe["sin_foto"] = {k: v for k, v in informe["sin_foto"].items() if v}
        # Para la lista de Komiya: cartas de las máquinas expendedoras y promos sin numerar
        kom = {}
        for chid in ("vnd1_ja", "vnd2_ja", "vnd3_ja", "miscp_ja"):
            try:
                kom[chid] = [{k: c.get(k) for k in ("number", "name", "name_en", "smallImageUrl", "artist", "illustrator")} for c in get(f"https://www.collectholo.com/api/sets/{chid}/binder").get("cards", [])]
            except Exception as e:
                kom[chid] = str(e)
            time.sleep(3)
        informe["komiya"] = kom
        json.dump(informe, open(a.informe, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
