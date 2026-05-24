import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { MarkerData } from "./types";
import { iconSvg } from "./weather";

const STYLE_URL =
  "https://vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json";

interface WeatherMapProps {
  markers: MarkerData[];
  focus: { lon: number; lat: number } | null;
  pin: { lon: number; lat: number; name: string } | null;
  onSelectStation: (marker: MarkerData) => void;
}

const PIN_SVG = `<svg viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">
<path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0Z" fill="#dc4040"/>
<circle cx="12" cy="12" r="4.5" fill="#fff"/></svg>`;

export function WeatherMap({ markers, focus, pin, onSelectStation }: WeatherMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRefs = useRef<maplibregl.Marker[]>([]);
  const pinRef = useRef<maplibregl.Marker | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [8.23, 46.8],
      zoom: 6.9,
      minZoom: 6,
      maxZoom: 12,
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.on("error", (e) => console.error("[maplibre]", e.error?.message ?? e));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    map.flyTo({ center: [focus.lon, focus.lat], zoom: 9.5, speed: 1.2 });
  }, [focus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (pinRef.current) {
      pinRef.current.remove();
      pinRef.current = null;
    }
    if (!pin) return;
    const element = document.createElement("div");
    element.className = "poi-pin";
    element.innerHTML = PIN_SVG;
    element.title = pin.name;
    pinRef.current = new maplibregl.Marker({ element, anchor: "bottom" })
      .setLngLat([pin.lon, pin.lat])
      .addTo(map);
  }, [pin]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markerRefs.current.forEach((m) => m.remove());
    markerRefs.current = markers.map((data) => {
      const element = document.createElement("div");
      element.className =
        "weather-marker" +
        (data.reliable ? "" : " weather-marker--uncertain") +
        (data.dimmed ? " weather-marker--dimmed" : "") +
        (data.highlighted ? " weather-marker--match" : "");
      element.innerHTML = iconSvg(data.condition);
      element.title = `${data.name} — ${data.label}\n${data.sublabel}`;
      element.addEventListener("click", (e) => {
        e.stopPropagation();
        onSelectStation(data);
      });
      return new maplibregl.Marker({ element })
        .setLngLat([data.lon, data.lat])
        .addTo(map);
    });
  }, [markers, onSelectStation]);

  return <div className="map" ref={containerRef} />;
}
