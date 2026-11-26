import json, urllib.request, time
UA = {"User-Agent": "9Bolsillos/1.0 (uso personal)", "Accept": "application/json"}
out = {}
for chid in ("vnd1_ja", "vnd2_ja", "vnd3_ja", "miscp_ja"):
    try:
        d = json.load(urllib.request.urlopen(urllib.request.Request(f"https://www.collectholo.com/api/sets/{chid}/binder", headers=UA), timeout=40))
        out[chid] = [{k: c.get(k) for k in ("number", "name", "name_en", "smallImageUrl", "artist", "illustrator", "isDefaultVariant")} for c in d.get("cards", [])]
        if out[chid]: out[chid + "_keys"] = list(d["cards"][0].keys())
    except Exception as e:
        out[chid] = str(e)
    time.sleep(5)
json.dump(out, open("komiya.json", "w"), ensure_ascii=False, indent=0)
