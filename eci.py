import urllib.request, json
UA = {"User-Agent": "9Bolsillos/1.0 (app personal; compara precios una vez al día)", "Accept-Language": "es-ES"}
out = {}
for u in ["https://www.elcorteingles.es/robots.txt",
          "https://www.elcorteingles.es/juguetes/pokemon/",
          "https://www.elcorteingles.es/search-nwx/1/?s=pokemon+caja+entrenador+elite",
          "https://www.game.es/robots.txt", "https://www.game.es/buscar/pokemon%20tcg"]:
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=25)
        b = r.read().decode("utf-8", "replace")
        out[u] = {"status": r.status, "len": len(b), "head": b[:1500]}
    except Exception as e:
        out[u] = {"err": str(e)[:200], "body": (e.read().decode("utf-8", "replace")[:600] if hasattr(e, "read") else "")}
json.dump(out, open("eci.json", "w"), ensure_ascii=False, indent=1)
