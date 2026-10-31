"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LatLng } from "@/lib/geo";

export type MapViewProps = {
  center: LatLng;
  pickup?: LatLng | null;
  drop?: LatLng | null;
  /** Main trip route (pickup → drop). */
  route?: LatLng[] | null;
  /** Captain's approach route (captain → pickup). */
  approach?: LatLng[] | null;
  vehicle?: { position: LatLng; icon: string } | null;
  /** Idle captains sprinkled around the map for ambience. */
  nearby?: { position: LatLng; icon: string }[];
  onMapClick?: (p: LatLng) => void;
};

const pin = (color: string, label: string) =>
  L.divIcon({
    className: "",
    html: `<div class="pin" style="--pin:${color}"><span>${label}</span></div>`,
    iconSize: [28, 36],
    iconAnchor: [14, 34],
  });

const emoji = (icon: string, big = false) =>
  L.divIcon({
    className: "",
    html: `<div class="veh ${big ? "veh-big" : ""}">${icon}</div>`,
    iconSize: big ? [40, 40] : [26, 26],
    iconAnchor: big ? [20, 20] : [13, 13],
  });

// Not animated: Leaflet silently ignores a new view while a zoom animation is
// still running, so quick pickup→drop selection would otherwise skip the fit.
const FIT: L.FitBoundsOptions = { padding: [60, 60], maxZoom: 15, animate: false };

const toLL = (p: LatLng): L.LatLngTuple => [p.lat, p.lng];

export default function MapView(props: MapViewProps) {
  const { center, pickup, drop, route, approach, vehicle, nearby, onMapClick } = props;
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<{
    pickup?: L.Marker;
    drop?: L.Marker;
    route?: L.Polyline;
    approach?: L.Polyline;
    vehicle?: L.Marker;
    nearby?: L.LayerGroup;
  }>({});
  const clickRef = useRef(onMapClick);
  const bounds = useRef<L.LatLngBounds | null>(null);

  useEffect(() => {
    clickRef.current = onMapClick;
  }, [onMapClick]);

  // Create the map once.
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: false, attributionControl: true }).setView(toLL(center), 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m);
    L.control.zoom({ position: "topright" }).addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => clickRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    map.current = m;
    // Leaflet caches the container size; keep it in sync with layout changes.
    const ro = new ResizeObserver(() => {
      m.invalidateSize();
      if (bounds.current) m.fitBounds(bounds.current, FIT);
    });
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      layers.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pickup / drop markers + fit bounds.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const l = layers.current;
    l.pickup?.remove();
    l.drop?.remove();
    l.pickup = pickup ? L.marker(toLL(pickup), { icon: pin("#16a34a", "P") }).addTo(m) : undefined;
    l.drop = drop ? L.marker(toLL(drop), { icon: pin("#dc2626", "D") }).addTo(m) : undefined;
    bounds.current = pickup && drop ? L.latLngBounds([toLL(pickup), toLL(drop)]) : null;
    if (bounds.current) m.fitBounds(bounds.current, FIT);
    else if (pickup) m.setView(toLL(pickup), 15, { animate: false });
    else if (drop) m.setView(toLL(drop), 15, { animate: false });
  }, [pickup, drop]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    layers.current.route?.remove();
    layers.current.route = route?.length
      ? L.polyline(route.map(toLL), { color: "#111827", weight: 5, opacity: 0.85 }).addTo(m)
      : undefined;
  }, [route]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    layers.current.approach?.remove();
    layers.current.approach = approach?.length
      ? L.polyline(approach.map(toLL), { color: "#f59e0b", weight: 4, dashArray: "6 8" }).addTo(m)
      : undefined;
  }, [approach]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const l = layers.current;
    if (!vehicle) {
      l.vehicle?.remove();
      l.vehicle = undefined;
      return;
    }
    if (!l.vehicle) l.vehicle = L.marker(toLL(vehicle.position), { icon: emoji(vehicle.icon, true), zIndexOffset: 1000 }).addTo(m);
    else {
      l.vehicle.setLatLng(toLL(vehicle.position));
      l.vehicle.setIcon(emoji(vehicle.icon, true));
    }
  }, [vehicle]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    layers.current.nearby?.remove();
    if (!nearby?.length) return;
    const g = L.layerGroup(nearby.map((n) => L.marker(toLL(n.position), { icon: emoji(n.icon), interactive: false })));
    g.addTo(m);
    layers.current.nearby = g;
  }, [nearby]);

  return <div ref={el} className="h-full w-full" data-testid="map" />;
}
