import { useCallback, useEffect, useMemo, useState } from "react";
import { WeatherMap } from "./WeatherMap";
import { Timeline } from "./Timeline";
import { SearchPanel } from "./SearchPanel";
import { RecommendPanel } from "./RecommendPanel";
import type {
  Climatology,
  EnsembleData,
  EnsembleDay,
  Forecast,
  ForecastDay,
  HourlyData,
  HourlyForecastData,
  MarkerData,
  Sky,
  Station,
  ViewMode,
} from "./types";
import {
  CONDITIONS,
  SKY_LABEL,
  addDays,
  climForDay,
  dayOfYear,
  dominantCondition,
  ensembleDominant,
  formatDate,
  formatHour,
  iconSvg,
  pct,
  weekClimatology,
} from "./weather";
import "./App.css";

interface View {
  markers: MarkerData[];
  headLabel: string;
  tag: string;
  tagKind: "observed" | "forecast" | "clim";
  scaleLabels: string[];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

// How many hours of past observations the hourly view keeps before "now".
const OBSERVED_HOURS = 48;

// Re-fetch the volatile data (observations + forecasts) on this cadence
// and whenever the tab regains focus.
const REFRESH_MS = 10 * 60 * 1000;

interface HourCell {
  condition: Sky;
  temp: number | null;
  observed: boolean;
}

const dayMonth = (date: Date) =>
  date.toLocaleDateString("ca-ES", { day: "numeric", month: "long", timeZone: "UTC" });

export default function App() {
  const [stations, setStations] = useState<Station[]>([]);
  const [climatology, setClimatology] = useState<Climatology>({});
  const [hourly, setHourly] = useState<HourlyData | null>(null);
  const [hourlyForecast, setHourlyForecast] = useState<HourlyForecastData | null>(null);
  const [forecast, setForecast] = useState<Forecast>({});
  const [ensemble, setEnsemble] = useState<EnsembleData | null>(null);
  const [mode, setMode] = useState<ViewMode>("daily");
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState<Set<Sky>>(new Set());
  const [focus, setFocus] = useState<{ lon: number; lat: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPoi, setSelectedPoi] = useState<
    { lon: number; lat: number; name: string } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const toggleSearch = useCallback((sky: Sky) => {
    setSearch((prev) => {
      const next = new Set(prev);
      next.has(sky) ? next.delete(sky) : next.add(sky);
      return next;
    });
  }, []);

  useEffect(() => {
    const base = import.meta.env.BASE_URL;
    let cancelled = false;

    // Volatile data — observations and forecasts — re-fetched periodically.
    const fetchVolatile = () => {
      const bust = `?t=${Date.now()}`;
      return Promise.all([
        fetch(`${base}data/hourly.json${bust}`).then((r) => r.json()),
        fetch(`${base}data/forecast.json${bust}`).then((r) => r.json()),
        fetch(`${base}data/ensemble.json${bust}`).then((r) => r.json()),
        fetch(`${base}data/hourly_forecast.json${bust}`).then((r) => r.json()),
      ]);
    };

    const initialLoad = async () => {
      try {
        const [s, cl] = await Promise.all([
          fetch(`${base}data/stations.json`).then((r) => r.json()),
          fetch(`${base}data/climatology.json`).then((r) => r.json()),
        ]);
        const [h, fc, ens, hfc] = await fetchVolatile();
        if (cancelled) return;
        setStations(s);
        setClimatology(cl);
        setHourly(h);
        setForecast(fc);
        setEnsemble(ens);
        setHourlyForecast(hfc);
        setLastRefresh(new Date());
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const refresh = async () => {
      try {
        const [h, fc, ens, hfc] = await fetchVolatile();
        if (cancelled) return;
        setHourly(h);
        setForecast(fc);
        setEnsemble(ens);
        setHourlyForecast(hfc);
        setLastRefresh(new Date());
      } catch {
        /* keep showing the previous data on transient errors */
      }
    };

    initialLoad();
    const intervalId = setInterval(refresh, REFRESH_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const today = useMemo(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }, []);

  const stationById = useMemo(
    () => new Map(stations.map((s) => [s.id, s])),
    [stations],
  );

  // Per station: date -> forecast day; plus the set of dates the model covers.
  const { forecastByStation, forecastDates } = useMemo(() => {
    const byStation = new Map<string, Map<string, ForecastDay>>();
    const dates = new Set<string>();
    for (const [id, days] of Object.entries(forecast)) {
      const map = new Map<string, ForecastDay>();
      for (const day of days) {
        map.set(day.date, day);
        dates.add(day.date);
      }
      byStation.set(id, map);
    }
    return { forecastByStation: byStation, forecastDates: dates };
  }, [forecast]);

  // Per station: date -> ICON ensemble probabilities for that day.
  const { ensembleByStation, ensembleDates } = useMemo(() => {
    const byStation = new Map<string, Map<string, EnsembleDay>>();
    const dates = new Set<string>();
    for (const [id, days] of Object.entries(ensemble?.stations ?? {})) {
      const map = new Map<string, EnsembleDay>();
      for (const day of days) {
        map.set(day.date, day);
        dates.add(day.date);
      }
      byStation.set(id, map);
    }
    return { ensembleByStation: byStation, ensembleDates: dates };
  }, [ensemble]);

  // The hourly view: recent observations + hourly forecast on one timeline.
  const hourlyTimeline = useMemo(() => {
    if (!hourly) return null;
    const obsHours = hourly.hours.slice(-OBSERVED_HOURS);
    const obsStart = hourly.hours.length - obsHours.length;
    const lastObs = obsHours.length ? Date.parse(obsHours[obsHours.length - 1]) : 0;

    let fcHours: string[] = [];
    let fcStart = 0;
    if (hourlyForecast) {
      const idx = hourlyForecast.hours.findIndex((h) => Date.parse(h) > lastObs);
      if (idx >= 0) {
        fcHours = hourlyForecast.hours.slice(idx);
        fcStart = idx;
      }
    }

    const hours = [...obsHours, ...fcHours];
    const nowIndex = Math.max(0, obsHours.length - 1);
    const byStation = new Map<string, (HourCell | null)[]>();
    const ids = new Set<string>([
      ...Object.keys(hourly.stations),
      ...(hourlyForecast ? Object.keys(hourlyForecast.stations) : []),
    ]);
    for (const id of ids) {
      const obs = hourly.stations[id];
      const obsCells = obsHours.map((_, i): HourCell | null => {
        const e = obs?.[obsStart + i];
        return e ? { condition: e.condition, temp: e.tmean, observed: true } : null;
      });
      const fc = hourlyForecast?.stations[id];
      const fcCells = fcHours.map((_, i): HourCell | null => {
        const e = fc?.[fcStart + i];
        return e ? { condition: e.condition, temp: e.tmean, observed: false } : null;
      });
      byStation.set(id, [...obsCells, ...fcCells]);
    }
    return { hours, byStation, nowIndex };
  }, [hourly, hourlyForecast]);

  const maxOffset =
    mode === "daily"
      ? 21
      : mode === "weekly"
        ? 3
        : hourlyTimeline
          ? hourlyTimeline.hours.length - 1
          : 0;

  const changeMode = useCallback(
    (next: ViewMode) => {
      setMode(next);
      setOffset(next === "hourly" && hourlyTimeline ? hourlyTimeline.nowIndex : 0);
    },
    [hourlyTimeline],
  );

  const view = useMemo<View>(() => {
    if (mode === "hourly") {
      if (!hourlyTimeline || hourlyTimeline.hours.length === 0) {
        return { markers: [], headLabel: "—", tag: "Observació", tagKind: "observed", scaleLabels: [] };
      }
      const { hours, byStation, nowIndex } = hourlyTimeline;
      const observed = offset <= nowIndex;
      const markers = stations.flatMap((station) => {
        const cell = byStation.get(station.id)?.[offset];
        if (!cell) return [];
        return [
          {
            id: station.id,
            name: station.name,
            lon: station.lon,
            lat: station.lat,
            condition: cell.condition,
            reliable: true,
            label: cell.observed
              ? SKY_LABEL[cell.condition]
              : `${SKY_LABEL[cell.condition]} (predicció)`,
            sublabel: `${cell.temp ?? "–"} °C`,
          },
        ];
      });
      const scaleLabels = [0, 0.34, 0.67, 1].map((f) => {
        const dh = Math.round(f * (hours.length - 1)) - nowIndex;
        if (Math.abs(dh) < 1) return "ara";
        if (Math.abs(dh) < 24) return `${dh > 0 ? "+" : "−"}${Math.abs(dh)} h`;
        return `${dh > 0 ? "+" : "−"}${Math.round(Math.abs(dh) / 24)} d`;
      });
      return {
        markers,
        headLabel: cap(formatHour(hours[offset])),
        tag: observed ? "Observació" : "Predicció",
        tagKind: observed ? "observed" : "forecast",
        scaleLabels,
      };
    }

    if (mode === "weekly") {
      const weekStart = addDays(today, offset * 7);
      const startDoy = dayOfYear(weekStart);
      const markers = stations.flatMap((station) => {
        const week = weekClimatology(climatology[station.id], startDoy);
        if (!week) return [];
        return [
          {
            id: station.id,
            name: station.name,
            lon: station.lon,
            lat: station.lat,
            condition: week.condition,
            reliable: false,
            label: `${SKY_LABEL[week.condition]} (climatologia)`,
            sublabel: `${Math.round(week.prob * 100)}% dels dies · ${
              week.tmean != null ? week.tmean.toFixed(1) : "–"
            } °C de mitjana`,
          },
        ];
      });
      return {
        markers,
        headLabel: `Setmana del ${dayMonth(weekStart)}`,
        tag: offset === 0 ? "Climatologia · setmana actual" : `Climatologia · setmana +${offset}`,
        tagKind: "clim",
        scaleLabels: ["Aquesta setmana", "+1 setmana", "+2 setmanes", "+3 setmanes"],
      };
    }

    // daily
    const date = addDays(today, offset);
    const dateStr = isoDate(date);
    const scaleLabels = ["Avui", "+1 setmana", "+2 setmanes", "+3 setmanes"];
    const headLabel = cap(formatDate(date));

    if (forecastDates.has(dateStr) || ensembleDates.has(dateStr)) {
      const markers = stations.flatMap((station) => {
        const ens = ensembleByStation.get(station.id)?.get(dateStr);
        const fc = forecastByStation.get(station.id)?.get(dateStr);
        const temp = fc ? `${fc.tmin ?? "–"}–${fc.tmax ?? "–"} °C` : null;
        const base = {
          id: station.id,
          name: station.name,
          lon: station.lon,
          lat: station.lat,
        };
        // Prefer the ICON ensemble (real probabilities); fall back to the
        // deterministic Open-Meteo forecast where the ensemble has no day.
        if (ens) {
          const { condition, prob } = ensembleDominant(ens);
          return [
            {
              ...base,
              condition,
              reliable: prob >= 0.6,
              label: `${SKY_LABEL[condition]} · ${pct(prob)} de fiabilitat`,
              sublabel:
                `Sol ${pct(ens.p_sunny)} · Mig ${pct(ens.p_partly)} · ` +
                `Núvol ${pct(ens.p_cloudy)} · Boira ${pct(ens.p_fog ?? 0)}` +
                `${temp ? ` — ${temp}` : ""}`,
            },
          ];
        }
        if (fc) {
          return [
            {
              ...base,
              condition: fc.condition,
              reliable: true,
              label: `${SKY_LABEL[fc.condition]} (predicció)`,
              sublabel: temp ?? "",
            },
          ];
        }
        return [];
      });
      return {
        markers,
        headLabel,
        tag: offset === 0 ? "Predicció · avui" : `Predicció · dia +${offset}`,
        tagKind: "forecast",
        scaleLabels,
      };
    }

    const doy = dayOfYear(date);
    const markers = stations.flatMap((station) => {
      const day = climForDay(climatology[station.id], doy);
      if (!day) return [];
      const { condition, prob } = dominantCondition(day);
      return [
        {
          id: station.id,
          name: station.name,
          lon: station.lon,
          lat: station.lat,
          condition,
          reliable: false,
          label: `${SKY_LABEL[condition]} (climatologia)`,
          sublabel: `${Math.round(prob * 100)}% de probabilitat · ${
            day.tmean ?? "–"
          } °C de mitjana`,
        },
      ];
    });
    return {
      markers,
      headLabel,
      tag: `Climatologia · dia +${offset}`,
      tagKind: "clim",
      scaleLabels,
    };
  }, [
    mode,
    offset,
    stations,
    climatology,
    today,
    forecastByStation,
    forecastDates,
    ensembleByStation,
    ensembleDates,
    hourlyTimeline,
  ]);

  // When a weather search is active, show ONLY the matching localities.
  // If nothing matches, leave the map untouched (the panel explains why).
  const displayMarkers = useMemo<MarkerData[]>(() => {
    if (search.size === 0) return view.markers;
    const matches = view.markers.filter((m) => search.has(m.condition as Sky));
    if (matches.length === 0) return view.markers;
    return matches.map((m) => ({ ...m, highlighted: true }));
  }, [view.markers, search]);

  const selectStation = useCallback((m: MarkerData) => {
    setSelectedId(m.id);
    setSelectedPoi(null);
  }, []);
  const selectedMarker = useMemo(
    () => displayMarkers.find((m) => m.id === selectedId) ?? null,
    [displayMarkers, selectedId],
  );

  return (
    <div className="app">
      {!loading && !error && (
        <WeatherMap
          markers={displayMarkers}
          focus={focus}
          pin={selectedPoi}
          onSelectStation={selectStation}
        />
      )}

      <header className="panel legend">
        <h1>
          El Temps <span>· Suïssa</span>
        </h1>
        <div className="legend-items">
          {CONDITIONS.map((c) => (
            <span className="legend-item" key={c}>
              <span
                className="legend-icon"
                dangerouslySetInnerHTML={{ __html: iconSvg(c) }}
              />
              {SKY_LABEL[c]}
            </span>
          ))}
        </div>
        <p className="legend-count">
          {view.markers.length} estacions · MeteoSwiss Open Data
          {lastRefresh && (
            <>
              <br />
              Actualitzat{" "}
              {lastRefresh.toLocaleTimeString("ca-ES", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </>
          )}
        </p>
      </header>

      {!loading && !error && (
        <SearchPanel
          markers={view.markers}
          stations={stationById}
          selected={search}
          onToggle={toggleSearch}
          onPick={(m) => setFocus({ lon: m.lon, lat: m.lat })}
        />
      )}

      {!loading && !error && selectedMarker && (
        <RecommendPanel
          marker={selectedMarker}
          onClose={() => {
            setSelectedId(null);
            setSelectedPoi(null);
          }}
          onPick={(lon, lat, name) => {
            setFocus({ lon, lat });
            setSelectedPoi({ lon, lat, name });
          }}
        />
      )}

      {loading && <div className="overlay">Carregant dades…</div>}
      {error && <div className="overlay overlay-error">Error: {error}</div>}

      {!loading && !error && (
        <Timeline
          mode={mode}
          onModeChange={changeMode}
          offset={offset}
          maxOffset={maxOffset}
          onChange={setOffset}
          headLabel={view.headLabel}
          tag={view.tag}
          tagKind={view.tagKind}
          scaleLabels={view.scaleLabels}
        />
      )}
    </div>
  );
}
