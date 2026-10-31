import { roadDistanceKm, type LatLng } from "./geo";

// Shared by the web app (ride-app) and the mobile app (ride-mobile): keep this
// module free of DOM / Node / React Native APIs.

export type VehicleType = "bike" | "auto" | "cab" | "cab_premium";

export type Vehicle = {
  type: VehicleType;
  label: string;
  tagline: string;
  icon: string;
  seats: number;
  base: number; // ₹
  perKm: number; // ₹
  perMin: number; // ₹
  minFare: number; // ₹
  avgSpeedKmh: number; // city average, used for trip time
};

export const VEHICLES: Vehicle[] = [
  { type: "bike", label: "Bike", tagline: "Beat the traffic", icon: "🏍️", seats: 1, base: 20, perKm: 7, perMin: 1, minFare: 30, avgSpeedKmh: 24 },
  { type: "auto", label: "Auto", tagline: "Everyday commute", icon: "🛺", seats: 3, base: 30, perKm: 13, perMin: 1.5, minFare: 40, avgSpeedKmh: 20 },
  { type: "cab", label: "Cab Economy", tagline: "Comfy AC rides", icon: "🚗", seats: 4, base: 50, perKm: 16, perMin: 2, minFare: 80, avgSpeedKmh: 19 },
  { type: "cab_premium", label: "Cab Premium", tagline: "Top-rated sedans", icon: "🚘", seats: 4, base: 70, perKm: 21, perMin: 2.5, minFare: 120, avgSpeedKmh: 19 },
];

export function vehicleByType(t: VehicleType): Vehicle {
  return VEHICLES.find((v) => v.type === t) ?? VEHICLES[0];
}

export type Coupon = { code: string; description: string; percent: number; maxOff: number; onlyFor?: VehicleType[] };

export const COUPONS: Coupon[] = [
  { code: "FIRST50", description: "50% off, up to ₹75", percent: 50, maxOff: 75 },
  { code: "BIKE20", description: "20% off bike rides, up to ₹40", percent: 20, maxOff: 40, onlyFor: ["bike"] },
  { code: "AUTO15", description: "15% off auto rides, up to ₹30", percent: 15, maxOff: 30, onlyFor: ["auto"] },
];

export function findCoupon(code: string | undefined | null): Coupon | undefined {
  if (!code) return undefined;
  return COUPONS.find((c) => c.code === code.trim().toUpperCase());
}

/** Peak-hour multiplier (IST). */
export function surgeFor(date: Date): number {
  const istHour = new Date(date.getTime() + 5.5 * 3600_000).getUTCHours();
  if ((istHour >= 8 && istHour < 11) || (istHour >= 17 && istHour < 21)) return 1.2;
  if (istHour >= 23 || istHour < 5) return 1.1; // night charge
  return 1;
}

export type Quote = {
  vehicle: VehicleType;
  distanceKm: number;
  durationMin: number;
  surge: number;
  subtotal: number;
  discount: number;
  total: number;
  pickupEtaMin: number;
  couponApplied?: string;
  couponError?: string;
};

const round = (n: number) => Math.round(n);

export function quoteFor(
  vehicle: Vehicle,
  pickup: LatLng,
  drop: LatLng,
  opts: { now?: Date; coupon?: string | null } = {},
): Quote {
  const distanceKm = Math.max(0.5, roadDistanceKm(pickup, drop));
  const durationMin = Math.max(3, (distanceKm / vehicle.avgSpeedKmh) * 60);
  const surge = surgeFor(opts.now ?? new Date());
  const raw = (vehicle.base + vehicle.perKm * distanceKm + vehicle.perMin * durationMin) * surge;
  const subtotal = round(Math.max(vehicle.minFare, raw));

  let discount = 0;
  let couponApplied: string | undefined;
  let couponError: string | undefined;
  if (opts.coupon) {
    const c = findCoupon(opts.coupon);
    if (!c) couponError = "Invalid coupon code";
    else if (c.onlyFor && !c.onlyFor.includes(vehicle.type)) couponError = `Valid only on ${c.onlyFor.map((t) => vehicleByType(t).label).join(", ")}`;
    else {
      discount = round(Math.min(c.maxOff, (subtotal * c.percent) / 100));
      couponApplied = c.code;
    }
  }

  // Bikes are usually closest; cabs take longer to reach.
  const etaBase = { bike: 2, auto: 3, cab: 4, cab_premium: 6 }[vehicle.type];

  return {
    vehicle: vehicle.type,
    distanceKm: Math.round(distanceKm * 10) / 10,
    durationMin: round(durationMin),
    surge,
    subtotal,
    discount,
    total: Math.max(0, subtotal - discount),
    pickupEtaMin: etaBase + Math.floor(Math.random() * 3),
    couponApplied,
    couponError,
  };
}

export function quoteAll(pickup: LatLng, drop: LatLng, opts: { now?: Date; coupon?: string | null } = {}): Quote[] {
  return VEHICLES.map((v) => quoteFor(v, pickup, drop, opts));
}
