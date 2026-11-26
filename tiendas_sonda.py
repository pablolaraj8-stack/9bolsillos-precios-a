import json, urllib.request, re
UA = {"User-Agent": "9Bolsillos/1.0 (app personal; comparador de precios para uso propio)", "Accept": "application/json"}
doms = """metamorphcenter.com cardzone.es iberiancollect.com tcg-collection.com centraltcg.com pokezilla.com rezatcg.es
allintcg.com allintcg.es battledeck.es checollect.com checollect.es factorycards.es flashstore.es geekkaos.com grillecards.com grillecards.es
manavortex.es manavortex.com pokedealtcg.com pokedealtcg.es pokemillon.com pokemillon.es ryucards.com ryucards.es shinyhit.es shinyhit.com
todohits.com todohits.es unsobremas.com unsobremas.es tcglevel.com tcglevel.es thecardstation.es thecardstation.com epichitstore.com epichitstore.es
elbazartcg.com elbazartcg.es darizard9.com darizard9.es dondino.es alfriki.com alfriki.es jjcollection.es sunnystore.es chewecenter.com chewecenter.es
frikidenacimiento.com elrincondelgachapon.com toyplanet.com dracotienda.com generacionx.es valhallagames.es""".split()
out = {}
def get(u, js=True):
    r = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=20)
    b = r.read()
    return json.loads(b) if js else b.decode("utf-8", "replace")
for d in doms:
    x = {}
    try:
        m = get(f"https://{d}/meta.json"); x["meta"] = {k: m.get(k) for k in ("name", "currency", "country", "url", "myshopify_domain")}
    except Exception as e:
        x["meta_err"] = str(e)[:80]
    try:
        p = get(f"https://{d}/products.json?limit=250")
        ps = p.get("products", [])
        x["n"] = len(ps)
        x["poke"] = [ (q["title"], q["variants"][0]["price"], q["variants"][0].get("available")) for q in ps if re.search(r"entrenador|etb|caja de sobres|booster|bundle|lata", q["title"], re.I)][:6]
    except Exception as e:
        x["pj_err"] = str(e)[:80]
    try:
        rb = get(f"https://{d}/robots.txt", js=False)
        x["robots_products"] = [l for l in rb.splitlines() if "products" in l.lower() or l.lower().startswith("user-agent: *")][:8]
    except Exception as e:
        x["robots_err"] = str(e)[:60]
    out[d] = x
json.dump(out, open("tiendas.json", "w"), ensure_ascii=False, indent=1)
