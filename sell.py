import json, urllib.request, hashlib, os
s = json.load(open("sellado_in.json")); os.makedirs("sell", exist_ok=True)
for sid in ("swsh9", "sv08", "sm3"):
    for f in s.get(sid, {}).get("fotos", []):
        n = hashlib.md5(f["u"].encode()).hexdigest()[:16] + os.path.splitext(f["u"].split("?")[0])[1].lower()
        try:
            open("sell/" + n, "wb").write(urllib.request.urlopen(urllib.request.Request(f["u"], headers={"User-Agent": "9Bolsillos/1.0"}), timeout=30).read())
        except Exception as e:
            print(e)
