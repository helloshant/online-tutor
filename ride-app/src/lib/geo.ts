export type LatLng = { lat: number; lng: number };

export type Place = LatLng & {
  id: string;
  name: string;
  address: string;
};

const R = 6371; // km

export function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** City roads are rarely straight: approximate road distance from crow-flies. */
export const ROAD_FACTOR = 1.35;

export function roadDistanceKm(a: LatLng, b: LatLng): number {
  return haversineKm(a, b) * ROAD_FACTOR;
}

/**
 * A gently curved polyline between two points (quadratic Bézier with a
 * perpendicular offset). Good enough to draw a plausible "route" and animate
 * a vehicle along it without depending on an external routing service.
 */
export function curvedRoute(a: LatLng, b: LatLng, steps = 60, bend = 0.18): LatLng[] {
  const midLat = (a.lat + b.lat) / 2;
  const midLng = (a.lng + b.lng) / 2;
  const dLat = b.lat - a.lat;
  const dLng = b.lng - a.lng;
  const ctrl = { lat: midLat - dLng * bend, lng: midLng + dLat * bend };
  const pts: LatLng[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push({
      lat: u * u * a.lat + 2 * u * t * ctrl.lat + t * t * b.lat,
      lng: u * u * a.lng + 2 * u * t * ctrl.lng + t * t * b.lng,
    });
  }
  return pts;
}

/** Point at fraction `t` (0..1) along a polyline, by index interpolation. */
export function pointAlong(path: LatLng[], t: number): LatLng {
  if (path.length === 0) throw new Error("empty path");
  const clamped = Math.min(1, Math.max(0, t));
  const f = clamped * (path.length - 1);
  const i = Math.floor(f);
  const j = Math.min(path.length - 1, i + 1);
  const k = f - i;
  return {
    lat: path[i].lat + (path[j].lat - path[i].lat) * k,
    lng: path[i].lng + (path[j].lng - path[i].lng) * k,
  };
}

/** Random point roughly `km` away from `origin`. */
export function randomNearby(origin: LatLng, km: number): LatLng {
  return offsetPoint(origin, km, Math.random() * Math.PI * 2);
}

/** Point `km` away from `origin` in direction `angle` (radians). */
export function offsetPoint(origin: LatLng, km: number, angle: number): LatLng {
  const dLat = (km / 111) * Math.cos(angle);
  const dLng = (km / (111 * Math.cos((origin.lat * Math.PI) / 180))) * Math.sin(angle);
  return { lat: origin.lat + dLat, lng: origin.lng + dLng };
}
