// Points of interest from OpenStreetMap via the Overpass API.

export type PoiKind = "outdoor" | "indoor" | "mixed";

export type PoiGroup =
  | "views"
  | "excursions"
  | "museums"
  | "heritage"
  | "parks"
  | "leisure";

export interface Poi {
  id: string;
  name: string;
  category: string;
  kind: PoiKind;
  group: PoiGroup;
  lat: number;
  lon: number;
  distanceKm: number;
}

export interface PoiSection {
  group: PoiGroup;
  label: string;
  items: Poi[];
}

export const GROUP_LABEL: Record<PoiGroup, string> = {
  views: "Vistes",
  excursions: "Excursions",
  museums: "Museus i galeries",
  heritage: "Visites públiques",
  parks: "Parcs i jardins",
  leisure: "Lleure",
};

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const RADIUS_M = 8000;

interface Classification {
  category: string;
  kind: PoiKind;
  group: PoiGroup;
}

function classify(t: Record<string, string>): Classification | null {
  if (t.tourism === "viewpoint")
    return { category: "Mirador", kind: "outdoor", group: "views" };
  if (t.tourism === "museum")
    return { category: "Museu", kind: "indoor", group: "museums" };
  if (t.tourism === "gallery")
    return { category: "Galeria d'art", kind: "indoor", group: "museums" };
  if (t.tourism === "zoo")
    return { category: "Zoo", kind: "outdoor", group: "leisure" };
  if (t.tourism === "theme_park")
    return { category: "Parc d'atraccions", kind: "outdoor", group: "leisure" };
  if (t.tourism === "artwork")
    return { category: "Art públic", kind: "outdoor", group: "heritage" };
  if (t.tourism === "attraction")
    return { category: "Atracció", kind: "mixed", group: "leisure" };
  if (t.natural === "peak")
    return { category: "Cim", kind: "outdoor", group: "excursions" };
  if (t.historic === "castle")
    return { category: "Castell", kind: "mixed", group: "heritage" };
  if (t.historic === "ruins")
    return { category: "Ruïnes", kind: "outdoor", group: "heritage" };
  if (t.historic === "monument" || t.historic === "memorial")
    return { category: "Monument", kind: "outdoor", group: "heritage" };
  if (t.leisure === "park")
    return { category: "Parc", kind: "outdoor", group: "parks" };
  if (t.leisure === "nature_reserve")
    return { category: "Reserva natural", kind: "outdoor", group: "excursions" };
  if (t.leisure === "garden")
    return { category: "Jardí", kind: "outdoor", group: "parks" };
  if (t.leisure === "water_park")
    return { category: "Parc aquàtic", kind: "outdoor", group: "leisure" };
  return null;
}

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export async function fetchPois(lat: number, lon: number): Promise<Poi[]> {
  const filters = [
    '[tourism~"^(viewpoint|museum|attraction|gallery|zoo|theme_park|artwork)$"]',
    "[natural=peak]",
    '[historic~"^(castle|ruins|monument|memorial)$"]',
    '[leisure~"^(park|nature_reserve|garden|water_park)$"]',
  ];
  const body = filters
    .map((f) => `nwr(around:${RADIUS_M},${lat},${lon})${f};`)
    .join("");
  const query = `[out:json][timeout:25];(${body});out center tags 200;`;

  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const json = await res.json();

  const pois: Poi[] = [];
  const seen = new Set<string>();
  for (const el of json.elements ?? []) {
    const tags: Record<string, string> = el.tags ?? {};
    if (!tags.name || seen.has(tags.name)) continue;
    const c = classify(tags);
    if (!c) continue;
    const pLat = el.lat ?? el.center?.lat;
    const pLon = el.lon ?? el.center?.lon;
    if (pLat == null || pLon == null) continue;
    seen.add(tags.name);
    pois.push({
      id: `${el.type}/${el.id}`,
      name: tags.name,
      category: c.category,
      kind: c.kind,
      group: c.group,
      lat: pLat,
      lon: pLon,
      distanceKm: haversineKm(lat, lon, pLat, pLon),
    });
  }
  return pois;
}

// Order of group sections, picked based on the weather at the locality.
const GROUP_ORDER: Record<string, PoiGroup[]> = {
  sunny: ["views", "excursions", "parks", "leisure", "heritage", "museums"],
  partly_cloudy: ["views", "excursions", "heritage", "parks", "leisure", "museums"],
  cloudy: ["museums", "heritage", "leisure", "parks", "views", "excursions"],
  fog: ["museums", "heritage", "leisure", "parks", "views", "excursions"],
  night: ["museums", "heritage", "leisure", "views", "excursions", "parks"],
};

const DEFAULT_ORDER: PoiGroup[] = [
  "views",
  "excursions",
  "museums",
  "heritage",
  "parks",
  "leisure",
];

// Group POIs by activity type. Section order suits the current weather;
// within each section, items are sorted by distance.
export function groupPois(pois: Poi[], condition: string): PoiSection[] {
  const order = GROUP_ORDER[condition] ?? DEFAULT_ORDER;
  const byGroup = new Map<PoiGroup, Poi[]>();
  for (const poi of pois) {
    const arr = byGroup.get(poi.group) ?? [];
    arr.push(poi);
    byGroup.set(poi.group, arr);
  }
  for (const arr of byGroup.values()) {
    arr.sort((a, b) => a.distanceKm - b.distanceKm);
  }
  return order
    .map((group) => ({
      group,
      label: GROUP_LABEL[group],
      items: byGroup.get(group) ?? [],
    }))
    .filter((section) => section.items.length > 0);
}
