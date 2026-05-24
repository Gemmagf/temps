"""Download MeteoSwiss SwissMetNet open data into ./data.

Examples:
  python fetch.py                          # daily, current year, all stations
  python fetch.py --resolution h           # hourly instead of daily
  python fetch.py --period historical      # full historical record
  python fetch.py --stations abo gve lug   # only a few stations
  python fetch.py --catalog-only           # just refresh the station catalog

Output:
  data/stations.json   slim station catalog for the web frontend
  data/stations.csv    full station catalog (all metadata columns)
  data/parameters.csv  decodes the measurement column codes
  data/raw/<id>/*.csv  raw measurement files, one folder per station
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import meteoswiss as ms

SLIM_COLUMNS = {
    "station_id": "id",
    "station_name": "name",
    "station_canton": "canton",
    "lat": "lat",
    "lon": "lon",
    "station_height_masl": "height_masl",
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default="data", help="output directory (default: data)")
    parser.add_argument("--resolution", default="d", choices=list(ms.RESOLUTIONS),
                        help="t=10min, h=hourly, d=daily, m=monthly, y=yearly (default: d)")
    parser.add_argument("--period", default="recent", choices=ms.PERIODS,
                        help="now / recent / historical (default: recent)")
    parser.add_argument("--stations", nargs="*", metavar="ID",
                        help="restrict to these station ids (lowercase, e.g. abo gve)")
    parser.add_argument("--workers", type=int, default=8, help="parallel downloads (default: 8)")
    parser.add_argument("--catalog-only", action="store_true", help="only build the station catalog")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    print("Fetching station catalog from the STAC API...")
    items = ms.list_station_items()
    catalog = ms.build_station_catalog(items)

    catalog.to_csv(out / "stations.csv", index=False)
    slim = catalog[list(SLIM_COLUMNS)].rename(columns=SLIM_COLUMNS)
    # A station can be in the STAC catalog but missing from the meta CSV
    # (e.g. recently retired); keep it but fall back to the upper-case id.
    slim["name"] = slim["name"].fillna(slim["id"].str.upper())
    slim.to_json(out / "stations.json", orient="records", force_ascii=False, indent=2)
    ms.fetch_parameter_metadata().to_csv(out / "parameters.csv", index=False)
    print(f"  {len(catalog)} stations -> {out / 'stations.json'}, {out / 'stations.csv'}")

    if args.catalog_only:
        return

    if args.stations:
        wanted = {s.lower() for s in args.stations}
        items = [it for it in items if it["id"] in wanted]
        missing = wanted - {it["id"] for it in items}
        if missing:
            print(f"  warning: unknown station ids ignored: {', '.join(sorted(missing))}")

    raw = out / "raw"
    print(f"Downloading resolution='{args.resolution}' period='{args.period}' "
          f"for {len(items)} station(s)...")

    errors: list[tuple[str, Exception]] = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(ms.download_station_data, it, raw, args.resolution, args.period): it
            for it in items
        }
        for done, future in enumerate(as_completed(futures), start=1):
            station = futures[future]["id"]
            try:
                saved = future.result()
                detail = f"{len(saved)} file(s)" if saved else "no matching file"
                print(f"  [{done}/{len(items)}] {station}: {detail}")
            except Exception as exc:  # network / HTTP errors per station
                errors.append((station, exc))
                print(f"  [{done}/{len(items)}] {station}: ERROR {exc}")

    print(f"Done. Raw files in {raw}")
    if errors:
        print(f"{len(errors)} station(s) failed: {', '.join(s for s, _ in errors)}")


if __name__ == "__main__":
    main()
