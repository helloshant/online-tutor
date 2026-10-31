"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LocationInput from "./location-input";
import SideDrawer from "./side-drawer";
import { curvedRoute, offsetPoint, pointAlong, randomNearby, type LatLng, type Place } from "@/lib/geo";
import { DEFAULT_CENTER, POPULAR_PLACES } from "@/lib/places";
import { COUPONS, VEHICLES, vehicleByType, type Quote, type VehicleType } from "@/lib/fares";
import { randomCaptain, randomOtp, type Captain } from "@/lib/captains";
import {
  loadHistory,
  loadSaved,
  loadWallet,
  saveHistory,
  saveSaved,
  saveWallet,
  type PaymentMethod,
  type RideRecord,
  type SavedPlaces,
} from "@/lib/storage";

const MapView = dynamic(() => import("./map-view"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center bg-zinc-200 text-sm text-zinc-500">Loading map…</div>,
});

type Phase = "plan" | "searching" | "assigned" | "arrived" | "ongoing" | "completed";

type Trip = {
  quote: Quote;
  captain: Captain;
  otp: string;
  approach: LatLng[];
  route: LatLng[];
  payment: PaymentMethod;
};

/** Simulation clock: how many real seconds represent one "minute" of travel. */
const SEC_PER_MIN = 2.5;

const rupee = (n: number) => `₹${n.toLocaleString("en-IN")}`;

function dropPinPlace(p: LatLng, label: string): Place {
  return {
    id: `pin-${p.lat.toFixed(5)}-${p.lng.toFixed(5)}`,
    name: label,
    address: `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`,
    lat: p.lat,
    lng: p.lng,
  };
}

export default function RideApp() {
  // ---- persisted user data -------------------------------------------------
  const [history, setHistory] = useState<RideRecord[]>([]);
  const [wallet, setWallet] = useState(0);
  const [saved, setSaved] = useState<SavedPlaces>({});
  useEffect(() => {
    // localStorage is only available after hydration.
    /* eslint-disable react-hooks/set-state-in-effect */
    setHistory(loadHistory());
    setWallet(loadWallet());
    setSaved(loadSaved());
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  // ---- planning state ------------------------------------------------------
  const [pickup, setPickup] = useState<Place | null>(null);
  const [drop, setDrop] = useState<Place | null>(null);
  const [picking, setPicking] = useState<"pickup" | "drop" | null>(null);
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [selected, setSelected] = useState<VehicleType>("bike");
  const [payment, setPayment] = useState<PaymentMethod>("cash");
  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // ---- trip state ----------------------------------------------------------
  const [phase, setPhase] = useState<Phase>("plan");
  const [trip, setTrip] = useState<Trip | null>(null);
  const [progress, setProgress] = useState(0); // 0..1 within the current moving phase
  const [rating, setRating] = useState(0);
  const [tip, setTip] = useState(0);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  // Fetch fare quotes whenever both ends (or the coupon) change.
  useEffect(() => {
    if (!pickup || !drop) {
      setQuotes(null); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }
    const ctrl = new AbortController();
    fetch("/api/fare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pickup, drop, coupon }),
      signal: ctrl.signal,
    })
      .then((r) => r.json())
      .then((d: { quotes?: Quote[]; error?: string }) => {
        if (d.error || !d.quotes) throw new Error(d.error ?? "Could not fetch fares");
        setQuotes(d.quotes);
        setQuoteError(null);
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setQuoteError(e.message);
      });
    return () => ctrl.abort();
  }, [pickup, drop, coupon]);

  const selectedQuote = quotes?.find((q) => q.vehicle === selected) ?? null;
  const couponMsg = selectedQuote?.couponError ?? (selectedQuote?.couponApplied ? `${selectedQuote.couponApplied} applied — you save ${rupee(selectedQuote.discount)}` : null);

  const tripRoute = useMemo(() => (pickup && drop ? curvedRoute(pickup, drop) : null), [pickup, drop]);

  // Ambient idle captains near the pickup point (only while planning).
  const nearby = useMemo(() => {
    if (phase !== "plan") return [];
    const origin = pickup ?? DEFAULT_CENTER;
    return Array.from({ length: 8 }, (_, i) => ({
      // Deterministic scatter (render must stay pure).
      position: offsetPoint(origin, 0.35 + ((i * 7) % 8) * 0.18, i * 2.399),
      icon: VEHICLES[i % 3].icon,
    }));
  }, [pickup, phase]);

  // ---- map interaction -----------------------------------------------------
  const onMapClick = useCallback(
    (p: LatLng) => {
      if (phase !== "plan") return;
      const target = picking ?? (!pickup ? "pickup" : !drop ? "drop" : null);
      if (!target) return;
      if (target === "pickup") setPickup(dropPinPlace(p, "Pinned pickup"));
      else setDrop(dropPinPlace(p, "Pinned drop"));
      setPicking(null);
    },
    [phase, picking, pickup, drop],
  );

  const locateMe = useCallback(() => {
    if (!navigator.geolocation) return flash("Location not supported on this device");
    navigator.geolocation.getCurrentPosition(
      (pos) => setPickup(dropPinPlace({ lat: pos.coords.latitude, lng: pos.coords.longitude }, "Current location")),
      () => flash("Couldn't get your location — pick on the map instead"),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  }, [flash]);

  // ---- booking flow --------------------------------------------------------
  const book = () => {
    if (!pickup || !drop || !selectedQuote) return;
    if (payment === "wallet" && wallet < selectedQuote.total) {
      flash(`Wallet balance ${rupee(wallet)} is too low — add money or pick another method`);
      return;
    }
    setPhase("searching");
    setProgress(0);
  };

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  // Searching → assigned after a short "matching" delay.
  useEffect(() => {
    if (phase !== "searching" || !pickup || !drop || !selectedQuote) return;
    const t = setTimeout(() => {
      const captainStart = randomNearby(pickup, 0.6 + selectedQuote.pickupEtaMin * 0.25);
      setTrip({
        quote: selectedQuote,
        captain: randomCaptain(selectedQuote.vehicle),
        otp: randomOtp(),
        approach: curvedRoute(captainStart, pickup, 40, -0.25),
        route: curvedRoute(pickup, drop),
        payment,
      });
      setProgress(0);
      setPhase("assigned");
    }, 3500);
    timers.current.push(t);
    return () => clearTimeout(t);
    // selectedQuote is intentionally frozen at booking time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Animate the captain along approach (assigned) or trip route (ongoing).
  useEffect(() => {
    if (!trip || (phase !== "assigned" && phase !== "ongoing")) return;
    const minutes = phase === "assigned" ? trip.quote.pickupEtaMin : Math.min(trip.quote.durationMin, 16);
    const totalMs = Math.max(6000, minutes * SEC_PER_MIN * 1000);
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / totalMs);
      setProgress(p);
      if (p < 1) raf = requestAnimationFrame(tick);
      else setPhase(phase === "assigned" ? "arrived" : "completed");
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, trip]);

  const startRide = () => {
    setProgress(0);
    setPhase("ongoing");
    flash("OTP verified — enjoy your ride!");
  };

  const record = (status: RideRecord["status"], extra: Partial<RideRecord> = {}) => {
    if (!trip || !pickup || !drop) return;
    const r: RideRecord = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      pickup,
      drop,
      vehicle: trip.quote.vehicle,
      fare: status === "completed" ? trip.quote.total : 0,
      tip: 0,
      distanceKm: trip.quote.distanceKm,
      durationMin: trip.quote.durationMin,
      payment: trip.payment,
      captainName: trip.captain.name,
      vehicleNumber: trip.captain.vehicleNumber,
      status,
      ...extra,
    };
    const next = [r, ...history];
    setHistory(next);
    saveHistory(next);
  };

  const resetTrip = (keepPlaces = false) => {
    clearTimers();
    setTrip(null);
    setPhase("plan");
    setProgress(0);
    setRating(0);
    setTip(0);
    if (!keepPlaces) {
      setDrop(null);
      setCoupon(null);
      setCouponInput("");
    }
  };

  const cancel = () => {
    if (phase === "searching") {
      resetTrip(true);
      flash("Search cancelled");
      return;
    }
    record("cancelled");
    resetTrip(true);
    flash("Ride cancelled");
  };

  const finish = () => {
    if (!trip) return;
    const total = trip.quote.total + tip;
    if (trip.payment === "wallet") {
      if (wallet < total) return flash("Not enough wallet balance for the tip — lower it or add money");
      const w = wallet - total;
      setWallet(w);
      saveWallet(w);
    }
    record("completed", { tip, rating: rating || undefined });
    resetTrip();
    flash(trip.payment === "cash" ? `Paid ${rupee(total)} in cash. Thanks for riding!` : `Paid ${rupee(total)} via ${trip.payment.toUpperCase()}. Thanks for riding!`);
  };

  // ---- derived map state ---------------------------------------------------
  const vehiclePos = useMemo(() => {
    if (!trip) return null;
    const icon = vehicleByType(trip.quote.vehicle).icon;
    if (phase === "assigned") return { position: pointAlong(trip.approach, progress), icon };
    if (phase === "arrived") return { position: trip.approach[trip.approach.length - 1], icon };
    if (phase === "ongoing") return { position: pointAlong(trip.route, progress), icon };
    return null;
  }, [trip, phase, progress]);

  const remainingRoute = useMemo(() => {
    if (!trip || phase !== "ongoing") return tripRoute;
    const from = Math.floor(progress * (trip.route.length - 1));
    return [pointAlong(trip.route, progress), ...trip.route.slice(from + 1)];
  }, [trip, phase, progress, tripRoute]);

  const shortcuts = [
    saved.home && { label: "🏠 Home", place: saved.home },
    saved.work && { label: "💼 Work", place: saved.work },
  ].filter(Boolean) as { label: string; place: Place }[];

  const etaLeft = trip
    ? Math.max(1, Math.ceil((1 - progress) * (phase === "assigned" ? trip.quote.pickupEtaMin : trip.quote.durationMin)))
    : 0;

  // ---- render --------------------------------------------------------------
  return (
    <div className="relative flex h-dvh w-full flex-col overflow-hidden md:flex-row">
      {/* Map */}
      <div className="relative h-[42dvh] w-full md:order-2 md:h-full md:flex-1">
        <MapView
          center={DEFAULT_CENTER}
          pickup={pickup}
          drop={drop}
          route={remainingRoute}
          approach={phase === "assigned" && trip ? trip.approach.slice(Math.floor(progress * (trip.approach.length - 1))) : null}
          vehicle={vehiclePos}
          nearby={nearby}
          onMapClick={onMapClick}
        />
        {picking && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-[1000] mx-auto w-fit rounded-full bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg">
            Tap the map to set {picking}
          </div>
        )}
      </div>

      {/* Bottom sheet / side panel */}
      <section className="relative z-[1001] -mt-4 flex min-h-0 flex-1 flex-col rounded-t-3xl bg-white shadow-[0_-8px_24px_rgba(0,0,0,0.08)] md:order-1 md:mt-0 md:w-[420px] md:flex-none md:rounded-none md:shadow-xl dark:bg-zinc-950">
        <header className="flex items-center justify-between px-5 pt-4 pb-2">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber-400 text-lg font-black text-zinc-900">S</span>
            <div>
              <h1 className="text-lg leading-none font-extrabold tracking-tight">Sawari</h1>
              <p className="text-xs text-zinc-500">Bike · Auto · Cab</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDrawer(true)}
            className="flex items-center gap-2 rounded-full bg-zinc-100 px-3 py-1.5 text-sm font-medium hover:bg-zinc-200 dark:bg-zinc-800"
            aria-label="Open account menu"
          >
            <span>👛 {rupee(wallet)}</span>
            <span className="text-lg leading-none">☰</span>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {phase === "plan" && (
            <div className="space-y-4">
              <div className="relative space-y-2">
                <LocationInput
                  label="Pickup location"
                  dot="green"
                  value={pickup}
                  placeholder="Where should we pick you up?"
                  onSelect={setPickup}
                  onPickOnMap={() => setPicking("pickup")}
                  onUseCurrent={locateMe}
                  shortcuts={shortcuts}
                />
                <LocationInput
                  label="Drop location"
                  dot="red"
                  value={drop}
                  placeholder="Where are you going?"
                  onSelect={setDrop}
                  onPickOnMap={() => setPicking("drop")}
                  shortcuts={shortcuts}
                />
                {pickup && drop && (
                  <button
                    type="button"
                    aria-label="Swap pickup and drop"
                    onClick={() => {
                      setPickup(drop);
                      setDrop(pickup);
                    }}
                    className="absolute top-1/2 right-2 z-10 -translate-y-1/2 rounded-full border border-zinc-200 bg-white px-2 py-1 text-sm shadow dark:border-zinc-700 dark:bg-zinc-900"
                  >
                    ⇅
                  </button>
                )}
              </div>

              {!quotes && (
                <div>
                  <h2 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Popular places</h2>
                  <div className="flex flex-wrap gap-2">
                    {POPULAR_PLACES.slice(0, 8).map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => (pickup ? setDrop(p) : setPickup(p))}
                        className="rounded-full border border-zinc-200 px-3 py-1.5 text-xs hover:border-amber-400 hover:bg-amber-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                  <p className="mt-4 rounded-xl bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                    Tip: tap the map to drop pins. Try coupon <b>FIRST50</b> for 50% off your ride.
                  </p>
                </div>
              )}

              {quoteError && <p className="text-sm text-red-600">{quoteError}</p>}

              {quotes && (
                <>
                  <div className="space-y-2" role="radiogroup" aria-label="Choose a ride">
                    {quotes.map((q) => {
                      const v = vehicleByType(q.vehicle);
                      const active = q.vehicle === selected;
                      return (
                        <button
                          key={q.vehicle}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => setSelected(q.vehicle)}
                          className={`flex w-full items-center gap-3 rounded-2xl border-2 p-3 text-left transition ${
                            active ? "border-amber-400 bg-amber-50 dark:bg-amber-950/40" : "border-transparent bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-900"
                          }`}
                        >
                          <span className="text-3xl">{v.icon}</span>
                          <span className="flex-1">
                            <span className="flex items-center gap-2 font-semibold">
                              {v.label}
                              <span className="text-xs font-normal text-zinc-500">👤 {v.seats}</span>
                            </span>
                            <span className="block text-xs text-zinc-500">
                              {v.tagline} · {q.pickupEtaMin} min away
                            </span>
                          </span>
                          <span className="text-right">
                            <span className="block font-bold">{rupee(q.total)}</span>
                            {q.discount > 0 && <span className="block text-xs text-zinc-400 line-through">{rupee(q.subtotal)}</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {selectedQuote && (
                    <p className="text-xs text-zinc-500">
                      {selectedQuote.distanceKm} km · ~{selectedQuote.durationMin} min trip
                      {selectedQuote.surge > 1 && <span className="ml-1 font-medium text-orange-600">· {selectedQuote.surge}× demand pricing</span>}
                    </p>
                  )}

                  <div className="flex gap-2">
                    {(["cash", "upi", "wallet"] as PaymentMethod[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setPayment(m)}
                        className={`flex-1 rounded-xl border px-2 py-2 text-xs font-medium ${
                          payment === m ? "border-zinc-900 bg-zinc-900 text-white dark:border-amber-400 dark:bg-amber-400 dark:text-zinc-900" : "border-zinc-200 dark:border-zinc-700"
                        }`}
                      >
                        {m === "cash" ? "💵 Cash" : m === "upi" ? "📱 UPI" : `👛 Wallet ${rupee(wallet)}`}
                      </button>
                    ))}
                  </div>

                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setCoupon(couponInput.trim() || null);
                    }}
                  >
                    <input
                      value={couponInput}
                      onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                      placeholder="Coupon code"
                      list="coupon-codes"
                      aria-label="Coupon code"
                      className="min-w-0 flex-1 rounded-xl bg-zinc-100 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-amber-400 dark:bg-zinc-800"
                    />
                    <datalist id="coupon-codes">
                      {COUPONS.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.description}
                        </option>
                      ))}
                    </datalist>
                    {coupon ? (
                      <button
                        type="button"
                        className="rounded-xl px-3 text-sm font-medium text-red-600"
                        onClick={() => {
                          setCoupon(null);
                          setCouponInput("");
                        }}
                      >
                        Remove
                      </button>
                    ) : (
                      <button type="submit" className="rounded-xl bg-zinc-200 px-3 text-sm font-medium dark:bg-zinc-700">
                        Apply
                      </button>
                    )}
                  </form>
                  {coupon && couponMsg && (
                    <p className={`text-xs ${selectedQuote?.couponError ? "text-red-600" : "text-green-700"}`}>{couponMsg}</p>
                  )}

                  <button
                    type="button"
                    onClick={book}
                    disabled={!selectedQuote}
                    className="w-full rounded-2xl bg-amber-400 py-3.5 text-base font-bold text-zinc-900 shadow hover:bg-amber-300 disabled:opacity-50"
                  >
                    Book {vehicleByType(selected).label}
                    {selectedQuote && ` · ${rupee(selectedQuote.total)}`}
                  </button>
                </>
              )}
            </div>
          )}

          {phase === "searching" && (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <div className="relative grid h-24 w-24 place-items-center">
                <span className="absolute inset-0 animate-ping rounded-full bg-amber-300 opacity-60" />
                <span className="relative text-5xl">{vehicleByType(selected).icon}</span>
              </div>
              <div>
                <h2 className="text-lg font-bold">Finding your captain…</h2>
                <p className="text-sm text-zinc-500">Matching you with the nearest {vehicleByType(selected).label.toLowerCase()} captain</p>
              </div>
              <button type="button" onClick={cancel} className="rounded-xl border border-zinc-300 px-5 py-2 text-sm font-medium dark:border-zinc-700">
                Cancel search
              </button>
            </div>
          )}

          {trip && (phase === "assigned" || phase === "arrived" || phase === "ongoing") && (
            <div className="space-y-4">
              <div className="rounded-2xl bg-zinc-900 p-4 text-white">
                <p className="text-xs tracking-wide text-zinc-400 uppercase">
                  {phase === "assigned" && "Captain is on the way"}
                  {phase === "arrived" && "Captain has arrived"}
                  {phase === "ongoing" && "On trip"}
                </p>
                <p className="text-2xl font-bold">
                  {phase === "assigned" && `Arriving in ${etaLeft} min`}
                  {phase === "arrived" && "Meet at pickup point"}
                  {phase === "ongoing" && `${etaLeft} min to drop`}
                </p>
                {phase !== "arrived" && (
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-700">
                    <div className="h-full bg-amber-400 transition-[width]" style={{ width: `${progress * 100}%` }} />
                  </div>
                )}
              </div>

              <div className="flex items-center gap-3">
                <span className="grid h-14 w-14 place-items-center rounded-full bg-amber-100 text-3xl">{trip.captain.avatar}</span>
                <div className="flex-1">
                  <p className="font-semibold">{trip.captain.name}</p>
                  <p className="text-xs text-zinc-500">
                    ⭐ {trip.captain.rating} · {trip.captain.trips.toLocaleString("en-IN")} trips
                  </p>
                </div>
                <div className="text-right">
                  <p className="rounded-md border-2 border-zinc-900 px-2 py-0.5 font-mono text-sm font-bold dark:border-zinc-200">{trip.captain.vehicleNumber}</p>
                  <p className="mt-1 text-xs text-zinc-500">{trip.captain.vehicleModel}</p>
                </div>
              </div>

              {phase !== "ongoing" && (
                <div className="flex items-center justify-between rounded-2xl border-2 border-dashed border-amber-400 p-3">
                  <span className="text-sm text-zinc-600 dark:text-zinc-300">Share OTP to start your ride</span>
                  <span className="font-mono text-2xl font-black tracking-[0.3em]" data-testid="otp">
                    {trip.otp}
                  </span>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2 text-xs font-medium">
                <a href={`tel:${trip.captain.phone.replace(/\s/g, "")}`} className="rounded-xl bg-zinc-100 py-2.5 text-center dark:bg-zinc-800">
                  📞 Call
                </a>
                <button
                  type="button"
                  className="rounded-xl bg-zinc-100 py-2.5 dark:bg-zinc-800"
                  onClick={async () => {
                    const text = `I'm riding with ${trip.captain.name} (${trip.captain.vehicleNumber}) from ${pickup?.name} to ${drop?.name}.`;
                    try {
                      if (navigator.share) await navigator.share({ title: "My Sawari trip", text });
                      else {
                        await navigator.clipboard.writeText(text);
                        flash("Trip details copied");
                      }
                    } catch {
                      /* user dismissed */
                    }
                  }}
                >
                  🔗 Share trip
                </button>
                <button type="button" className="rounded-xl bg-red-50 py-2.5 text-red-700 dark:bg-red-950 dark:text-red-300" onClick={() => flash("Emergency contacts & local police have been alerted (demo)")}>
                  🆘 SOS
                </button>
              </div>

              <div className="space-y-1 rounded-2xl bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
                <p>
                  <span className="mr-2 inline-block h-2 w-2 rounded-full bg-green-600" />
                  {pickup?.name}
                </p>
                <p>
                  <span className="mr-2 inline-block h-2 w-2 rounded-full bg-red-600" />
                  {drop?.name}
                </p>
                <p className="pt-1 text-xs text-zinc-500">
                  {rupee(trip.quote.total)} · {trip.payment.toUpperCase()} · {trip.quote.distanceKm} km
                </p>
              </div>

              {phase === "arrived" && (
                <button type="button" onClick={startRide} className="w-full rounded-2xl bg-amber-400 py-3.5 font-bold text-zinc-900">
                  Captain verified OTP — Start ride
                </button>
              )}
              {phase !== "ongoing" && (
                <button type="button" onClick={cancel} className="w-full py-2 text-sm font-medium text-red-600">
                  Cancel ride
                </button>
              )}
            </div>
          )}

          {trip && phase === "completed" && (
            <div className="space-y-4 py-2">
              <div className="text-center">
                <p className="text-4xl">🎉</p>
                <h2 className="text-xl font-bold">You&apos;ve reached {drop?.name}</h2>
                <p className="text-sm text-zinc-500">
                  {trip.quote.distanceKm} km · {trip.quote.durationMin} min with {trip.captain.name}
                </p>
              </div>

              <div className="space-y-1.5 rounded-2xl bg-zinc-50 p-4 text-sm dark:bg-zinc-900">
                <Row label="Ride fare" value={rupee(trip.quote.subtotal)} />
                {trip.quote.discount > 0 && <Row label={`Coupon ${trip.quote.couponApplied}`} value={`−${rupee(trip.quote.discount)}`} accent />}
                {tip > 0 && <Row label="Tip for captain" value={rupee(tip)} />}
                <div className="border-t border-zinc-200 pt-1.5 dark:border-zinc-700">
                  <Row label={<b>Total ({trip.payment.toUpperCase()})</b>} value={<b>{rupee(trip.quote.total + tip)}</b>} />
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm font-medium">Rate {trip.captain.name.split(" ")[0]}</p>
                <div className="flex gap-1" role="radiogroup" aria-label="Rating">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={rating === n}
                      aria-label={`${n} star${n > 1 ? "s" : ""}`}
                      onClick={() => setRating(n)}
                      className={`text-3xl transition ${n <= rating ? "scale-110" : "opacity-30 grayscale"}`}
                    >
                      ⭐
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="mb-2 text-sm font-medium">Add a tip</p>
                <div className="flex gap-2">
                  {[0, 10, 20, 30].map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTip(t)}
                      className={`flex-1 rounded-xl border py-2 text-sm ${tip === t ? "border-amber-400 bg-amber-50 font-semibold dark:bg-amber-950/40" : "border-zinc-200 dark:border-zinc-700"}`}
                    >
                      {t === 0 ? "No tip" : rupee(t)}
                    </button>
                  ))}
                </div>
              </div>

              <button type="button" onClick={finish} className="w-full rounded-2xl bg-amber-400 py-3.5 font-bold text-zinc-900">
                {trip.payment === "cash" ? `Paid ${rupee(trip.quote.total + tip)} in cash` : `Pay ${rupee(trip.quote.total + tip)}`}
              </button>
            </div>
          )}
        </div>
      </section>

      <SideDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        history={history}
        wallet={wallet}
        onAddMoney={(n) => {
          const w = wallet + n;
          setWallet(w);
          saveWallet(w);
          flash(`${rupee(n)} added to wallet`);
        }}
        saved={saved}
        onSave={(kind) => {
          if (!pickup) return flash("Set a pickup location first, then save it");
          const s = { ...saved, [kind]: pickup };
          setSaved(s);
          saveSaved(s);
          flash(`Saved "${pickup.name}" as ${kind}`);
        }}
        onRebook={(r) => {
          if (phase !== "plan") return flash("Finish your current ride first");
          setPickup(r.pickup);
          setDrop(r.drop);
          setSelected(r.vehicle);
          setDrawer(false);
        }}
        onClearHistory={() => {
          setHistory([]);
          saveHistory([]);
        }}
      />

      {toast && (
        <div role="status" className="fixed bottom-6 left-1/2 z-[3000] w-[90%] max-w-sm -translate-x-1/2 rounded-xl bg-zinc-900 px-4 py-3 text-center text-sm text-white shadow-2xl">
          {toast}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, accent }: { label: React.ReactNode; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className={`flex justify-between ${accent ? "text-green-700 dark:text-green-400" : ""}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
