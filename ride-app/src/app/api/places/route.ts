import type { NextRequest } from "next/server";
import type { Place } from "@/lib/geo";
import { searchLocalPlaces } from "@/lib/places";

type NominatimHit = { place_id: number; display_name: string; lat: string; lon: string; name?: string };

/**
 * Place search: curated local places first, then OpenStreetMap Nominatim
 * (India only). If Nominatim is unreachable we just return local results.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  const local = searchLocalPlaces(q);
  if (q.length < 3) return Response.json({ places: local });

  let remote: Place[] = [];
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", q);
    url.searchParams.set("format", "json");
    url.searchParams.set("countrycodes", "in");
    url.searchParams.set("limit", "6");
    const res = await fetch(url, {
      headers: { "User-Agent": "sawari-ride-demo/0.1", "Accept-Language": "en" },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const hits = (await res.json()) as NominatimHit[];
      remote = hits.map((h) => {
        const [first, ...rest] = h.display_name.split(", ");
        return {
          id: `osm-${h.place_id}`,
          name: h.name || first,
          address: rest.slice(0, 3).join(", "),
          lat: Number(h.lat),
          lng: Number(h.lon),
        };
      });
    }
  } catch {
    /* offline or rate-limited — local results only */
  }

  return Response.json({ places: [...local, ...remote].slice(0, 8) });
}
