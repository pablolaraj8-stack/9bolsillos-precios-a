[README.md](https://github.com/user-attachments/files/35295780/README.md)
# Precios diarios automáticos para 9Bolsillos

Cada madrugada, GitHub descarga la guía de precios de Pokémon de Cardmarket, la añade a `9bolsillos.db` y guarda la base actualizada en la release **datos** del repositorio. No necesitas tener el ordenador encendido.

## Puesta en marcha (unos 10 minutos, solo una vez)

1. **Crea un repositorio privado** en GitHub, por ejemplo `9bolsillos-datos`.
2. **Sube estos archivos** manteniendo las carpetas:
   - `update_prices.py`
   - `.github/workflows/precios-diarios.yml`
3. **Consigue el enlace de descarga:** entra en `https://www.cardmarket.com/es/Pokemon/Data/Price-Guide`, haz clic derecho en el enlace de descarga de los singles de Pokémon y elige **"Copiar dirección del enlace"**.
4. **Pega el enlace** en `precios-diarios.yml`, en la línea `PRICE_GUIDE_URL`, en lugar de `PEGA_AQUI_EL_ENLACE`.
5. **Crea la release con la base de datos inicial:** en el repositorio, ve a *Releases → Draft a new release*, ponle como etiqueta `datos` (exactamente así), adjunta el archivo `9bolsillos.db` y publícala.
6. **Pruébalo:** ve a *Actions → Precios diarios de Cardmarket → Run workflow*. Si sale en verde, ya está. Si no, abre la ejecución y mira el paso que falla.

A partir de ahí se ejecuta solo cada día. La base actualizada siempre está en *Releases → datos → 9bolsillos.db*.

## Qué hace con el historial

- Guarda **un precio por día durante los últimos 90 días**.
- Más atrás conserva **solo el del lunes de cada semana**, para que la base no crezca sin control.
- Si un día la guía no ha cambiado (misma fecha), no hace nada.

Para cambiar los 90 días, añade `--keep-daily 180` (por ejemplo) en el paso "Añadir precios" del workflow.

## Si algo falla

- **Falla "Descargar la guía de precios":** el enlace ha caducado o requiere iniciar sesión. Vuelve a copiarlo de la web (paso 3) y pégalo de nuevo.
- **Falla "Añadir precios" con "el archivo de precios no es válido":** Cardmarket ha devuelto otra cosa (una página de error, por ejemplo). Mismo arreglo: revisa el enlace.
- **Falla "Descargar la base de datos actual":** no existe la release `datos` o no tiene el archivo `9bolsillos.db` (paso 5).

GitHub te avisa por email si una ejecución falla.
