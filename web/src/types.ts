export type Condition = "sunny" | "partly_cloudy" | "cloudy" | "fog";
export type Sky = Condition | "night";
export type ViewMode = "hourly" | "daily" | "weekly";

export interface Station {
  id: string;
  name: string;
  canton: string;
  lat: number;
  lon: number;
  height_masl: number | null;
}

export interface ForecastDay {
  date: string;
  condition: Condition;
  sunshine_pct: number | null;
  tmean: number | null;
  tmin: number | null;
  tmax: number | null;
  precip_mm: number | null;
}

export type Forecast = Record<string, ForecastDay[]>;

export interface EnsembleDay {
  date: string;
  step_h: number;
  p_sunny: number;
  p_partly: number;
  p_cloudy: number;
  p_fog: number;
  clct_mean: number;
  members: number;
}

export interface EnsembleData {
  reference: string;
  stations: Record<string, EnsembleDay[]>;
}

export interface ClimDay {
  doy: number;
  sunny: number;
  partly_cloudy: number;
  cloudy: number;
  tmean: number | null;
  tmean_p10: number | null;
  tmean_p90: number | null;
  n: number;
}

export type Climatology = Record<string, ClimDay[]>;

export interface HourEntry {
  condition: Sky;
  sunshine_pct: number | null;
  tmean: number | null;
}

export interface HourlyData {
  hours: string[];
  stations: Record<string, HourEntry[]>;
}

export interface HourlyForecastEntry {
  condition: Sky;
  tmean: number | null;
}

export interface HourlyForecastData {
  hours: string[];
  stations: Record<string, HourlyForecastEntry[]>;
}

export interface MarkerData {
  id: string;
  name: string;
  lon: number;
  lat: number;
  condition: Sky;
  reliable: boolean;
  label: string;
  sublabel: string;
  dimmed?: boolean;
  highlighted?: boolean;
}
