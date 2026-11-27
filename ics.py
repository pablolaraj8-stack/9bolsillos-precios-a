"""Calendario de lanzamientos en España (app/calendario.js) en formato .ics para suscribirse desde el iPhone."""
import json, re, sys
from datetime import date, datetime, timedelta, timezone

txt = open('app/calendario.js', encoding='utf-8').read()
m = re.search(r'=\s*(\[.*\])\s*;?\s*$', txt, re.S)
try:
    E = json.loads(m.group(1))
except Exception:
    E = [json.loads(x) for x in re.findall(r'\{[^{}]*\}', txt)]
now = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
esc = lambda s: str(s).replace('\\', '\\\\').replace(',', '\\,').replace(';', '\\;').replace('\n', '\\n')
L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//9Bolsillos//Lanzamientos//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
     'X-WR-CALNAME:Pokémon TCG · lanzamientos en España', 'X-WR-TIMEZONE:Europe/Madrid', 'REFRESH-INTERVAL;VALUE=DURATION:PT12H', 'X-PUBLISHED-TTL:PT12H']
for e in E:
    if e.get('idioma') != 'es' or not e.get('fecha'):
        continue
    d = date.fromisoformat(e['fecha'])
    L += ['BEGIN:VEVENT', f"UID:{esc(e.get('id') or e['fecha'])}@9bolsillos", f'DTSTAMP:{now}',
          f"DTSTART;VALUE=DATE:{d:%Y%m%d}", f"DTEND;VALUE=DATE:{d + timedelta(days=1):%Y%m%d}",
          f"SUMMARY:{esc('Sale ' + e.get('nombre', 'nuevo set'))}",
          f"DESCRIPTION:{esc(' · '.join(x for x in [e.get('codigo'), e.get('nota')] if x) or 'Lanzamiento de Pokémon TCG en España')}",
          'BEGIN:VALARM', 'ACTION:DISPLAY', f"DESCRIPTION:{esc('Mañana sale ' + e.get('nombre', ''))}", 'TRIGGER:-PT12H', 'END:VALARM', 'END:VEVENT']
L.append('END:VCALENDAR')
open(sys.argv[1] if len(sys.argv) > 1 else 'lanzamientos.ics', 'w', encoding='utf-8', newline='').write('\r\n'.join(L) + '\r\n')
print('Calendario:', sum(1 for x in L if x == 'BEGIN:VEVENT'), 'lanzamientos')
