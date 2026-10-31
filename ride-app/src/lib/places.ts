import type { Place } from "./geo";

/** Popular spots used as quick suggestions and for offline search. */
export const POPULAR_PLACES: Place[] = [
  { id: "blr-mg", name: "MG Road Metro", address: "MG Road, Bengaluru", lat: 12.9755, lng: 77.6068 },
  { id: "blr-kor", name: "Koramangala 5th Block", address: "Koramangala, Bengaluru", lat: 12.9352, lng: 77.6245 },
  { id: "blr-ind", name: "Indiranagar 100ft Road", address: "Indiranagar, Bengaluru", lat: 12.9719, lng: 77.6412 },
  { id: "blr-hsr", name: "HSR Layout Sector 1", address: "HSR Layout, Bengaluru", lat: 12.9116, lng: 77.6474 },
  { id: "blr-wf", name: "Whitefield ITPL", address: "Whitefield, Bengaluru", lat: 12.9857, lng: 77.7366 },
  { id: "blr-ec", name: "Electronic City Phase 1", address: "Electronic City, Bengaluru", lat: 12.8452, lng: 77.6602 },
  { id: "blr-mjs", name: "Majestic Bus Stand", address: "Kempegowda Bus Station, Bengaluru", lat: 12.9767, lng: 77.5713 },
  { id: "blr-ksr", name: "KSR Bengaluru City Junction", address: "Railway Station, Bengaluru", lat: 12.9781, lng: 77.5695 },
  { id: "blr-jay", name: "Jayanagar 4th Block", address: "Jayanagar, Bengaluru", lat: 12.925, lng: 77.5838 },
  { id: "blr-mal", name: "Malleshwaram 8th Cross", address: "Malleshwaram, Bengaluru", lat: 13.0031, lng: 77.5643 },
  { id: "blr-heb", name: "Hebbal Flyover", address: "Hebbal, Bengaluru", lat: 13.0358, lng: 77.597 },
  { id: "blr-mar", name: "Marathahalli Bridge", address: "Marathahalli, Bengaluru", lat: 12.9569, lng: 77.7011 },
  { id: "blr-btm", name: "BTM Layout 2nd Stage", address: "BTM Layout, Bengaluru", lat: 12.9166, lng: 77.6101 },
  { id: "blr-cub", name: "Cubbon Park", address: "Kasturba Road, Bengaluru", lat: 12.9763, lng: 77.5929 },
  { id: "blr-lal", name: "Lalbagh Botanical Garden", address: "Mavalli, Bengaluru", lat: 12.9507, lng: 77.5848 },
  { id: "blr-orion", name: "Orion Mall", address: "Rajajinagar, Bengaluru", lat: 13.011, lng: 77.5551 },
  { id: "blr-phx", name: "Phoenix Marketcity", address: "Mahadevapura, Bengaluru", lat: 12.9975, lng: 77.6963 },
  { id: "blr-bel", name: "Bellandur Ecospace", address: "Bellandur, Bengaluru", lat: 12.9268, lng: 77.6814 },
  { id: "blr-yel", name: "Yelahanka New Town", address: "Yelahanka, Bengaluru", lat: 13.1007, lng: 77.5963 },
  { id: "blr-air", name: "Kempegowda Intl Airport (T1)", address: "Devanahalli, Bengaluru", lat: 13.1989, lng: 77.7068 },
];

export const DEFAULT_CENTER = { lat: 12.9716, lng: 77.5946 };

export function searchLocalPlaces(q: string): Place[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return POPULAR_PLACES.slice(0, 6);
  return POPULAR_PLACES.filter(
    (p) => p.name.toLowerCase().includes(needle) || p.address.toLowerCase().includes(needle),
  );
}
