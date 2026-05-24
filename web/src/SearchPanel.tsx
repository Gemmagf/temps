import type { MarkerData, Sky, Station } from "./types";
import { SKY_LABEL, iconSvg } from "./weather";

const SEARCHABLE: Sky[] = ["sunny", "partly_cloudy", "cloudy", "fog"];

interface SearchPanelProps {
  markers: MarkerData[];
  stations: Map<string, Station>;
  selected: Set<Sky>;
  onToggle: (sky: Sky) => void;
  onPick: (marker: MarkerData) => void;
}

export function SearchPanel({
  markers,
  stations,
  selected,
  onToggle,
  onPick,
}: SearchPanelProps) {
  const results =
    selected.size === 0
      ? []
      : markers
          .filter((m) => selected.has(m.condition))
          .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ca"));

  return (
    <div className="panel search">
      <h2>Cerca per temps</h2>
      <div className="search-chips">
        {SEARCHABLE.map((sky) => (
          <button
            key={sky}
            type="button"
            className={"search-chip" + (selected.has(sky) ? " is-on" : "")}
            onClick={() => onToggle(sky)}
          >
            <span
              className="chip-icon"
              dangerouslySetInnerHTML={{ __html: iconSvg(sky) }}
            />
            {SKY_LABEL[sky]}
          </button>
        ))}
      </div>

      {selected.size === 0 ? (
        <p className="search-hint">
          Tria una condició per veure a quines localitats es dóna a la vista
          actual del mapa.
        </p>
      ) : results.length === 0 ? (
        <p className="search-hint">
          Cap localitat amb aquesta condició en aquest moment. Mou la barra de
          temps a un altre dia o hora.
        </p>
      ) : (
        <>
          <p className="search-count">
            {results.length} {results.length === 1 ? "localitat" : "localitats"}
          </p>
          <ul className="search-list">
            {results.map((marker) => (
              <li key={marker.id}>
                <button type="button" onClick={() => onPick(marker)}>
                  <span
                    className="chip-icon"
                    dangerouslySetInnerHTML={{ __html: iconSvg(marker.condition) }}
                  />
                  <span className="search-name">{marker.name}</span>
                  <span className="search-canton">
                    {stations.get(marker.id)?.canton ?? ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
