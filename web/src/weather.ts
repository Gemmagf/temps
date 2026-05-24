import type { Condition, ClimDay, EnsembleDay, Sky } from "./types";

export const CONDITIONS: Condition[] = ["sunny", "partly_cloudy", "cloudy", "fog"];

export const SKY_LABEL: Record<Sky, string> = {
  sunny: "Sol",
  partly_cloudy: "Mig núvol",
  cloudy: "Núvol",
  fog: "Boira",
  night: "Nit",
};

const SUN = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
<g stroke="#f4a100" stroke-width="2.6" stroke-linecap="round">
<line x1="16" y1="3.5" x2="16" y2="7.5"/><line x1="16" y1="24.5" x2="16" y2="28.5"/>
<line x1="3.5" y1="16" x2="7.5" y2="16"/><line x1="24.5" y1="16" x2="28.5" y2="16"/>
<line x1="7.2" y1="7.2" x2="10" y2="10"/><line x1="22" y1="22" x2="24.8" y2="24.8"/>
<line x1="7.2" y1="24.8" x2="10" y2="22"/><line x1="22" y1="10" x2="24.8" y2="7.2"/></g>
<circle cx="16" cy="16" r="6.6" fill="#f9b115"/></svg>`;

const CLOUD = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
<g fill="#8b95a3"><circle cx="12" cy="17" r="6.5"/><circle cx="21" cy="17" r="7.5"/>
<circle cx="16.5" cy="12" r="6"/><rect x="9" y="17" width="16" height="8" rx="4"/></g></svg>`;

const PARTLY = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
<g stroke="#f4a100" stroke-width="2.3" stroke-linecap="round">
<line x1="12" y1="2.5" x2="12" y2="5.5"/><line x1="3" y1="11" x2="6" y2="11"/>
<line x1="5.2" y1="4.2" x2="7.4" y2="6.4"/><line x1="18.8" y1="4.2" x2="16.6" y2="6.4"/>
<line x1="5.2" y1="17.8" x2="7.4" y2="15.6"/></g>
<circle cx="12" cy="11" r="5" fill="#f9b115"/>
<g fill="#8b95a3"><circle cx="15" cy="21" r="6"/><circle cx="23" cy="21" r="7"/>
<circle cx="19" cy="16.5" r="5.5"/><rect x="12" y="21" width="15" height="7.5" rx="3.75"/></g></svg>`;

const MOON = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
<path d="M16 5 A11 11 0 1 0 16 27 A8.5 8.5 0 0 1 16 5 Z" fill="#7c89a6"/></svg>`;

const FOG = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
<g stroke="#8590a3" stroke-width="2.8" stroke-linecap="round" fill="none">
<line x1="6" y1="9" x2="26" y2="9"/>
<line x1="3" y1="15" x2="22" y2="15"/>
<line x1="9" y1="21" x2="29" y2="21"/>
<line x1="5" y1="27" x2="22" y2="27"/></g></svg>`;

export function iconSvg(sky: Sky): string {
  if (sky === "sunny") return SUN;
  if (sky === "cloudy") return CLOUD;
  if (sky === "fog") return FOG;
  if (sky === "night") return MOON;
  return PARTLY;
}

export function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const current = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((current - start) / 86_400_000);
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function climForDay(days: ClimDay[] | undefined, doy: number): ClimDay | undefined {
  return days?.find((d) => d.doy === doy);
}

export function dominantCondition(day: ClimDay): { condition: Condition; prob: number } {
  const entries: [Condition, number][] = [
    ["sunny", day.sunny],
    ["partly_cloudy", day.partly_cloudy],
    ["cloudy", day.cloudy],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return { condition: entries[0][0], prob: entries[0][1] };
}

/** Average the climatology over the 7 days starting at startDoy. */
export function weekClimatology(
  days: ClimDay[] | undefined,
  startDoy: number,
): { condition: Condition; prob: number; tmean: number | null } | undefined {
  if (!days) return undefined;
  let sunny = 0;
  let partly = 0;
  let cloudy = 0;
  let tempSum = 0;
  let tempCount = 0;
  let count = 0;
  for (let k = 0; k < 7; k++) {
    const doy = ((startDoy - 1 + k) % 366) + 1;
    const day = days.find((d) => d.doy === doy);
    if (!day) continue;
    sunny += day.sunny;
    partly += day.partly_cloudy;
    cloudy += day.cloudy;
    count += 1;
    if (day.tmean != null) {
      tempSum += day.tmean;
      tempCount += 1;
    }
  }
  if (count === 0) return undefined;
  const ranked: [Condition, number][] = [
    ["sunny", sunny / count],
    ["partly_cloudy", partly / count],
    ["cloudy", cloudy / count],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  return {
    condition: ranked[0][0],
    prob: ranked[0][1],
    tmean: tempCount > 0 ? tempSum / tempCount : null,
  };
}

/** Most probable sky condition from the 21-member ICON ensemble. */
export function ensembleDominant(day: EnsembleDay): { condition: Condition; prob: number } {
  const ranked: [Condition, number][] = [
    ["sunny", day.p_sunny],
    ["partly_cloudy", day.p_partly],
    ["cloudy", day.p_cloudy],
    ["fog", day.p_fog ?? 0],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  return { condition: ranked[0][0], prob: ranked[0][1] };
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;

export function formatDate(date: Date): string {
  return date.toLocaleDateString("ca-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

export function formatHour(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString("ca-ES", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
