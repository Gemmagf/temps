"""MeteoSwiss Open Data ingestion for the SwissMetNet (SMN) station network.

All data is public (CC-BY) and served as CSV files via the Swiss federal STAC
API. No API key is required.

  - STAC API:   https://data.geo.admin.ch/api/stac/v1
  - Collection: ch.meteoschweiz.ogd-smn  (~160 automatic weather stations)

Timestamps in the measurement files are UTC.
"""
from __future__ import annotations

import io
from pathlib import Path

import pandas as pd
import requests

STAC_API = "https://data.geo.admin.ch/api/stac/v1"
DATA_BASE = "https://data.geo.admin.ch"
COLLECTION = "ch.meteoschweiz.ogd-smn"

# Temporal resolutions of the measurement files, keyed by the code used in
# the asset filenames (ogd-smn_<station>_<res>_<period>.csv).
RESOLUTIONS = {"t": "10min", "h": "hourly", "d": "daily", "m": "monthly", "y": "yearly"}

# "now": since midnight, "recent": current year up to yesterday,
# "historical": full record (hourly files are split into decade ranges).
PERIODS = ("now", "recent", "historical")

_session = requests.Session()
_session.headers.update({"User-Agent": "temps-weather-app/0.1 (data ingestion)"})


def _get_json(url: str, params: dict | None = None) -> dict:
    resp = _session.get(url, params=params, timeout=60)
    resp.raise_for_status()
    return resp.json()


def _read_csv(content: bytes, **kwargs) -> pd.DataFrame:
    # Measurement files are ASCII; metadata files use cp1252 (umlauts).
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return pd.read_csv(io.BytesIO(content), sep=";", encoding=encoding, **kwargs)
        except UnicodeDecodeError:
            continue
    raise UnicodeDecodeError("utf-8/cp1252", content, 0, 1, "could not decode CSV")


def list_station_items() -> list[dict]:
    """Return every station's STAC item (geometry + the list of CSV assets)."""
    items: list[dict] = []
    url: str | None = f"{STAC_API}/collections/{COLLECTION}/items"
    params: dict | None = {"limit": 100}
    while url:
        doc = _get_json(url, params=params)
        items.extend(doc.get("features", []))
        params = None  # "next" links are already fully-formed
        url = next((l["href"] for l in doc.get("links", []) if l.get("rel") == "next"), None)
    return items


def fetch_station_metadata() -> pd.DataFrame:
    """Station master table: canton, altitude, coordinates, exposition, ..."""
    resp = _session.get(f"{DATA_BASE}/{COLLECTION}/ogd-smn_meta_stations.csv", timeout=60)
    resp.raise_for_status()
    return _read_csv(resp.content)


def fetch_parameter_metadata() -> pd.DataFrame:
    """Decodes the measurement column codes (e.g. tre200d0 -> 2m temperature)."""
    resp = _session.get(f"{DATA_BASE}/{COLLECTION}/ogd-smn_meta_parameters.csv", timeout=60)
    resp.raise_for_status()
    return _read_csv(resp.content)


def build_station_catalog(items: list[dict] | None = None) -> pd.DataFrame:
    """Merge STAC geometry with the station master table into one catalog."""
    if items is None:
        items = list_station_items()
    stac = pd.DataFrame(
        {
            "station_id": it["id"],
            "title": it["properties"].get("title"),
            "lon": it["geometry"]["coordinates"][0],
            "lat": it["geometry"]["coordinates"][1],
        }
        for it in items
    )
    meta = fetch_station_metadata().rename(columns=str.strip)
    meta["station_id"] = meta["station_abbr"].str.lower()
    return stac.merge(meta, on="station_id", how="left")


def _parse_asset_name(name: str) -> dict:
    base = name.removeprefix("ogd-smn_").removesuffix(".csv")
    parts = base.split("_")  # [station, resolution, period, (decade range)]
    return {
        "station": parts[0],
        "resolution": parts[1] if len(parts) > 1 else None,
        "period": parts[2] if len(parts) > 2 else None,
    }


def download_station_data(
    item: dict,
    out_dir: str | Path,
    resolution: str | None = None,
    period: str | None = None,
) -> list[Path]:
    """Download the CSV assets of one station that match resolution/period.

    Filters silently skip assets that do not exist, so a missing "now" file
    for a station is not an error.
    """
    saved: list[Path] = []
    for name, asset in item.get("assets", {}).items():
        if not name.endswith(".csv"):
            continue
        info = _parse_asset_name(name)
        if resolution and info["resolution"] != resolution:
            continue
        if period and info["period"] != period:
            continue
        dest = Path(out_dir) / item["id"] / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        resp = _session.get(asset["href"], timeout=120)
        resp.raise_for_status()
        dest.write_bytes(resp.content)
        saved.append(dest)
    return saved


def load_measurements(path: str | Path) -> pd.DataFrame:
    """Read a downloaded measurement CSV with a parsed UTC timestamp index."""
    df = pd.read_csv(path, sep=";", encoding="utf-8-sig")
    if "reference_timestamp" in df.columns:
        df["reference_timestamp"] = pd.to_datetime(
            df["reference_timestamp"], format="%d.%m.%Y %H:%M", utc=True
        )
    return df
