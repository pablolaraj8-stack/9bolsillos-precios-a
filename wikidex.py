"""Quién es o dónde está: resumen de WikiDex para las cartas de Partidario y Estadio de los sets en español.

  python3 wikidex.py --db 9bolsillos.db --prev entrenadores_prev.json --out entrenadores.json

Usa la API pública de WikiDex (MediaWiki), despacio (1 petición por segundo) y guardando lo ya descargado:
cada día solo se piden los nombres nuevos y, una vez al mes, los que no se encontraron.
Licencia del texto: CC BY-NC-SA (WikiDex); la app enlaza siempre a la página original.
"""
import argparse, datetime, json, re, sqlite3, time, unicodedata, urllib.parse, urllib.request

API = "https://www.wikidex.net/api.php"
UA = {"User-Agent": "9Bolsillos/1.0 (app personal de coleccion Pokemon; github.com/pablolaraj8-stack/9bolsillos-precios-a)"}
PERSONA = re.compile(r"personaje|líder|alto mando|campe[oó]n|profesor|investigador|entrenador|rival|protagonista|ejecutiv|organizaci[oó]n|kahuna|capit[aá]n|jefe|clase de entrenador", re.I)
VERSION = 2   # súbelo si cambian las reglas: se vuelve a pedir todo
fold = lambda t: re.sub(r"[^a-z0-9 ]", "", unicodedata.normalize("NFD", t.lower()).encode("ascii", "ignore").decode())
LUGAR = re.compile(r"situad|ubicad|regi[oó]n|ciudad|pueblo|lugar|edificio|torre|estadio|isla|zona|bosque|monte|gimnasio|cueva|ruta|templo|academia|santuario|ruinas|lago|playa|mar", re.I)


def api(params, fetch=None):
    url = API + "?" + urllib.parse.urlencode(dict(params, format="json", formatversion=2))
    if fetch:
        return fetch(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return json.loads(r.read())


def candidates(name, kind):
    """Páginas de WikiDex que pueden ser el personaje o el lugar de la carta, de más a menos probable."""
    c = [(name, False)]
    m = re.match(r"(.+?) del? (Team|Equipo) .+$", name)
    if m:
        c.append((m.group(1), True))                   # Atenea del Team Rocket -> Atenea
    if " de " in name or " del " in name:
        c.append((re.split(r" del? ", name)[-1], True))  # Ambición de Cintia -> Cintia; Amigos de Galar -> Galar
    return c


def fetch_pages(titles, fetch=None, pause=1.0):
    out = {}
    for i in range(0, len(titles), 20):
        chunk = titles[i:i + 20]
        d = api({"action": "query", "titles": "|".join(chunk), "prop": "extracts|pageprops", "exintro": 1,
                 "explaintext": 1, "exlimit": 20, "redirects": 1}, fetch)
        q = d.get("query", {})
        alias = {}
        for n in q.get("normalized", []) + q.get("redirects", []):
            alias[n["from"]] = n["to"]
        pages = {p["title"]: p for p in q.get("pages", [])}
        for t in chunk:
            tt = t
            while tt in alias and alias[tt] != tt:
                tt = alias[tt]
            p = pages.get(tt)
            if p and not p.get("missing") and "disambiguation" not in (p.get("pageprops") or {}) and p.get("extract"):
                if set(fold(t).split()) & set(fold(p["title"]).split()):   # una redirección a algo sin relación no vale
                    out[t] = {"title": p["title"], "extract": p["extract"]}
        if pause:
            time.sleep(pause)
    return out


def summarize(extract, limit=420):
    txt = re.sub(r"\s+", " ", extract.split("\n")[0]).strip()
    if len(txt) > limit:
        cut = txt[:limit].rsplit(". ", 1)[0]
        txt = cut + "." if len(cut) > 80 else txt[:limit].rsplit(" ", 1)[0] + "…"
    return txt


def region_of(txt):
    m = re.search(r"regi[oó]n de ([A-ZÁÉÍÓÚ][\wáéíóúñ]+)", txt)
    return m.group(1) if m else None


def build(names, prev, fetch=None, pause=1.0, today=None):
    today = today or datetime.date.today().isoformat()
    month_ago = (datetime.date.fromisoformat(today) - datetime.timedelta(days=30)).isoformat()
    out, todo = {"_v": VERSION}, {}
    if prev.get("_v") != VERSION:
        prev = {}
    for name, kind in names.items():
        p = prev.get(name)
        if p and (not p.get("miss") or p["miss"] > month_ago):
            out[name] = p
        else:
            todo[name] = kind
    titles = sorted({t for n, k in todo.items() for t, _ in candidates(n, k)})
    pages = fetch_pages(titles, fetch, pause) if titles else {}
    for name, kind in todo.items():
        hit = None
        for t, loose in candidates(name, kind):
            pg = pages.get(t)
            if not pg:
                continue
            x = pg["extract"]
            if "carta de Entrenador" in x[:200]:   # la página es la de la propia carta, no la del personaje
                continue
            region = re.search(r"\bes una regi[oó]n", x[:150])
            ok = (PERSONA.search(x[:300]) or region) if kind == "Supporter" else (LUGAR.search(x[:300]) or PERSONA.search(x[:300]))
            if not ok:
                continue
            is_place = kind == "Stadium" and not re.search(r"personaje", x[:200], re.I) or bool(re.search(r"\bes (una|un) (regi[oó]n|ciudad|isla|zona|pueblo|lugar)", x[:150]))
            txt = summarize(x)
            hit = {"k": "l" if is_place else "p", "t": pg["title"], "x": txt, "r": region_of(txt)}
            break
        out[name] = hit or {"miss": today}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--prev")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    prev = {}
    if a.prev:
        try:
            prev = json.load(open(a.prev, encoding="utf-8"))
        except Exception:
            prev = {}
    db = sqlite3.connect(a.db)
    names = dict(db.execute("""SELECT c.name_es, c.kind FROM cards c JOIN sets s USING(set_id)
        WHERE s.lang = 'es' AND c.kind IN ('Supporter', 'Stadium') AND c.name_es IS NOT NULL GROUP BY c.name_es"""))
    try:
        res = build(names, prev)
    except Exception as e:   # si WikiDex no responde, se conserva lo de ayer
        print("WikiDex no ha respondido:", e)
        res = dict({n: prev[n] for n in names if n in prev}, _v=prev.get("_v"))
    json.dump(res, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    found = sum(1 for k, v in res.items() if k != "_v" and not v.get("miss"))
    print(f"Partidarios y estadios: {len(names)} · con descripción: {found}")


if __name__ == "__main__":
    main()
