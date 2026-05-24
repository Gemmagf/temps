import { useState } from "react";
import type { ViewMode } from "./types";

interface TimelineProps {
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  offset: number;
  maxOffset: number;
  onChange: (offset: number) => void;
  headLabel: string;
  tag: string;
  tagKind: "observed" | "forecast" | "clim";
  scaleLabels: string[];
}

const CLIMATOLOGY_DEF =
  "Climatologia: el temps típic d'aquesta data, calculat amb les observacions " +
  "de 1996–2025. No és una predicció, sinó la mitjana del que sol fer; l'app " +
  "la mostra quan ja no hi ha predicció del model (més enllà d'uns 5 dies).";

const NOTE: Record<ViewMode, string> = {
  hourly:
    "Observacions recents i predicció horària (model ICON de MeteoSwiss). «ara» marca el present.",
  daily:
    "Predicció de l'ensemble ICON-CH2-EPS de MeteoSwiss (21 membres) els primers 5 dies, amb % de fiabilitat; després, climatologia.",
  weekly:
    "Resum setmanal climatològic (1996–2025): el temps típic de cada setmana, no una predicció.",
};

export function Timeline({
  mode,
  onModeChange,
  offset,
  maxOffset,
  onChange,
  headLabel,
  tag,
  tagKind,
  scaleLabels,
}: TimelineProps) {
  const [infoOpen, setInfoOpen] = useState(false);

  return (
    <div className="timeline">
      <div className="timeline-head">
        <span className="timeline-date">{headLabel}</span>
        <span className="timeline-tagwrap">
          <span className={"timeline-tag is-" + tagKind}>{tag}</span>
          {tagKind === "clim" && (
            <button
              type="button"
              className="timeline-info"
              aria-label="Què és la climatologia?"
              onClick={() => setInfoOpen((open) => !open)}
            >
              i
            </button>
          )}
          {tagKind === "clim" && infoOpen && (
            <div className="timeline-info-pop">{CLIMATOLOGY_DEF}</div>
          )}
        </span>
      </div>

      <input
        className="timeline-range is-forecast-bar"
        type="range"
        min={0}
        max={maxOffset}
        step={1}
        value={offset}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Línia de temps"
      />

      <div className="timeline-scale">
        {scaleLabels.map((label, i) => (
          <span key={i}>{label}</span>
        ))}
      </div>

      <div className="timeline-foot">
        <label className="timeline-select">
          Desglossament
          <select value={mode} onChange={(e) => onModeChange(e.target.value as ViewMode)}>
            <option value="hourly">Per hores</option>
            <option value="daily">Per dia</option>
            <option value="weekly">Per setmana</option>
          </select>
        </label>
        <span className="timeline-note">{NOTE[mode]}</span>
      </div>
    </div>
  );
}
