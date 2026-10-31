import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Place } from "@shared/geo";
import type { VehicleType } from "@shared/fares";

export type PaymentMethod = "cash" | "upi" | "wallet";

export type RideRecord = {
  id: string;
  createdAt: string;
  pickup: Place;
  drop: Place;
  vehicle: VehicleType;
  fare: number;
  tip: number;
  distanceKm: number;
  durationMin: number;
  payment: PaymentMethod;
  captainName: string;
  vehicleNumber: string;
  rating?: number;
  status: "completed" | "cancelled";
};

export type SavedPlaces = { home?: Place; work?: Place };

export type Persisted = { history: RideRecord[]; wallet: number; saved: SavedPlaces };

const KEY = "sawari.mobile.v1";
export const DEFAULTS: Persisted = { history: [], wallet: 250, saved: {} };

export async function loadPersisted(): Promise<Persisted> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persisted>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export async function savePersisted(p: Persisted): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify({ ...p, history: p.history.slice(0, 50) }));
  } catch {
    /* storage unavailable — keep in memory only */
  }
}
