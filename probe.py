import json, sqlite3, re, urllib.request, urllib.parse, concurrent.futures as cf, time, sys
UA = {"User-Agent": "9Bolsillos/1.0 (uso personal)"}
def get(u, js=True, method="GET"):
    r = urllib.request.urlopen(urllib.request.Request(u, headers=UA, method=method), timeout=30)
    return json.load(r) if js else r.status
rep = {}
db = sqlite3.connect("9bolsillos.db")
fb = {}
try:
    t = open("logos.js").read(); m = re.search(r"window\.IMG_FB = (\{.*?\});", t); fb = json.loads(m.group(1)) if m else {}
except Exception as e: rep["fb_err"] = str(e)
rows = db.execute("SELECT c.card_id, c.image_base, s.set_id, s.lang, s.name_es, s.name_en, s.name_local, s.release_date, s.region FROM cards c JOIN sets s USING(set_id)").fetchall()
def head(r):
    if r[0] in fb or not r[1]: return None
    try:
        get(r[1] + "/low.webp", js=False, method="HEAD"); return None
    except Exception as e: return r
with cf.ThreadPoolExecutor(48) as ex: miss = [x for x in ex.map(head, rows) if x]
by = {}
for r in miss: by.setdefault(r[2], {"lang": r[3], "name": r[4] or r[5] or r[6], "date": r[7], "region": r[8], "n": 0, "ej": []}); by[r[2]]["n"] += 1; by[r[2]]["ej"].append(r[0]) if len(by[r[2]]["ej"]) < 3 else None
tot = {}
for r in rows: tot[r[2]] = tot.get(r[2], 0) + 1
for k in by: by[k]["total"] = tot[k]
rep["cards_total"] = len(rows); rep["cards_missing"] = len(miss); rep["missing_by_set"] = by
try:
    s = json.load(open("sellado.json")); rep["sellado_sin"] = {k: db.execute("select name_es, release_date from sets where set_id=?", (k,)).fetchone() for k, v in s.items() if k != "_v" and not v.get("fotos")}
    rep["sellado_con"] = sum(1 for k, v in s.items() if k != "_v" and v.get("fotos"))
except Exception as e: rep["sellado_err"] = str(e)
def tryit(name, f):
    try: rep[name] = f()
    except Exception as e: rep[name] = "ERR " + str(e)[:200]
tryit("ch_ja_sets", lambda: [{k: x.get(k) for k in ("id", "name", "name_en", "release_date", "total", "code")} for x in get("https://www.collectholo.com/api/sets?lang=ja").get("sets", [])])
tryit("ch_es_count", lambda: len(get("https://www.collectholo.com/api/sets?lang=es").get("sets", [])))
tryit("ptcgio", lambda: get("https://api.pokemontcg.io/v2/sets?pageSize=2"))
tryit("bulba", lambda: get("https://archives.bulbagarden.net/w/api.php?" + urllib.parse.urlencode({"action": "query", "list": "search", "srsearch": "Chaos Rising Elite Trainer Box", "srnamespace": 6, "format": "json"})))
json.dump(rep, open("report.json", "w"), ensure_ascii=False, indent=1, default=str)
print(rep["cards_missing"], "missing of", rep["cards_total"])
