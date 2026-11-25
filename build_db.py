"""
Construye la base de datos de 9Bolsillos (SQLite) cruzando:
  - TCGdex (cards-database, licencia MIT): sets, cartas, números, rarezas, nombres ES/EN/JA
  - Cardmarket: catálogo de singles, catálogo de sellado y guía de precios (descarga diaria)

Uso:
  python3 build_db.py --tcgdex RUTA_cards-database \
      --singles products_singles_6.json --sealed products_nonsingles_6.json \
      --prices price_guide_6.json --out 9bolsillos.db
"""
import argparse, json, os, re, sqlite3, sys

IMG = "https://assets.tcgdex.net/{lang}/{serie}/{set}/{local}"  # + "/high.webp" o "/low.webp"


def lang_block(txt, key):
    m = re.search(r"\n\t" + key + r":\s*\{(.*?)\n\t\}", txt, re.S)
    if not m:
        return {}
    return dict(re.findall(r"['\"]?([a-z]{2}(?:-[a-z]{2})?)['\"]?\s*:\s*['\"]((?:[^'\"\\]|\\.)*)['\"]", m.group(1)))


def first(rx, txt):
    m = re.search(rx, txt)
    return m.group(1) if m else None


def parse_variants(txt):
    """Devuelve [(cardmarket_id, tipo, subtipo, sello, foil, idiomas)] de un archivo de carta."""
    out = []
    m = re.search(r"\n\tvariants:\s*\[(.*?)\n\t\]", txt, re.S)
    if m:
        for item in re.findall(r"\{(.*?)\n\t\t\}", m.group(1), re.S):
            cm = first(r"cardmarket:\s*(\d+)", item)
            if cm:
                stamp = re.findall(r"['\"]([^'\"]+)['\"]", first(r"stamp:\s*\[([^\]]*)\]", item) or "")
                langs = re.findall(r"['\"]([^'\"]+)['\"]", first(r"languages:\s*\[([^\]]*)\]", item) or "")
                out.append((int(cm), first(r"type:\s*['\"]([^'\"]+)", item),
                            first(r"subtype:\s*['\"]([^'\"]+)", item), ",".join(stamp) or None,
                            first(r"foil:\s*['\"]([^'\"]+)", item), ",".join(langs) or None))
    top = re.search(r"\n\tthirdParty:\s*\{([^}]*)\}", txt, re.S)
    if top:
        cm = first(r"cardmarket:\s*(\d+)", top.group(1))
        if cm and int(cm) not in [v[0] for v in out]:
            out.append((int(cm), None, None, None, None, None))
    return out


def load_tcgdex(root):
    sets, cards = [], []
    for region, folder in (("int", "data"), ("asia", "data-asia")):
        base = os.path.join(root, folder)
        for serie in sorted(os.listdir(base)):
            sdir = os.path.join(base, serie)
            if not os.path.isdir(sdir) or serie == "Pokémon TCG Pocket":  # juego digital, sin cartas físicas
                continue
            serie_txt = open(sdir + ".ts", encoding="utf-8").read() if os.path.exists(sdir + ".ts") else ""
            serie_id = first(r"\n\tid:\s*['\"]([^'\"]+)", serie_txt) or serie
            for f in sorted(os.listdir(sdir)):
                if not f.endswith(".ts"):
                    continue
                txt = open(os.path.join(sdir, f), encoding="utf-8").read()
                set_id = first(r"\n\tid:\s*['\"]([^'\"]+)", txt)
                if not set_id:
                    continue
                names = lang_block(txt, "name")
                tp = re.search(r"\n\tthirdParty:\s*\{([^}]*)\}", txt, re.S)
                cm_exp = first(r"cardmarket:\s*(\d+)", tp.group(1)) if tp else None
                count = first(r"official:\s*(\d+)", txt)
                lang = "es" if region == "int" else next((l for l in ("ja", "ko", "zh-tw", "zh-cn", "id", "th") if l in names), "ja")
                sets.append(dict(set_id=set_id, region=region, serie=serie, serie_id=serie_id, lang=lang,
                                 name_es=names.get("es"), name_en=names.get("en"), name_ja=names.get("ja"),
                                 release=first(r"releaseDate:\s*['\"]([^'\"]+)", txt),
                                 count=int(count) if count else None,
                                 cm_exp=int(cm_exp) if cm_exp else None,
                                 name_local=names.get(lang) or next(iter(names.values()), None)))
                cdir = os.path.join(sdir, f[:-3])
                if not os.path.isdir(cdir):
                    continue
                texts = [(cf[:-3], open(os.path.join(cdir, cf), encoding="utf-8").read())
                         for cf in sorted(os.listdir(cdir)) if cf.endswith(".ts")]
                parsed = [(local, ct, lang_block(ct, "name")) for local, ct in texts]
                if region == "asia":
                    # El idioma real del set se decide por los nombres de sus cartas
                    cnt = {}
                    for _, _, n in parsed:
                        for k in n:
                            if k in ("ja", "ko", "zh-tw", "zh-cn", "id", "th"):
                                cnt[k] = cnt.get(k, 0) + 1
                    if cnt:
                        lang = max(cnt, key=lambda k: (cnt[k], k == "ja"))
                        # Si el propio set no tiene nombre en ese idioma (p. ej. promos indonesias), manda el nombre del set
                        if lang not in names:
                            lang = next((l for l in ("ja", "ko", "zh-tw", "zh-cn", "id", "th") if l in names), lang)
                        sets[-1]["lang"] = lang
                    rd = lang_block(txt, "releaseDate")
                    if rd:
                        sets[-1]["release"] = rd.get(lang) or min(rd.values())
                sets[-1]["name_local"] = names.get(lang) or next(iter(names.values()), None)
                img_lang = "en" if region == "int" else lang
                for local, ct, n in parsed:
                    dex = first(r"dexId:\s*\[(\d+)", ct)
                    local_name = n.get(lang) or next(iter(n.values()), None)
                    cards.append(dict(card_id=f"{set_id}-{local}", set_id=set_id, local=local,
                                      name_es=n.get("es"), name_en=n.get("en"), name_ja=n.get("ja"),
                                      rarity=(lambda r: None if r in (None, "None") else r)(first(r"\n\trarity:\s*['\"]([^'\"]+)", ct)),  # TCGdex pone "None" si no hay rareza
                                      dex=int(dex) if dex else None, name_local=local_name,
                                      illustrator=first(r"\n\tillustrator:\s*['\"]([^'\"]+)", ct),
                                      ptype=first(r"\n\ttypes:\s*\[\s*['\"]([^'\"]+)", ct),
                                      kind=first(r"\n\ttrainerType:\s*['\"]([^'\"]+)", ct) or first(r"\n\tcategory:\s*['\"]([^'\"]+)", ct),
                                      image=IMG.format(lang=img_lang, serie=serie_id, set=set_id, local=local),
                                      variants=parse_variants(ct),
                                      sig=attack_sig(ct) if region == "int" else None))
    return sets, cards


def attack_sig(ct):
    """Nombre en inglés + ataques/habilidades: identifica una ilustración entre idiomas."""
    names = [m.group(1) for m in re.finditer(r"name:\s*\{[^}]*?\ben:\s*['\"]((?:[^'\"\\]|\\.)*)['\"]", ct, re.S)]
    if not names:
        return None
    return (names[0].lower(), tuple(sorted(a.lower() for a in names[1:])))


def cm_sig(name):
    m = re.match(r"^(.*?)\s*\[(.*)\]\s*$", name or "")
    if not m:
        return None
    return (m.group(1).strip().lower(), tuple(sorted(x.strip().lower() for x in m.group(2).split("|") if x.strip())))


SCHEMA = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE sets(
  set_id TEXT PRIMARY KEY, region TEXT, serie TEXT, name_es TEXT, name_en TEXT, name_ja TEXT,
  release_date TEXT, card_count INTEGER, cm_expansion_id INTEGER, lang TEXT, name_local TEXT);
CREATE TABLE cards(
  card_id TEXT PRIMARY KEY, set_id TEXT REFERENCES sets(set_id), local_id TEXT,
  name_es TEXT, name_en TEXT, name_ja TEXT, rarity TEXT, dex_id INTEGER, image_base TEXT,
  name_local TEXT, illustrator TEXT, kind TEXT, ptype TEXT);
CREATE TABLE cm_products(
  cm_product_id INTEGER PRIMARY KEY, kind TEXT, name TEXT, category TEXT,
  cm_expansion_id INTEGER, date_added TEXT);
-- Cartas de Cardmarket sin set en TCGdex (sobre todo japonesas antiguas) cuyo ilustrador se deduce
-- porque su nombre y ataques coinciden con una carta internacional de un único ilustrador
CREATE TABLE cm_extra(
  cm_product_id INTEGER PRIMARY KEY, name TEXT, illustrator TEXT, ref_card_id TEXT, cm_expansion_id INTEGER, date_added TEXT);
CREATE INDEX idx_extra_ill ON cm_extra(illustrator COLLATE NOCASE);
CREATE TABLE card_variants(
  card_id TEXT REFERENCES cards(card_id), cm_product_id INTEGER, variant TEXT, subtype TEXT, stamp TEXT,
  ambiguous INTEGER DEFAULT 0, foil TEXT, langs TEXT);
CREATE TABLE prices(
  cm_product_id INTEGER, date TEXT, low REAL, trend REAL, avg REAL, avg1 REAL, avg7 REAL, avg30 REAL,
  low_holo REAL, trend_holo REAL, avg_holo REAL, avg1_holo REAL, avg7_holo REAL, avg30_holo REAL,
  PRIMARY KEY(cm_product_id, date));
CREATE INDEX idx_cards_set ON cards(set_id);
CREATE INDEX idx_cards_dex ON cards(dex_id);
CREATE INDEX idx_cards_ill ON cards(illustrator COLLATE NOCASE);
CREATE INDEX idx_var_card ON card_variants(card_id);
CREATE INDEX idx_var_cm ON card_variants(cm_product_id);
CREATE INDEX idx_prod_exp ON cm_products(cm_expansion_id);
CREATE INDEX idx_prices_date ON prices(date);

-- La tabla prices solo guarda el último día; el historial está en history
CREATE VIEW latest_prices AS SELECT * FROM prices;

-- Una fila por carta y variante, con nombres en español (o inglés / japonés) y precio actual
CREATE VIEW card_catalog AS
  SELECT c.card_id, c.set_id, s.region,
         COALESCE(s.name_es, s.name_en, s.name_ja) AS set_name, s.release_date,
         c.local_id, s.card_count,
         COALESCE(c.name_es, c.name_en, c.name_ja) AS name,
         c.name_en, c.name_ja, c.rarity, c.dex_id, c.image_base,
         v.cm_product_id, v.variant, v.subtype, v.stamp, v.ambiguous,
         lp.date AS price_date, lp.low, lp.trend, lp.avg7, lp.avg30, lp.trend_holo
  FROM cards c JOIN sets s USING(set_id)
  LEFT JOIN card_variants v USING(card_id)
  LEFT JOIN latest_prices lp ON lp.cm_product_id = v.cm_product_id;

-- Producto sellado con su set (cuando se conoce) y precio actual
CREATE VIEW sealed_catalog AS
  SELECT p.cm_product_id, p.name, p.category, s.set_id,
         COALESCE(s.name_es, s.name_en, s.name_ja) AS set_name,
         lp.date AS price_date, lp.low, lp.trend, lp.avg7, lp.avg30
  FROM cm_products p
  LEFT JOIN sets s ON s.set_id = (SELECT MIN(set_id) FROM sets x WHERE x.cm_expansion_id = p.cm_expansion_id)
  LEFT JOIN latest_prices lp ON lp.cm_product_id = p.cm_product_id
  WHERE p.kind = 'sealed';
"""

PRICE_FIELDS = ["low", "trend", "avg", "avg1", "avg7", "avg30",
                "low-holo", "trend-holo", "avg-holo", "avg1-holo", "avg7-holo", "avg30-holo"]


def insert_prices(db, price_file):
    d = json.load(open(price_file, encoding="utf-8"))
    date = d["createdAt"][:10]
    rows = [(p["idProduct"], date, *[p.get(f) for f in PRICE_FIELDS]) for p in d["priceGuides"]]
    db.executemany("INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    db.execute("INSERT OR REPLACE INTO meta VALUES ('prices_date', ?)", (date,))
    return date, len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tcgdex", required=True)
    ap.add_argument("--singles", required=True)
    ap.add_argument("--sealed", required=True)
    ap.add_argument("--prices", required=True)
    ap.add_argument("--out", default="9bolsillos.db")
    ap.add_argument("--history-from", help="base anterior de la que copiar el historial de precios")
    a = ap.parse_args()

    if os.path.exists(a.out):
        os.remove(a.out)
    db = sqlite3.connect(a.out)
    db.executescript(SCHEMA)

    sets, cards = load_tcgdex(a.tcgdex)
    db.executemany("INSERT OR IGNORE INTO sets VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                   [(s["set_id"], s["region"], s["serie"], s["name_es"], s["name_en"], s["name_ja"],
                     s["release"], s["count"], s["cm_exp"], s["lang"], s.get("name_local")) for s in sets])
    db.executemany("INSERT OR IGNORE INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   [(c["card_id"], c["set_id"], c["local"], c["name_es"], c["name_en"], c["name_ja"],
                     c["rarity"], c["dex"], c["image"], c["name_local"], c["illustrator"], c.get("kind"), c.get("ptype")) for c in cards])

    # Nº de Pokédex que falta en TCGdex (sobre todo sets nuevos): se copia de otra carta del mismo Pokémon
    def dex_key(n):
        n = (n or "").lower()
        n = re.sub(r"^(mega |m |radiant |dark |light |shining |alolan |galarian |hisuian |paldean |[a-z.' ]+'s )", "", n)
        n = re.sub(r"[\s-]+(ex|gx|v|vmax|vstar|v-union|break|prime|lv\.x|legend|star|δ|◇|☆|★)([\s-].*)?$", "", n)
        return re.sub(r"[^a-z0-9]", "", n)
    def ja_key(n):
        return re.sub(r"(ex|gx|vmax|vstar|v|ＧＸ|ＥＸ|\s|・)+$", "", (n or "").strip(), flags=re.I)
    known_en, known_ja = {}, {}
    try:  # lista oficial de especies de PokéAPI (nombre en inglés -> nº de Pokédex)
        import urllib.request
        req = urllib.request.Request("https://pokeapi.co/api/v2/pokemon-species?limit=2000", headers={"User-Agent": "9Bolsillos/1.0"})
        for i, sp in enumerate(json.load(urllib.request.urlopen(req, timeout=30))["results"], 1):
            known_en[re.sub(r"[^a-z0-9]", "", sp["name"])] = int(sp["url"].rstrip("/").split("/")[-1]) if sp.get("url") else i
    except Exception as e:
        print("PokéAPI no disponible:", e)
    db.execute("UPDATE cards SET dex_id = NULL WHERE kind IS NOT NULL AND kind != 'Pokemon'")   # TCGdex a veces pone nº a entrenadores antiguos
    for cid, en, ja, dex in db.execute("SELECT card_id, name_en, name_ja, dex_id FROM cards WHERE dex_id IS NOT NULL"):
        if en: known_en.setdefault(dex_key(en), dex)
        if ja: known_ja.setdefault(ja_key(ja), dex)
    fills = []
    # Solo cartas de Pokémon: un Partidario como «Cintia» o «Team Rocket» no es un Pokémon aunque se parezca a otro nombre
    for cid, en, ja in db.execute("SELECT card_id, name_en, name_ja FROM cards WHERE dex_id IS NULL AND (kind = 'Pokemon' OR kind IS NULL)").fetchall():
        d = (en and known_en.get(dex_key(en))) or (ja and known_ja.get(ja_key(ja)))
        if d: fills.append((d, cid))
    db.executemany("UPDATE cards SET dex_id=? WHERE card_id=?", fills)
    print(f"Nº de Pokédex completado en {len(fills)} cartas")

    # Variantes: un mismo id de Cardmarket asignado a varias cartas distintas = ambiguo
    owners = {}
    for c in cards:
        for cm, *_ in c["variants"]:
            owners.setdefault(cm, set()).add(c["card_id"])
    var_rows = []
    for c in cards:
        seen = set()
        for cm, t, st, stamp, foil, langs in c["variants"]:
            if (cm, t, st, stamp, foil) in seen:
                continue
            seen.add((cm, t, st, stamp, foil))
            var_rows.append((c["card_id"], cm, t, st, stamp, 1 if len(owners[cm]) > 1 else 0, foil, langs))
    db.executemany("INSERT INTO card_variants VALUES (?,?,?,?,?,?,?,?)", var_rows)

    for kind, f in (("single", a.singles), ("sealed", a.sealed)):
        prods = json.load(open(f, encoding="utf-8"))["products"]
        db.executemany("INSERT OR REPLACE INTO cm_products VALUES (?,?,?,?,?,?)",
                       [(p["idProduct"], kind, p["name"], p["categoryName"], p["idExpansion"],
                         None if p["dateAdded"].startswith("0000") else p["dateAdded"]) for p in prods])

    # Cruce por nombre + ataques para las cartas de Cardmarket que TCGdex no tiene enlazadas
    sig_ill, sig_ref = {}, {}
    for c in cards:
        if c.get("sig") and c["illustrator"]:
            sig_ill.setdefault(c["sig"], set()).add(c["illustrator"].lower())
            sig_ref.setdefault(c["sig"], (c["card_id"], c["illustrator"]))
    int_exp = {s["cm_exp"] for s in sets if s["cm_exp"] and s["region"] == "int"}
    mapped = set(owners)
    extra = []
    for p in json.load(open(a.singles, encoding="utf-8"))["products"]:
        if p["idProduct"] in mapped or p["idExpansion"] in int_exp:
            continue
        sg = cm_sig(p["name"])
        if sg and len(sig_ill.get(sg, ())) == 1:
            ref, ill = sig_ref[sg]
            extra.append((p["idProduct"], re.sub(r"\s*\[.*$", "", p["name"]), ill, ref, p["idExpansion"],
                          None if p["dateAdded"].startswith("0000") else p["dateAdded"]))
    db.executemany("INSERT OR REPLACE INTO cm_extra VALUES (?,?,?,?,?,?)", extra)
    print("Cartas extra con ilustrador deducido vía Cardmarket:", len(extra))

    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "auto"))
    sys.path.insert(1, os.path.dirname(os.path.abspath(__file__)))
    from update_prices import apply, HISTORY_SCHEMA
    if a.history_from and os.path.exists(a.history_from):
        db.executescript(HISTORY_SCHEMA)
        db.execute("ATTACH DATABASE ? AS old", (a.history_from,))
        if db.execute("SELECT 1 FROM old.sqlite_master WHERE name='history'").fetchone():
            db.execute("INSERT OR IGNORE INTO history SELECT cm_product_id, day, trend_c, trend_holo_c FROM old.history")
            print("Historial copiado:", db.execute("SELECT COUNT(DISTINCT day) FROM history").fetchone()[0], "días")
        db.commit()
        db.execute("DETACH DATABASE old")
    print(apply(db, a.prices))
    date, n = db.execute("SELECT value FROM meta WHERE key='prices_date'").fetchone()[0], db.execute("SELECT COUNT(*) FROM prices").fetchone()[0]
    db.execute("INSERT OR REPLACE INTO meta VALUES ('built_from', 'TCGdex cards-database (MIT) + Cardmarket price guide')")
    import datetime as _dt
    db.execute("INSERT OR REPLACE INTO meta VALUES ('built_at', ?)", (_dt.datetime.now(_dt.timezone.utc).strftime('%Y%m%d%H%M'),))
    db.commit()

    q = lambda s: db.execute(s).fetchone()[0]
    print(f"sets: {q('SELECT COUNT(*) FROM sets')} | cartas: {q('SELECT COUNT(*) FROM cards')} | "
          f"variantes con id Cardmarket: {q('SELECT COUNT(*) FROM card_variants')} "
          f"(ambiguas: {q('SELECT COUNT(*) FROM card_variants WHERE ambiguous=1')})")
    print(f"precios {date}: {n} | variantes con precio: "
          f"{q('SELECT COUNT(*) FROM card_catalog WHERE trend IS NOT NULL')}")
    db.close()


if __name__ == "__main__":
    main()
