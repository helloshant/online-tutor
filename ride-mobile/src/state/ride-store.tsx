import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Place } from "@shared/geo";
import type { VehicleType } from "@shared/fares";
import { DEFAULTS, loadPersisted, savePersisted, type Persisted, type RideRecord, type SavedPlaces } from "@/lib/storage";

type Store = Persisted & {
  ready: boolean;
  pickup: Place | null;
  drop: Place | null;
  vehicle: VehicleType;
  setPickup: (p: Place | null) => void;
  setDrop: (p: Place | null) => void;
  setVehicle: (v: VehicleType) => void;
  addRide: (r: RideRecord) => void;
  clearHistory: () => void;
  setWallet: (n: number) => void;
  setSaved: (s: SavedPlaces) => void;
  /** True while a ride is searching / assigned / ongoing (blocks "Book again"). */
  tripActive: boolean;
  setTripActive: (b: boolean) => void;
};

const Ctx = createContext<Store | null>(null);

export function RideStoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Persisted>(DEFAULTS);
  const [ready, setReady] = useState(false);
  const [pickup, setPickup] = useState<Place | null>(null);
  const [drop, setDrop] = useState<Place | null>(null);
  const [vehicle, setVehicle] = useState<VehicleType>("bike");
  const [tripActive, setTripActive] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    loadPersisted().then((p) => {
      loaded.current = true;
      setData(p);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (loaded.current) void savePersisted(data);
  }, [data]);

  const addRide = useCallback((r: RideRecord) => setData((d) => ({ ...d, history: [r, ...d.history] })), []);
  const clearHistory = useCallback(() => setData((d) => ({ ...d, history: [] })), []);
  const setWallet = useCallback((wallet: number) => setData((d) => ({ ...d, wallet })), []);
  const setSaved = useCallback((saved: SavedPlaces) => setData((d) => ({ ...d, saved })), []);

  const value = useMemo<Store>(
    () => ({
      ...data,
      ready,
      pickup,
      drop,
      vehicle,
      setPickup,
      setDrop,
      setVehicle,
      addRide,
      clearHistory,
      setWallet,
      setSaved,
      tripActive,
      setTripActive,
    }),
    [data, ready, pickup, drop, vehicle, addRide, clearHistory, setWallet, setSaved, tripActive],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRideStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useRideStore must be used inside <RideStoreProvider>");
  return s;
}
