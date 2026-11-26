import urllib.request
UA = {"User-Agent": "9Bolsillos/1.0 (app personal; compara precios una vez al día)", "Accept-Language": "es-ES"}
for name, u in [("eci_robots.txt", "https://www.elcorteingles.es/robots.txt"),
                ("eci_search.html", "https://www.elcorteingles.es/search-nwx/1/?s=pokemon+caja+entrenador+elite")]:
    try:
        open(name, "wb").write(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=25).read())
    except Exception as e:
        open(name, "w").write(str(e))
