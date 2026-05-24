"""Forecast layer for the temps app.

Primary provider: Open-Meteo's MeteoSwiss ICON API, which serves the
MeteoSwiss ICON-CH model as ready-made point forecasts (free, no key).
ICON-CH2 reaches about 5 days; beyond that the app falls back to climatology.

A second provider — the official MeteoSwiss ICON GRIB2 files — can be slotted
in later behind the same `build_forecast` interface to add raw ensemble
spread (real probabilities) and full-grid spatial coverage.

Output:
  data/forecast.json          per station, one record per forecast day
  data/hourly_forecast.json   per station, hourly cloud-cover forecast

Run after fetch.py (needs data/stations.json):
  python forecast.py
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import requests

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
MODEL = "meteoswiss_icon_ch2"
FORECAST_DAYS = 7
BATCH_SIZE = 50
DAILY_VARS = [
    "sunshine_duration",
    "daylight_duration",
    "temperature_2m_mean",
    "temperature_2m_max",
    "temperature_2m_min",
    "precipitation_sum",
]

# Hourly forecast (for the forward part of the hourly view).
HOURLY_FORECAST_DAYS = 3
HOURLY_VARS = ["cloud_cover", "cloud_cover_low", "temperature_2m", "is_day"]

# Sky-condition thresholds on the sunshine fraction (sunshine / daylight),
# matching process.py so forecast and climatology are directly comparable.
SUNNY_MIN = 0.60
PARTLY_MIN = 0.20

# Hourly sky condition from cloud cover (%), matching ensemble.py.
LOW_CLOUD_FOG_MIN = 70.0  # low cloud at/above this -> fog (no visibility)
CLOUD_SUNNY_MAX = 30.0
CLOUD_CLOUDY_MIN = 70.0

_session = requests.Session()
_session.headers.update({"User-Agent": "temps-weather-app/0.1 (forecast)"})


def _classify(sunshine_s: float | None, daylight_s: float | None) -> str:
    if sunshine_s is None or not daylight_s:
        return "unknown"
    fraction = sunshine_s / daylight_s
    if fraction >= SUNNY_MIN:
        return "sunny"
    if fraction >= PARTLY_MIN:
        return "partly_cloudy"
    return "cloudy"


def _round(value: float | None, digits: int = 1) -> float | None:
    return None if value is None else round(value, digits)


def _parse_daily(daily: dict) -> list[dict]:
    days = []
    for i, date in enumerate(daily.get("time", [])):
        sunshine = daily["sunshine_duration"][i]
        daylight = daily["daylight_duration"][i]
        condition = _classify(sunshine, daylight)
        if condition == "unknown":
            continue  # the model has no data this far out
        days.append(
            {
                "date": date,
                "condition": condition,
                "sunshine_pct": round(sunshine / daylight * 100) if daylight else None,
                "tmean": _round(daily["temperature_2m_mean"][i]),
                "tmin": _round(daily["temperature_2m_min"][i]),
                "tmax": _round(daily["temperature_2m_max"][i]),
                "precip_mm": _round(daily["precipitation_sum"][i]),
            }
        )
    return days


def fetch_open_meteo(coords: list[tuple[str, float, float]]) -> dict[str, list[dict]]:
    """coords: list of (station_id, lat, lon). Returns forecast days per station."""
    out: dict[str, list[dict]] = {}
    for start in range(0, len(coords), BATCH_SIZE):
        batch = coords[start : start + BATCH_SIZE]
        params = {
            "latitude": ",".join(f"{lat:.4f}" for _, lat, _ in batch),
            "longitude": ",".join(f"{lon:.4f}" for _, _, lon in batch),
            "daily": ",".join(DAILY_VARS),
            "models": MODEL,
            "timezone": "UTC",
            "forecast_days": FORECAST_DAYS,
        }
        resp = _session.get(OPEN_METEO_URL, params=params, timeout=60)
        resp.raise_for_status()
        payload = resp.json()
        # A single-location request returns an object, multi-location a list.
        results = payload if isinstance(payload, list) else [payload]
        for (station_id, _, _), result in zip(batch, results):
            out[station_id] = _parse_daily(result.get("daily", {}))
        time.sleep(1)
    return out


def _classify_cloud(cloud: float | None, cloud_low: float | None, is_day: int) -> str:
    if not is_day:
        return "night"
    if cloud_low is not None and cloud_low >= LOW_CLOUD_FOG_MIN:
        return "fog"
    if cloud is None:
        return "cloudy"
    if cloud <= CLOUD_SUNNY_MAX:
        return "sunny"
    if cloud >= CLOUD_CLOUDY_MIN:
        return "cloudy"
    return "partly_cloudy"


def fetch_hourly_forecast(
    coords: list[tuple[str, float, float]],
) -> dict:
    """Hourly cloud-cover forecast per station, on one shared timeline."""
    hours: list[str] | None = None
    stations: dict[str, list[dict]] = {}
    for start in range(0, len(coords), BATCH_SIZE):
        batch = coords[start : start + BATCH_SIZE]
        params = {
            "latitude": ",".join(f"{lat:.4f}" for _, lat, _ in batch),
            "longitude": ",".join(f"{lon:.4f}" for _, _, lon in batch),
            "hourly": ",".join(HOURLY_VARS),
            "models": MODEL,
            "timezone": "UTC",
            "forecast_days": HOURLY_FORECAST_DAYS,
        }
        resp = _session.get(OPEN_METEO_URL, params=params, timeout=60)
        resp.raise_for_status()
        payload = resp.json()
        results = payload if isinstance(payload, list) else [payload]
        for (station_id, _, _), result in zip(batch, results):
            h = result.get("hourly", {})
            times = h.get("time", [])
            if hours is None:
                hours = [f"{t}:00Z" for t in times]  # normalise to UTC ISO
            cloud = h.get("cloud_cover", [])
            cloud_low = h.get("cloud_cover_low", [])
            temp = h.get("temperature_2m", [])
            is_day = h.get("is_day", [])
            stations[station_id] = [
                {
                    "condition": _classify_cloud(
                        cloud[i] if i < len(cloud) else None,
                        cloud_low[i] if i < len(cloud_low) else None,
                        is_day[i] if i < len(is_day) else 1,
                    ),
                    "tmean": _round(temp[i] if i < len(temp) else None),
                }
                for i in range(len(times))
            ]
        time.sleep(1)
    return {"hours": hours or [], "stations": stations}


def build_forecast(data_dir: Path) -> dict[str, list[dict]]:
    """Build the per-station daily forecast. Swap this body for a GRIB2-based
    provider to use the official MeteoSwiss files instead."""
    stations = json.loads((data_dir / "stations.json").read_text())
    coords = [(s["id"], s["lat"], s["lon"]) for s in stations]
    return fetch_open_meteo(coords)


def build_hourly_forecast(data_dir: Path) -> dict:
    stations = json.loads((data_dir / "stations.json").read_text())
    coords = [(s["id"], s["lat"], s["lon"]) for s in stations]
    return fetch_hourly_forecast(coords)


def main() -> None:
    data_dir = Path("data")

    forecast = build_forecast(data_dir)
    (data_dir / "forecast.json").write_text(json.dumps(forecast, ensure_ascii=False))
    max_days = max((len(v) for v in forecast.values()), default=0)
    print(f"forecast.json: {len(forecast)} stations, up to {max_days} forecast days")

    hourly = build_hourly_forecast(data_dir)
    (data_dir / "hourly_forecast.json").write_text(
        json.dumps(hourly, ensure_ascii=False)
    )
    print(
        f"hourly_forecast.json: {len(hourly['stations'])} stations, "
        f"{len(hourly['hours'])} hours"
    )


if __name__ == "__main__":
    main()
