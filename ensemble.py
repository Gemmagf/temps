"""Official MeteoSwiss ICON-CH2-EPS ensemble — cloud-cover probabilities.

This is the "official source" companion to forecast.py. It reads the raw
MeteoSwiss open-data GRIB2 files and turns the full 21-member ensemble
(1 control + 20 perturbed) into per-day probabilities.

Two cloud variables are used so the app can tell apart high cloud (still
visibility) from low cloud / fog (no visibility):
  - CLCT: total cloud cover
  - CLCL: low cloud cover (800 hPa - soil)

A member is classified as: fog (low cloud high), then sunny / partly cloudy /
cloudy from total cloud cover.

Pipeline:
  1. Walk the STAC items of the latest ICON-CH2-EPS run, collecting the CLCT
     and CLCL GRIB assets for the target lead times.
  2. Download the static horizontal grid and the GRIB files.
  3. Match each station to its nearest grid point (k-d tree).
  4. For every station and lead time, classify each member and turn the
     counts into probabilities.

Output: data/ensemble.json

Run after fetch.py (needs data/stations.json).
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from pathlib import Path

import eccodes as ec
import numpy as np
import requests
from scipy.spatial import cKDTree

STAC = "https://data.geo.admin.ch/api/stac/v1"
COLLECTION = "ch.meteoschweiz.ogd-forecasting-icon-ch2"

# One lead time per forecast day, around midday UTC (the run starts at 12 UTC,
# so 24/48/... land near local midday — representative for a daily sky icon).
TARGET_STEPS_H = [24, 48, 72, 96, 120]

# The two cloud variables we read: total and low cloud cover.
VARIABLES = ("CLCT", "CLCL")

# Sky condition thresholds (cloud cover, %).
LOW_CLOUD_FOG_MIN = 70.0  # low cloud at/above this -> fog (no visibility)
CLCT_SUNNY_MAX = 30.0
CLCT_CLOUDY_MIN = 70.0

NWP_DIR = Path("data/nwp")
_session = requests.Session()
_session.headers.update({"User-Agent": "temps-weather-app/0.1 (ensemble)"})


def _horizon_hours(horizon: str) -> int | None:
    m = re.match(r"P(\d+)DT(\d+)H(\d+)M(\d+)S", horizon)
    return int(m.group(1)) * 24 + int(m.group(2)) if m else None


def collect_cloud_items() -> tuple[str, dict[str, dict[int, dict[str, str]]]]:
    """Walk the latest run's STAC items.

    Returns (reference, items) where items[variable][step_h] = {ctrl, perturbed}.
    """
    url: str | None = f"{STAC}/collections/{COLLECTION}/items?limit=100"
    reference: str | None = None
    wanted = set(TARGET_STEPS_H)
    items: dict[str, dict[int, dict[str, str]]] = {v: {} for v in VARIABLES}
    pages = 0

    def complete() -> bool:
        return all(
            len(items[v].get(s, {})) == 2 for v in VARIABLES for s in wanted
        )

    while url:
        doc = _session.get(url, timeout=60).json()
        pages += 1
        for feat in doc.get("features", []):
            props = feat["properties"]
            ref = props.get("forecast:reference_datetime")
            if reference is None:
                reference = ref
            if ref != reference:
                url = None  # left the latest run
                break
            variable = props.get("forecast:variable")
            if variable not in VARIABLES:
                continue
            step = _horizon_hours(props.get("forecast:horizon", ""))
            if step not in wanted:
                continue
            kind = "perturbed" if props.get("forecast:perturbed") else "ctrl"
            href = next(iter(feat["assets"].values()))["href"]
            items[variable].setdefault(step, {})[kind] = href
        else:
            if complete():
                break
            url = next(
                (l["href"] for l in doc.get("links", []) if l.get("rel") == "next"),
                None,
            )
        done = sum(len(items[v].get(s, {})) == 2 for v in VARIABLES for s in wanted)
        print(f"  walked {pages} pages, {done}/{2 * len(wanted)} files located", end="\r")

    print()
    return reference or "", items


def _grid_url() -> str:
    doc = _session.get(f"{STAC}/collections/{COLLECTION}", timeout=60).json()
    for name, asset in doc.get("assets", {}).items():
        if name.startswith("horizontal_constants"):
            return asset["href"]
    raise RuntimeError("horizontal grid asset not found")


def _download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    resp = _session.get(url, timeout=300)
    resp.raise_for_status()
    dest.write_bytes(resp.content)
    return dest


def read_grid(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """Return (lon, lat) arrays for every ICON grid point."""
    lon = lat = None
    with open(path, "rb") as f:
        while True:
            gid = ec.codes_grib_new_from_file(f)
            if gid is None:
                break
            short = ec.codes_get(gid, "shortName")
            if short == "tlon":
                lon = ec.codes_get_values(gid)
            elif short == "tlat":
                lat = ec.codes_get_values(gid)
            ec.codes_release(gid)
    if lon is None or lat is None:
        raise RuntimeError("grid file is missing tlon/tlat")
    return lon, lat


def read_members(path: Path) -> dict[int, np.ndarray]:
    """Return {perturbationNumber: value array} for every GRIB message."""
    members: dict[int, np.ndarray] = {}
    with open(path, "rb") as f:
        while True:
            gid = ec.codes_grib_new_from_file(f)
            if gid is None:
                break
            pn = ec.codes_get(gid, "perturbationNumber")
            members[pn] = ec.codes_get_values(gid)
            ec.codes_release(gid)
    return members


def _classify(clct: float, clcl: float) -> str:
    if clcl >= LOW_CLOUD_FOG_MIN:
        return "fog"
    if clct <= CLCT_SUNNY_MAX:
        return "sunny"
    if clct >= CLCT_CLOUDY_MIN:
        return "cloudy"
    return "partly_cloudy"


def _download_members(variable: str, step_h: int, hrefs: dict[str, str]) -> dict[int, np.ndarray]:
    """Download a variable's control + perturbed files and merge by member."""
    members: dict[int, np.ndarray] = {}
    for kind in ("ctrl", "perturbed"):
        path = NWP_DIR / f"{variable.lower()}-{step_h}-{kind}.grib2"
        _download(hrefs[kind], path)
        members.update(read_members(path))
    return members


def build_ensemble(data_dir: Path) -> dict:
    stations = json.loads((data_dir / "stations.json").read_text())

    print("Collecting CLCT + CLCL items from the latest ICON-CH2-EPS run...")
    reference, items = collect_cloud_items()
    ref_dt = datetime.fromisoformat(reference.replace("Z", "+00:00"))
    print(f"  run {reference}")

    grid_path = NWP_DIR / "grid.grib2"
    if not grid_path.exists():
        print("Downloading horizontal grid...")
        _download(_grid_url(), grid_path)
    grid_lon, grid_lat = read_grid(grid_path)

    # Nearest grid point per station (equirectangular metric is fine at 2 km).
    scale = np.cos(np.radians(float(grid_lat.mean())))
    tree = cKDTree(np.column_stack([grid_lon * scale, grid_lat]))
    st_lon = np.array([s["lon"] for s in stations])
    st_lat = np.array([s["lat"] for s in stations])
    _, station_idx = tree.query(np.column_stack([st_lon * scale, st_lat]))

    out: dict[str, list[dict]] = {s["id"]: [] for s in stations}
    steps = sorted(s for s in TARGET_STEPS_H if len(items["CLCT"].get(s, {})) == 2
                   and len(items["CLCL"].get(s, {})) == 2)
    for step_h in steps:
        print(f"  step {step_h}h: downloading + reading CLCT + CLCL (21 members each)...")
        clct = _download_members("CLCT", step_h, items["CLCT"][step_h])
        clcl = _download_members("CLCL", step_h, items["CLCL"][step_h])
        member_pns = sorted(set(clct) & set(clcl))

        valid = (ref_dt + timedelta(hours=step_h)).date().isoformat()
        clct_stack = np.array([clct[pn][station_idx] for pn in member_pns])
        clcl_stack = np.array([clcl[pn][station_idx] for pn in member_pns])
        for i, station in enumerate(stations):
            classes = [
                _classify(clct_stack[m, i], clcl_stack[m, i])
                for m in range(len(member_pns))
            ]
            n = len(classes)
            out[station["id"]].append(
                {
                    "date": valid,
                    "step_h": step_h,
                    "p_sunny": round(classes.count("sunny") / n, 3),
                    "p_partly": round(classes.count("partly_cloudy") / n, 3),
                    "p_cloudy": round(classes.count("cloudy") / n, 3),
                    "p_fog": round(classes.count("fog") / n, 3),
                    "clct_mean": round(float(clct_stack[:, i].mean()), 1),
                    "members": n,
                }
            )

    return {"reference": reference, "stations": out}


def main() -> None:
    data_dir = Path("data")
    result = build_ensemble(data_dir)
    (data_dir / "ensemble.json").write_text(json.dumps(result, ensure_ascii=False))
    n_days = max((len(v) for v in result["stations"].values()), default=0)
    print(
        f"ensemble.json: run {result['reference']}, "
        f"{len(result['stations'])} stations, {n_days} lead times"
    )


if __name__ == "__main__":
    main()
