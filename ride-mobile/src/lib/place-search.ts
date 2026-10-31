import type { Place } from "@shared/geo";
import { searchLocalPlaces } from "@shared/places";

type NominatimHit = { place_id: number; display_name: string; lat: string; lon: string; name?: string };

/** Curated places first, then OpenStreetMap Nominatim (India only). */
export async function searchPlaces(q: string, signal?: AbortSignal): Promise<Place[]> {
  const local = searchLocalPlaces(q);
  if (q.trim().length < 3) return local;
  try {
    const url =
      "https://nominatim.openstreetmap.org/search?format=json&countrycodes=in&limit=6&q=" + encodeURIComponent(q.trim());
    const res = await fetch(url, {
      signal,
      headers: { "User-Agent": "sawari-mobile-demo/1.0", "Accept-Language": "en" },
    });
    if (!res.ok) return local;
    const hits = (await res.json()) as NominatimHit[];
    const remote = hits.map<Place>((h) => {
      const [first, ...rest] = h.display_name.split(", ");
      return { id: `osm-${h.place_id}`, name: h.name || first, address: rest.slice(0, 3).join(", "), lat: Number(h.lat), lng: Number(h.lon) };
    });
    return [...local, ...remote].slice(0, 10);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return local;
  }
}
