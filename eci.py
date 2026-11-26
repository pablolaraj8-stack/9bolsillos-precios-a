import urllib.request, gzip
UA = {"User-Agent": "9Bolsillos/1.0 (app personal; compara precios una vez al día)", "Accept-Language": "es-ES", "Accept-Encoding": "gzip"}
for name, u in [("eci_cat.html", "https://www.elcorteingles.es/juguetes/pokemon/"),
                ("eci_cat2.html", "https://www.elcorteingles.es/juguetes/juegos-de-cartas-coleccionables/")]:
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=25)
        b = r.read()
        try: b = gzip.decompress(b)
        except Exception: pass
        open(name, "wb").write(f"STATUS {r.status} URL {r.url}\n".encode() + b)
    except Exception as e:
        open(name, "w").write(str(e))
