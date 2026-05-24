import { useEffect, useMemo, useState } from "react";
import type { MarkerData } from "./types";
import { fetchPois, groupPois, type Poi, type PoiSection } from "./pois";

interface RecommendPanelProps {
  marker: MarkerData;
  onClose: () => void;
  onPick: (lon: number, lat: number, name: string) => void;
}

const WEATHER_HINT: Record<string, string> = {
  sunny: "Fa sol: primer activitats a l'aire lliure.",
  partly_cloudy: "Cel variable: una barreja d'opcions.",
  cloudy: "Cel cobert: primer llocs sota cobert.",
  fog: "Boira / núvols baixos: primer llocs sota cobert.",
  night: "De nit: ordenat per proximitat.",
};

export function RecommendPanel({ marker, onClose, onPick }: RecommendPanelProps) {
  const [raw, setRaw] = useState<Poi[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRaw(null);
    setError(false);
    fetchPois(marker.lat, marker.lon)
      .then((p) => !cancelled && setRaw(p))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [marker.id, marker.lat, marker.lon]);

  const sections: PoiSection[] | null = useMemo(
    () => (raw ? groupPois(raw, marker.condition) : null),
    [raw, marker.condition],
  );

  const totalCount = sections?.reduce((n, s) => n + s.items.length, 0) ?? 0;

  return (
    <div className="panel recommend">
      <div className="recommend-head">
        <h2>{marker.name}</h2>
        <button
          type="button"
          className="recommend-close"
          onClick={onClose}
          aria-label="Tanca"
        >
          ×
        </button>
      </div>
      <p className="recommend-weather">{marker.label}</p>
      <p className="recommend-hint">{WEATHER_HINT[marker.condition] ?? ""}</p>

      {!sections && !error && (
        <p className="recommend-state">Cercant llocs a prop…</p>
      )}
      {error && (
        <p className="recommend-state">
          No s'han pogut carregar els llocs. Torna-ho a provar.
        </p>
      )}
      {sections && totalCount === 0 && (
        <p className="recommend-state">No s'han trobat llocs destacats a prop.</p>
      )}

      {sections && totalCount > 0 && (
        <div className="recommend-body">
          {sections.map((section) => (
            <section className="recommend-section" key={section.group}>
              <h3>
                {section.label}
                <span> · {section.items.length}</span>
              </h3>
              <ul>
                {section.items.map((poi) => (
                  <li key={poi.id}>
                    <button type="button" onClick={() => onPick(poi.lon, poi.lat, poi.name)}>
                      <span className="recommend-name">{poi.name}</span>
                      <span className={"recommend-cat kind-" + poi.kind}>
                        {poi.category}
                      </span>
                      <span className="recommend-dist">
                        {poi.distanceKm.toFixed(1)} km
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
