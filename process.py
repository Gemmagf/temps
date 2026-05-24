"""Turn raw MeteoSwiss measurements into data the web frontend can render.

Reads the CSVs downloaded by fetch.py and produces:

  data/conditions.json   latest observed sky condition per station (the map)
  data/climatology.json  per station, per day-of-year: probability of each
                          sky condition + temperature stats (the far end of
                          the 3-week timeline, where only climatology applies)
  data/hourly.json        recent hourly observations per station, aligned to
                          one shared list of timestamps (the hourly view)

Daily sky condition is derived from `sremaxdv` — sunshine duration as a
percentage of the astronomically possible maximum for that day. The hourly
view uses `sre000h0` plus a solar-elevation calculation to mark night hours.

Run fetch.py first:
  python fetch.py --period recent
  python fetch.py --period historical
  python fetch.py --resolution h --period recent
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

import meteoswiss as ms

# Sky condition thresholds on sremaxdv (% of possible sunshine).
SUNNY_MIN = 60.0
PARTLY_MIN = 20.0
CONDITIONS = ("sunny", "partly_cloudy", "cloudy")

# Climatology baseline: a moving recent window, not the full record, so the
# warming trend does not bias the "normal" downwards.
CLIMATOLOGY_FROM_YEAR = 1996
# Each day-of-year aggregates observations within +/- this many days.
SMOOTH_WINDOW = 7

# How many recent hours the hourly breakdown covers.
HOURLY_WINDOW_HOURS = 72


def classify(sremaxdv: pd.Series) -> pd.Series:
    """Map sunshine percentage to a sky condition (NaN -> dropped later)."""
    return pd.cut(
        sremaxdv,
        bins=[-np.inf, PARTLY_MIN, SUNNY_MIN, np.inf],
        labels=["cloudy", "partly_cloudy", "sunny"],
    )


def _station_ids(raw_dir: Path) -> list[str]:
    return sorted(p.name for p in raw_dir.iterdir() if p.is_dir())


def build_current_conditions(data_dir: Path) -> list[dict]:
    """Latest observed day per station from the 'recent' files."""
    raw = data_dir / "raw"
    records = []
    for station in _station_ids(raw):
        path = raw / station / f"ogd-smn_{station}_d_recent.csv"
        if not path.exists():
            continue
        df = ms.load_measurements(path)
        df = df[df["sremaxdv"].notna()]
        if df.empty:
            continue
        last = df.sort_values("reference_timestamp").iloc[-1]
        records.append(
            {
                "id": station,
                "date": last["reference_timestamp"].date().isoformat(),
                "condition": str(classify(pd.Series([last["sremaxdv"]])).iloc[0]),
                "sunshine_pct": round(float(last["sremaxdv"]), 1),
                "precip_mm": _opt(last.get("rre150d0")),
                "tmean": _opt(last.get("tre200d0")),
                "tmin": _opt(last.get("tre200dn")),
                "tmax": _opt(last.get("tre200dx")),
            }
        )
    return records


def build_climatology(data_dir: Path) -> dict[str, list[dict]]:
    """Per station: 366 day-of-year records of condition probabilities."""
    raw = data_dir / "raw"
    out: dict[str, list[dict]] = {}
    for station in _station_ids(raw):
        path = raw / station / f"ogd-smn_{station}_d_historical.csv"
        if not path.exists():
            continue
        df = ms.load_measurements(path)
        df = df[df["sremaxdv"].notna()].copy()
        df = df[df["reference_timestamp"].dt.year >= CLIMATOLOGY_FROM_YEAR]
        if df.empty:
            continue
        df["doy"] = df["reference_timestamp"].dt.dayofyear
        df["condition"] = classify(df["sremaxdv"])
        out[station] = _doy_climatology(df)
    return out


def _doy_climatology(df: pd.DataFrame) -> list[dict]:
    days = []
    for doy in range(1, 367):
        window = _circular_doy_mask(df["doy"], doy, SMOOTH_WINDOW)
        sample = df[window]
        if sample.empty:
            continue
        counts = sample["condition"].value_counts(normalize=True)
        days.append(
            {
                "doy": doy,
                "sunny": round(float(counts.get("sunny", 0.0)), 3),
                "partly_cloudy": round(float(counts.get("partly_cloudy", 0.0)), 3),
                "cloudy": round(float(counts.get("cloudy", 0.0)), 3),
                "tmean": _opt(sample["tre200d0"].mean()),
                "tmean_p10": _opt(sample["tre200d0"].quantile(0.10)),
                "tmean_p90": _opt(sample["tre200d0"].quantile(0.90)),
                "n": int(len(sample)),
            }
        )
    return days


def _circular_doy_mask(doy: pd.Series, center: int, window: int) -> pd.Series:
    """Day-of-year distance, wrapping around the new year."""
    diff = (doy - center).abs()
    wrapped = np.minimum(diff, 366 - diff)
    return wrapped <= window


def _opt(value) -> float | None:
    """JSON-safe float, or None for missing values."""
    if value is None or pd.isna(value):
        return None
    return round(float(value), 1)


def solar_elevation(lat: float, lon: float, when: pd.DatetimeIndex) -> np.ndarray:
    """Sun elevation above the horizon (degrees) for UTC timestamps (NOAA)."""
    doy = when.dayofyear.to_numpy()
    hour = when.hour.to_numpy() + when.minute.to_numpy() / 60.0
    gamma = 2 * np.pi / 365 * (doy - 1 + (hour - 12) / 24)
    eqtime = 229.18 * (
        0.000075
        + 0.001868 * np.cos(gamma)
        - 0.032077 * np.sin(gamma)
        - 0.014615 * np.cos(2 * gamma)
        - 0.040849 * np.sin(2 * gamma)
    )
    decl = (
        0.006918
        - 0.399912 * np.cos(gamma)
        + 0.070257 * np.sin(gamma)
        - 0.006758 * np.cos(2 * gamma)
        + 0.000907 * np.sin(2 * gamma)
        - 0.002697 * np.cos(3 * gamma)
        + 0.00148 * np.sin(3 * gamma)
    )
    true_solar = hour * 60 + eqtime + 4 * lon
    hour_angle = np.radians(true_solar / 4 - 180)
    lat_r = np.radians(lat)
    cos_zenith = np.sin(lat_r) * np.sin(decl) + np.cos(lat_r) * np.cos(decl) * np.cos(
        hour_angle
    )
    return 90 - np.degrees(np.arccos(np.clip(cos_zenith, -1.0, 1.0)))


def classify_hour(sunshine_min: float, elevation: float) -> str:
    """Sky condition for a single hour; 'night' when the sun is down."""
    if elevation < -0.5:
        return "night"
    if pd.isna(sunshine_min):
        return "cloudy"
    fraction = sunshine_min / 60.0
    if fraction >= 0.6:
        return "sunny"
    if fraction >= 0.2:
        return "partly_cloudy"
    return "cloudy"


def _load_coords(data_dir: Path) -> dict[str, tuple[float, float]]:
    stations = json.loads((data_dir / "stations.json").read_text())
    return {s["id"]: (s["lat"], s["lon"]) for s in stations}


def build_hourly(data_dir: Path, coords: dict[str, tuple[float, float]]) -> dict:
    """Recent hourly observations, aligned to one shared list of timestamps."""
    raw = data_dir / "raw"
    frames: dict[str, pd.DataFrame] = {}
    for station in _station_ids(raw):
        if station not in coords:
            continue
        # "recent" reaches yesterday; "now" adds today's hours so the view
        # stays current up to the latest measured hour.
        parts = [
            ms.load_measurements(raw / station / f"ogd-smn_{station}_h_{period}.csv")
            for period in ("recent", "now")
            if (raw / station / f"ogd-smn_{station}_h_{period}.csv").exists()
        ]
        if not parts:
            continue
        df = pd.concat(parts, ignore_index=True)
        if "sre000h0" not in df.columns or df["sre000h0"].notna().sum() == 0:
            continue
        df = df.dropna(subset=["reference_timestamp"]).set_index("reference_timestamp")
        frames[station] = df[~df.index.duplicated(keep="last")].sort_index()

    if not frames:
        return {"hours": [], "stations": {}}

    latest = max(df.index.max() for df in frames.values())
    hours = pd.date_range(end=latest, periods=HOURLY_WINDOW_HOURS, freq="h")

    stations: dict[str, list[dict]] = {}
    for station, df in frames.items():
        df = df.reindex(hours)
        lat, lon = coords[station]
        elevation = solar_elevation(lat, lon, hours)
        sunshine = df["sre000h0"].to_numpy()
        temp = df["tre200h0"] if "tre200h0" in df.columns else pd.Series(index=hours)
        stations[station] = [
            {
                "condition": classify_hour(sunshine[i], elevation[i]),
                "sunshine_pct": None
                if pd.isna(sunshine[i])
                else round(float(sunshine[i]) / 60 * 100),
                "tmean": _opt(temp.iloc[i]),
            }
            for i in range(len(hours))
        ]
    return {"hours": [h.isoformat() for h in hours], "stations": stations}


def main() -> None:
    data_dir = Path("data")

    conditions = build_current_conditions(data_dir)
    if conditions:
        (data_dir / "conditions.json").write_text(
            json.dumps(conditions, ensure_ascii=False, indent=2)
        )
        print(f"conditions.json: {len(conditions)} stations")
    else:
        print("conditions.json: skipped (no daily 'recent' files)")

    climatology = build_climatology(data_dir)
    if climatology:
        (data_dir / "climatology.json").write_text(
            json.dumps(climatology, ensure_ascii=False)
        )
        total = sum(len(v) for v in climatology.values())
        print(f"climatology.json: {len(climatology)} stations, {total} day-of-year records")
    else:
        print("climatology.json: skipped (no historical daily files)")

    hourly = build_hourly(data_dir, _load_coords(data_dir))
    if hourly["stations"]:
        (data_dir / "hourly.json").write_text(json.dumps(hourly, ensure_ascii=False))
        print(
            f"hourly.json: {len(hourly['stations'])} stations, "
            f"{len(hourly['hours'])} hours"
        )
    else:
        print("hourly.json: skipped (no hourly files)")


if __name__ == "__main__":
    main()
