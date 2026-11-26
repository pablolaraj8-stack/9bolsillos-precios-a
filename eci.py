import urllib.request, gzip, re, json
UA = {"User-Agent": "9Bolsillos/1.0 (app personal; compara precios una vez al día)", "Accept-Language": "es-ES", "Accept-Encoding": "gzip"}
def get(u):
    r = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=25)
    b = r.read()
    try: b = gzip.decompress(b)
    except Exception: pass
    return r.status, b.decode("utf-8", "replace")
out = {}
for u in ["https://www.elcorteingles.es/pokemon/juguetes/juegos-de-mesa/",
          "https://www.elcorteingles.es/juguetes/A203815789-caja-de-entrenador-elite-dominio-delta-de-jcc-pokemon-bandai/",
          "https://www.elcorteingles.es/juguetes/A201235760-caja-de-entrenador-elite-oscuridad-absoluta-pokemon-jcc-bandai/"]:
    try:
        st, t = get(u)
        lds = re.findall(r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>', t, re.S)
        links = sorted(set(re.findall(r'href="(/juguetes/A\d+-[^"]+)"', t)))
        prices = re.findall(r'"(?:price|sale_price|final_price|promotional_price)"\s*:\s*"?([\d.,]+)', t)[:8]
        out[u] = {"status": st, "len": len(t), "ld": [x[:1500] for x in lds][:3], "links": links[:60], "prices": prices,
                  "avail": re.findall(r'(InStock|OutOfStock|SoldOut|agotad\w*)', t)[:5]}
    except Exception as e:
        out[u] = {"err": str(e)}
json.dump(out, open("eci.json", "w"), ensure_ascii=False, indent=1)
