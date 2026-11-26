import urllib.request, os
os.makedirs("kom", exist_ok=True)
for n in ["vnd1_ja-13","vnd2_ja-109","vnd3_ja-117","vnd3_ja-67","vnd3_ja-112","miscp_ja-46","miscp_ja-78","miscp_ja-123"]:
    d = urllib.request.urlopen(urllib.request.Request(f"https://images.collectholo.com/product/cards-jp/{n}/small.webp", headers={"User-Agent": "9Bolsillos/1.0"}), timeout=30).read()
    open(f"kom/{n}.webp", "wb").write(d)
