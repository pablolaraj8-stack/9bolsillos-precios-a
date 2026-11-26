import eci, re, traceback
for lst in eci.LISTADOS:
    try:
        h = eci._get(lst)
        ls = re.findall(r'href="(/juguetes/A\d+-[^"]+/)"', h)
        print(lst, len(h), len(ls), ls[:3], h[:120].replace("\n", " "))
    except Exception as e:
        print(lst, "ERR", repr(e)[:200])
