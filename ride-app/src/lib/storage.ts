import type { Place } from "./geo";
import type { VehicleType } from "./fares";

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

const HISTORY_KEY = "sawari.history.v1";
const WALLET_KEY = "sawari.wallet.v1";
const SAVED_KEY = "sawari.saved.v1";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — keep in memory only */
  }
}

export const loadHistory = () => read<RideRecord[]>(HISTORY_KEY, []);
export const saveHistory = (h: RideRecord[]) => write(HISTORY_KEY, h.slice(0, 50));

export const loadWallet = () => read<number>(WALLET_KEY, 250);
export const saveWallet = (n: number) => write(WALLET_KEY, n);

export type SavedPlaces = { home?: Place; work?: Place };
export const loadSaved = () => read<SavedPlaces>(SAVED_KEY, {});
export const saveSaved = (s: SavedPlaces) => write(SAVED_KEY, s);
