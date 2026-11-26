import json, re, time, urllib.request, html
UA = {"User-Agent": "9Bolsillos/1.0 (app personal; compara precios una vez al día)"}
doms = ["metamorphcenter.com","cardzone.es","iberiancollect.com","tcg-collection.com","centraltcg.com","pokezilla.com","allintcg.com","grillecards.com","pokedealtcg.es","pokemillon.es","ryucards.es","todohits.com","unsobremas.com","tcglevel.com","elbazartcg.com","darizard9.com","alfriki.com","jjcollection.es","sunnystore.es","toyplanet.com"]
out = {}
for d in doms:
    x = {}
    for path in ("/policies/shipping-policy", "/pages/envios", "/pages/envio", "/pages/envios-y-devoluciones", "/pages/gastos-de-envio"):
        try:
            b = urllib.request.urlopen(urllib.request.Request(f"https://{d}{path}", headers=UA), timeout=20).read().decode("utf-8", "replace")
            t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", b, flags=re.S)
            t = html.unescape(re.sub(r"<[^>]+>", " ", t)); t = re.sub(r"\s+", " ", t)
            hits = [m.group(0) for m in re.finditer(r"[^.]{0,140}(env[ií]o|gratis|pen[ií]nsula|€)[^.]{0,140}", t, re.I) if "€" in m.group(0) or re.search(r"gratis", m.group(0), re.I)]
            if hits:
                x[path] = hits[:12]
        except Exception as e:
            pass
        time.sleep(1)
    out[d] = x
json.dump(out, open("envios.json", "w"), ensure_ascii=False, indent=1)
