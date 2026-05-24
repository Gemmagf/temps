# El Temps · Suïssa

Aplicació web del temps a Suïssa que combina:

- Observacions de la xarxa **SwissMetNet** (158 estacions automàtiques de MeteoSwiss).
- Predicció determinista del model **ICON-CH2** via Open-Meteo (5 dies, també horària).
- Probabilitats reals de l'*ensemble* oficial de 21 membres llegint directament els
  **GRIB2** d'ICON-CH2-EPS publicats per MeteoSwiss.
- **Climatologia** històrica homogeneïtzada (1996–2025) per als horitzons llargs.
- Recomanador d'activitats segons el temps via la **Overpass API d'OpenStreetMap**.
- Mapa base de **swisstopo**.

## Estructura

- `fetch.py` — descarrega les dades de l'API STAC de MeteoSwiss (SwissMetNet).
- `process.py` — converteix les observacions en condicions de cel + climatologia.
- `forecast.py` — predicció Open-Meteo (model MeteoSwiss ICON, deterministic).
- `ensemble.py` — descarrega + processa els GRIB2 de l'*ensemble* ICON-CH2-EPS
  (21 membres, k-d tree per matchar estacions a la graella icosaèdrica).
- `web/` — frontend React + TypeScript + MapLibre.
- `.github/workflows/` — Actions per refrescar les dades automàticament.

## Desenvolupament local

```
python -m venv .venv && .venv/bin/pip install -r requirements.txt
python fetch.py --period recent
python fetch.py --period historical
python fetch.py --resolution h --period recent
python fetch.py --resolution h --period now
python process.py
python forecast.py
python ensemble.py

cp data/*.json web/public/data/
cd web && npm install && npm run dev
```

## Desplegament

- **Netlify** servei estàtic, connectat al repo. `netlify.toml` configura la
  build (`cd web && npm ci && npm run build`).
- **GitHub Actions** refresca les dades:
  - `data-hourly.yml` — cada hora: observacions + predicció determinista.
  - `data-ensemble.yml` — cada 6 hores: GRIB2 ICON-CH2-EPS (~5 min/run).
- Cada commit de dades fa que Netlify torni a desplegar la web.

## Fonts

Tot dades obertes, gratuïtes i sense clau:

- MeteoSwiss Open Data (STAC API).
- Open-Meteo MeteoSwiss ICON API.
- OpenStreetMap (Overpass API).
- swisstopo (vector tiles).
