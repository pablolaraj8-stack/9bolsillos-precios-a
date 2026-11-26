"""El Corte Inglés: producto sellado de Pokémon (JCC) con su precio y si hay stock.

Solo páginas que su robots.txt permite (listados de la marca y fichas de producto; el buscador no),
una petición cada pocos segundos. El precio y el stock salen del bloque schema.org de cada ficha.
"""
import gzip, json, re, time, urllib.request

BASE = "https://www.elcorteingles.es"
UA = {"User-Agent": "9Bolsillos/1.0 (app personal; mira el stock unas pocas veces al día; github.com/pablolaraj8-stack/9bolsillos-precios-a)",
      "Accept-Language": "es-ES", "Accept-Encoding": "gzip"}
LISTADOS = ["/marcas/pokemon/juguetes/", "/pokemon/juguetes/juegos-de-mesa/",
            "/juguetes/kidults/juegos-de-mesa-para-adultos/cartas-coleccionables/"]
JCC = re.compile(r"jcc|tcg|cartas?|entrenador|sobre|blister|bl%C3%ADster|lata|coleccion|booster|combina", re.I)


def _get(path, pausa=2.5):
    url = path if path.startswith("http") else BASE + path
    r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30)
    b = r.read()
    try:
        b = gzip.decompress(b)
    except Exception:
        pass
    time.sleep(pausa)
    return b.decode("utf-8", "replace")


def fichas():
    """Direcciones de las fichas de producto de Pokémon JCC que salen en los listados."""
    vistas = []
    for lst in LISTADOS:
        for page in range(1, 6):
            try:
                html = _get(lst if page == 1 else f"{lst}{page}/")
            except Exception:
                break
            nuevas = [l for l in dict.fromkeys(re.findall(r'href="(/juguetes/A\d+-[^"]+/)"', html))
                      if "pokemon" in l and JCC.search(l) and l not in vistas]
            if not nuevas:
                break
            vistas += nuevas
    return vistas


def producto(path):
    html = _get(path)
    for raw in re.findall(r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>', html, re.S):
        try:
            d = json.loads(raw)
        except Exception:
            continue
        if isinstance(d, dict) and d.get("@type") == "Product":
            of = d.get("offers") or {}
            if isinstance(of, list):
                of = of[0] if of else {}
            try:
                precio = float(of.get("price"))
            except Exception:
                return None
            return {"t": d.get("name") or "", "p": round(precio, 2),
                    "a": "InStock" in str(of.get("availability", "")) or "PreOrder" in str(of.get("availability", "")),
                    "u": d.get("url") or BASE + path, "id": re.search(r"/A(\d+)-", path).group(1)}
    return None


def productos():
    out = []
    for f in fichas():
        try:
            p = producto(f)
        except Exception:
            p = None
        if p:
            out.append(p)
    return out


if __name__ == "__main__":
    for p in productos():
        print(("STOCK " if p["a"] else "agot. ") + f'{p["p"]:>7.2f} € {p["t"]}')
