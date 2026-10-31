import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Location from "expo-location";
import RideMap from "@/components/ride-map";
import { Button, Chip, Row } from "@/components/ui";
import { useRideStore } from "@/state/ride-store";
import { C, rupee } from "@/lib/theme";
import type { PaymentMethod } from "@/lib/storage";
import { curvedRoute, offsetPoint, pointAlong, randomNearby, type LatLng, type Place } from "@shared/geo";
import { DEFAULT_CENTER } from "@shared/places";
import { VEHICLES, quoteAll, vehicleByType, type Quote } from "@shared/fares";
import { randomCaptain, randomId, randomOtp, type Captain } from "@shared/captains";

type Phase = "plan" | "searching" | "assigned" | "arrived" | "ongoing" | "completed";

type Trip = { quote: Quote; captain: Captain; otp: string; approach: LatLng[]; route: LatLng[]; payment: PaymentMethod };

/** Simulation clock: real seconds per trip-minute. */
const SEC_PER_MIN = 2.5;

const pinPlace = (p: LatLng, name: string): Place => ({
  id: `pin-${p.lat.toFixed(5)}-${p.lng.toFixed(5)}`,
  name,
  address: `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`,
  lat: p.lat,
  lng: p.lng,
});

export default function Home() {
  const insets = useSafeAreaInsets();
  const store = useRideStore();
  const { pickup, drop, setPickup, setDrop, vehicle: selected, setVehicle: setSelected, wallet, setWallet, addRide, setTripActive } = store;

  const [phase, setPhase] = useState<Phase>("plan");
  const [trip, setTrip] = useState<Trip | null>(null);
  const [progress, setProgress] = useState(0);
  const [payment, setPayment] = useState<PaymentMethod>("cash");
  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [tip, setTip] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [sheetH, setSheetH] = useState(0);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => setTripActive(phase !== "plan"), [phase, setTripActive]);

  // Fares are computed on-device with the same pricing code as the web app.
  // Recomputed (during render) only when the inputs change, so the random
  // pickup ETAs stay stable between renders.
  const quoteKey = pickup && drop ? `${pickup.id}|${drop.id}|${coupon ?? ""}` : null;
  const [quoteState, setQuoteState] = useState<{ key: string | null; quotes: Quote[] | null }>({ key: null, quotes: null });
  if (quoteState.key !== quoteKey) {
    setQuoteState({ key: quoteKey, quotes: pickup && drop ? quoteAll(pickup, drop, { coupon }) : null });
  }
  const quotes = quoteState.key === quoteKey ? quoteState.quotes : null;
  const selectedQuote = quotes?.find((q) => q.vehicle === selected) ?? null;

  const nearby = useMemo(() => {
    if (phase !== "plan") return [];
    const origin = pickup ?? DEFAULT_CENTER;
    return Array.from({ length: 8 }, (_, i) => ({
      position: offsetPoint(origin, 0.35 + ((i * 7) % 8) * 0.18, i * 2.399),
      icon: VEHICLES[i % 3].icon,
    }));
  }, [pickup, phase]);

  // ---- location --------------------------------------------------------------
  const locateMe = useCallback(async () => {
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return flash("Location permission denied — tap the map to set pickup");
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setPickup(pinPlace({ lat: pos.coords.latitude, lng: pos.coords.longitude }, "Current location"));
    } catch {
      flash("Couldn't get your location — tap the map to set pickup");
    } finally {
      setLocating(false);
    }
  }, [flash, setPickup]);

  const onMapPress = (p: LatLng) => {
    if (phase !== "plan") return;
    if (!pickup) setPickup(pinPlace(p, "Pinned pickup"));
    else if (!drop) setDrop(pinPlace(p, "Pinned drop"));
  };

  // ---- booking flow ----------------------------------------------------------
  const book = () => {
    if (!pickup || !drop || !selectedQuote) return;
    if (payment === "wallet" && wallet < selectedQuote.total) {
      return flash(`Wallet balance ${rupee(wallet)} is too low — add money or pick another method`);
    }
    setPhase("searching");
  };

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (phase !== "searching" || !pickup || !drop || !selectedQuote) return;
    searchTimer.current = setTimeout(() => {
      const start = randomNearby(pickup, 0.6 + selectedQuote.pickupEtaMin * 0.25);
      setTrip({
        quote: selectedQuote,
        captain: randomCaptain(selectedQuote.vehicle),
        otp: randomOtp(),
        approach: curvedRoute(start, pickup, 40, -0.25),
        route: curvedRoute(pickup, drop),
        payment,
      });
      setProgress(0);
      setPhase("assigned");
    }, 3500);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
    // quote/payment are frozen at booking time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (!trip || (phase !== "assigned" && phase !== "ongoing")) return;
    const minutes = phase === "assigned" ? trip.quote.pickupEtaMin : Math.min(trip.quote.durationMin, 16);
    const totalMs = Math.max(6000, minutes * SEC_PER_MIN * 1000);
    const t0 = Date.now();
    const id = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / totalMs);
      setProgress(p);
      if (p >= 1) {
        clearInterval(id);
        setPhase(phase === "assigned" ? "arrived" : "completed");
      }
    }, 100);
    return () => clearInterval(id);
  }, [phase, trip]);

  const reset = (keepPlaces: boolean) => {
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

  const record = (status: "completed" | "cancelled", extra: { tip?: number; rating?: number } = {}) => {
    if (!trip || !pickup || !drop) return;
    addRide({
      id: randomId(),
      createdAt: new Date().toISOString(),
      pickup,
      drop,
      vehicle: trip.quote.vehicle,
      fare: status === "completed" ? trip.quote.total : 0,
      tip: extra.tip ?? 0,
      rating: extra.rating,
      distanceKm: trip.quote.distanceKm,
      durationMin: trip.quote.durationMin,
      payment: trip.payment,
      captainName: trip.captain.name,
      vehicleNumber: trip.captain.vehicleNumber,
      status,
    });
  };

  const cancel = () => {
    if (phase !== "searching") record("cancelled");
    reset(true);
    flash(phase === "searching" ? "Search cancelled" : "Ride cancelled");
  };

  const finish = () => {
    if (!trip) return;
    const total = trip.quote.total + tip;
    if (trip.payment === "wallet") {
      if (wallet < total) return flash("Not enough wallet balance for the tip — lower it or add money");
      setWallet(wallet - total);
    }
    record("completed", { tip, rating: rating || undefined });
    reset(false);
    flash(trip.payment === "cash" ? `Paid ${rupee(total)} in cash. Thanks for riding!` : `Paid ${rupee(total)} via ${trip.payment.toUpperCase()}. Thanks!`);
  };

  const shareTrip = async () => {
    if (!trip) return;
    try {
      await Share.share({ message: `I'm riding with ${trip.captain.name} (${trip.captain.vehicleNumber}) from ${pickup?.name} to ${drop?.name}.` });
    } catch {
      /* dismissed */
    }
  };

  // ---- derived map state -----------------------------------------------------
  const vehiclePos = useMemo(() => {
    if (!trip) return null;
    const icon = vehicleByType(trip.quote.vehicle).icon;
    if (phase === "assigned") return { position: pointAlong(trip.approach, progress), icon };
    if (phase === "arrived") return { position: trip.approach[trip.approach.length - 1], icon };
    if (phase === "ongoing") return { position: pointAlong(trip.route, progress), icon };
    return null;
  }, [trip, phase, progress]);

  const fullRoute = useMemo(() => (pickup && drop ? curvedRoute(pickup, drop) : null), [pickup, drop]);
  const route = useMemo(() => {
    if (!trip || phase !== "ongoing") return fullRoute;
    const from = Math.floor(progress * (trip.route.length - 1));
    return [pointAlong(trip.route, progress), ...trip.route.slice(from + 1)];
  }, [trip, phase, progress, fullRoute]);
  const approach = phase === "assigned" && trip ? trip.approach.slice(Math.floor(progress * (trip.approach.length - 1))) : null;

  const etaLeft = trip
    ? Math.max(1, Math.ceil((1 - progress) * (phase === "assigned" ? trip.quote.pickupEtaMin : trip.quote.durationMin)))
    : 0;

  const couponMsg = coupon
    ? (selectedQuote?.couponError ?? (selectedQuote?.couponApplied ? `${selectedQuote.couponApplied} applied — you save ${rupee(selectedQuote.discount)}` : null))
    : null;

  // ---- render ----------------------------------------------------------------
  return (
    <View style={styles.root}>
      <RideMap
        center={DEFAULT_CENTER}
        pickup={pickup}
        drop={drop}
        route={route}
        approach={approach}
        vehicle={vehiclePos}
        nearby={nearby}
        onPress={onMapPress}
        bottomInset={sheetH}
      />

      {/* Top bar */}
      <View style={[styles.topBar, { top: insets.top + 8 }]} pointerEvents="box-none">
        <View style={styles.brand}>
          <View style={styles.logo}>
            <Text style={styles.logoText}>S</Text>
          </View>
          <Text style={styles.brandText}>Sawari</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Open account" style={styles.walletBtn} onPress={() => router.push("/account")}>
          <Text style={styles.walletText}>👛 {rupee(wallet)}  ☰</Text>
        </Pressable>
      </View>

      {/* Bottom sheet */}
      <View
        style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}
        onLayout={(e) => setSheetH(e.nativeEvent.layout.height)}
      >
        <View style={styles.grabber} />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
          {phase === "plan" && (
            <>
              <View style={{ gap: 8 }}>
                <PlaceField dot={C.green} label="Pickup" value={pickup?.name} placeholder="Where should we pick you up?" onPress={() => router.push({ pathname: "/search", params: { target: "pickup" } })} />
                <PlaceField dot={C.red} label="Drop" value={drop?.name} placeholder="Where are you going?" onPress={() => router.push({ pathname: "/search", params: { target: "drop" } })} />
                {pickup && drop && (
                  <Pressable
                    accessibilityLabel="Swap pickup and drop"
                    style={styles.swap}
                    onPress={() => {
                      setPickup(drop);
                      setDrop(pickup);
                    }}
                  >
                    <Text>⇅</Text>
                  </Pressable>
                )}
              </View>

              {!quotes && (
                <>
                  <Pressable style={styles.locate} onPress={locateMe}>
                    {locating ? <ActivityIndicator color={C.ink} /> : <Text style={styles.locateText}>📍 Use my current location</Text>}
                  </Pressable>
                  <Text style={styles.hint}>Tip: tap the map to drop pins. Coupon FIRST50 gets 50% off.</Text>
                </>
              )}

              {quotes && (
                <>
                  {quotes.map((q) => {
                    const v = vehicleByType(q.vehicle);
                    const active = q.vehicle === selected;
                    return (
                      <Pressable
                        key={q.vehicle}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: active }}
                        accessibilityLabel={`${v.label} ${rupee(q.total)}`}
                        onPress={() => setSelected(q.vehicle)}
                        style={[styles.vehicle, active && styles.vehicleActive]}
                      >
                        <Text style={styles.vehicleIcon}>{v.icon}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.vehicleName}>
                            {v.label} <Text style={styles.muted}>👤 {v.seats}</Text>
                          </Text>
                          <Text style={styles.small}>
                            {v.tagline} · {q.pickupEtaMin} min away
                          </Text>
                        </View>
                        <View style={{ alignItems: "flex-end" }}>
                          <Text style={styles.price}>{rupee(q.total)}</Text>
                          {q.discount > 0 && <Text style={styles.strike}>{rupee(q.subtotal)}</Text>}
                        </View>
                      </Pressable>
                    );
                  })}

                  {selectedQuote && (
                    <Text style={styles.small}>
                      {selectedQuote.distanceKm} km · ~{selectedQuote.durationMin} min trip
                      {selectedQuote.surge > 1 ? `  ·  ${selectedQuote.surge}× demand pricing` : ""}
                    </Text>
                  )}

                  <View style={styles.row}>
                    {(["cash", "upi", "wallet"] as PaymentMethod[]).map((m) => (
                      <Chip key={m} active={payment === m} onPress={() => setPayment(m)} label={m === "cash" ? "💵 Cash" : m === "upi" ? "📱 UPI" : `👛 ${rupee(wallet)}`} />
                    ))}
                  </View>

                  <View style={styles.row}>
                    <TextInput
                      value={couponInput}
                      onChangeText={(t) => setCouponInput(t.toUpperCase())}
                      placeholder="Coupon code"
                      autoCapitalize="characters"
                      accessibilityLabel="Coupon code"
                      style={styles.input}
                      onSubmitEditing={() => setCoupon(couponInput.trim() || null)}
                    />
                    {coupon ? (
                      <Pressable
                        style={styles.couponBtn}
                        onPress={() => {
                          setCoupon(null);
                          setCouponInput("");
                        }}
                      >
                        <Text style={{ color: C.red, fontWeight: "600" }}>Remove</Text>
                      </Pressable>
                    ) : (
                      <Pressable style={[styles.couponBtn, { backgroundColor: C.line }]} onPress={() => setCoupon(couponInput.trim() || null)}>
                        <Text style={{ fontWeight: "600" }}>Apply</Text>
                      </Pressable>
                    )}
                  </View>
                  {couponMsg && <Text style={[styles.small, { color: selectedQuote?.couponError ? C.red : C.green }]}>{couponMsg}</Text>}

                  <Button label={`Book ${vehicleByType(selected).label}${selectedQuote ? ` · ${rupee(selectedQuote.total)}` : ""}`} onPress={book} />
                </>
              )}
            </>
          )}

          {phase === "searching" && (
            <View style={styles.center}>
              <Text style={{ fontSize: 48 }}>{vehicleByType(selected).icon}</Text>
              <ActivityIndicator color={C.brand} size="large" />
              <Text style={styles.h2}>Finding your captain…</Text>
              <Text style={styles.small}>Matching you with the nearest {vehicleByType(selected).label.toLowerCase()} captain</Text>
              <Button label="Cancel search" variant="outline" onPress={cancel} />
            </View>
          )}

          {trip && (phase === "assigned" || phase === "arrived" || phase === "ongoing") && (
            <>
              <View style={styles.statusCard}>
                <Text style={styles.statusLabel}>
                  {phase === "assigned" ? "CAPTAIN IS ON THE WAY" : phase === "arrived" ? "CAPTAIN HAS ARRIVED" : "ON TRIP"}
                </Text>
                <Text style={styles.statusTitle}>
                  {phase === "assigned" ? `Arriving in ${etaLeft} min` : phase === "arrived" ? "Meet at pickup point" : `${etaLeft} min to drop`}
                </Text>
                {phase !== "arrived" && (
                  <View style={styles.track}>
                    <View style={[styles.fill, { width: `${progress * 100}%` }]} />
                  </View>
                )}
              </View>

              <View style={styles.captain}>
                <View style={styles.avatar}>
                  <Text style={{ fontSize: 28 }}>{trip.captain.avatar}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.vehicleName}>{trip.captain.name}</Text>
                  <Text style={styles.small}>
                    ⭐ {trip.captain.rating} · {trip.captain.trips.toLocaleString("en-IN")} trips
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={styles.plate}>{trip.captain.vehicleNumber}</Text>
                  <Text style={styles.small}>{trip.captain.vehicleModel}</Text>
                </View>
              </View>

              {phase !== "ongoing" && (
                <View style={styles.otp}>
                  <Text style={styles.small}>Share OTP to start your ride</Text>
                  <Text style={styles.otpText} testID="otp">
                    {trip.otp}
                  </Text>
                </View>
              )}

              <View style={styles.row}>
                <Chip label="📞 Call" onPress={() => Linking.openURL(`tel:${trip.captain.phone.replace(/\s/g, "")}`)} />
                <Chip label="🔗 Share" onPress={shareTrip} />
                <Chip label="🆘 SOS" danger onPress={() => flash("Emergency contacts & local police alerted (demo)")} />
              </View>

              <View style={styles.summary}>
                <Text>🟢 {pickup?.name}</Text>
                <Text>🔴 {drop?.name}</Text>
                <Text style={styles.small}>
                  {rupee(trip.quote.total)} · {trip.payment.toUpperCase()} · {trip.quote.distanceKm} km
                </Text>
              </View>

              {phase === "arrived" && (
                <Button
                  label="Captain verified OTP — Start ride"
                  onPress={() => {
                    setProgress(0);
                    setPhase("ongoing");
                    flash("OTP verified — enjoy your ride!");
                  }}
                />
              )}
              {phase !== "ongoing" && <Button label="Cancel ride" variant="danger" onPress={cancel} />}
            </>
          )}

          {trip && phase === "completed" && (
            <>
              <View style={styles.center}>
                <Text style={{ fontSize: 40 }}>🎉</Text>
                <Text style={styles.h2}>You&apos;ve reached {drop?.name}</Text>
                <Text style={styles.small}>
                  {trip.quote.distanceKm} km · {trip.quote.durationMin} min with {trip.captain.name}
                </Text>
              </View>
              <View style={styles.summary}>
                <Row label="Ride fare" value={rupee(trip.quote.subtotal)} />
                {trip.quote.discount > 0 && <Row label={`Coupon ${trip.quote.couponApplied}`} value={`−${rupee(trip.quote.discount)}`} color={C.green} />}
                {tip > 0 && <Row label="Tip for captain" value={rupee(tip)} />}
                <Row label={`Total (${trip.payment.toUpperCase()})`} value={rupee(trip.quote.total + tip)} bold />
              </View>
              <Text style={styles.label}>Rate {trip.captain.name.split(" ")[0]}</Text>
              <View style={styles.row}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <Pressable key={n} accessibilityRole="radio" accessibilityLabel={`${n} star${n > 1 ? "s" : ""}`} accessibilityState={{ checked: rating === n }} onPress={() => setRating(n)}>
                    <Text style={{ fontSize: 32, opacity: n <= rating ? 1 : 0.25 }}>⭐</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.label}>Add a tip</Text>
              <View style={styles.row}>
                {[0, 10, 20, 30].map((t) => (
                  <Chip key={t} active={tip === t} label={t === 0 ? "No tip" : rupee(t)} onPress={() => setTip(t)} />
                ))}
              </View>
              <Button label={trip.payment === "cash" ? `Paid ${rupee(trip.quote.total + tip)} in cash` : `Pay ${rupee(trip.quote.total + tip)}`} onPress={finish} />
            </>
          )}
        </ScrollView>
      </View>

      {toast && (
        <View style={[styles.toast, { top: insets.top + 64 }]} accessibilityLiveRegion="polite">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}
    </View>
  );
}

function PlaceField({ dot, label, value, placeholder, onPress }: { dot: string; label: string; value?: string; placeholder: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${value ?? "not set"}`} style={styles.field} onPress={onPress}>
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <Text numberOfLines={1} style={[styles.fieldText, !value && { color: C.muted }]}>
        {value ?? placeholder}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.surface },
  topBar: { position: "absolute", left: 16, right: 16, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  brand: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.white, borderRadius: 999, paddingRight: 14, padding: 4, elevation: 3, shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  logo: { width: 30, height: 30, borderRadius: 15, backgroundColor: C.brand, alignItems: "center", justifyContent: "center" },
  logoText: { fontWeight: "900", color: C.ink },
  brandText: { fontWeight: "800", fontSize: 16, color: C.ink },
  walletBtn: { backgroundColor: C.white, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9, elevation: 3, shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  walletText: { fontWeight: "600", color: C.ink },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "62%", backgroundColor: C.white, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 16, paddingTop: 8, elevation: 12, shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 16, shadowOffset: { width: 0, height: -4 } },
  grabber: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: C.line, marginBottom: 10 },
  field: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: C.surface, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 13 },
  fieldText: { flex: 1, fontSize: 15, color: C.ink, paddingRight: 30 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  swap: { position: "absolute", right: 10, top: "50%", marginTop: -15, width: 30, height: 30, borderRadius: 15, backgroundColor: C.white, borderWidth: 1, borderColor: C.line, alignItems: "center", justifyContent: "center" },
  locate: { backgroundColor: C.brandSoft, borderRadius: 14, padding: 14, alignItems: "center" },
  locateText: { fontWeight: "600", color: C.ink },
  hint: { fontSize: 12, color: C.muted },
  vehicle: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 16, borderWidth: 2, borderColor: "transparent", backgroundColor: C.surface },
  vehicleActive: { borderColor: C.brand, backgroundColor: C.brandSoft },
  vehicleIcon: { fontSize: 32 },
  vehicleName: { fontWeight: "700", fontSize: 15, color: C.ink },
  muted: { color: C.muted, fontWeight: "400", fontSize: 12 },
  small: { fontSize: 12, color: C.muted },
  price: { fontWeight: "800", fontSize: 16, color: C.ink },
  strike: { fontSize: 12, color: C.muted, textDecorationLine: "line-through" },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: { flex: 1, backgroundColor: C.surface, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  couponBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12 },
  center: { alignItems: "center", gap: 10, paddingVertical: 12 },
  h2: { fontSize: 18, fontWeight: "800", color: C.ink, textAlign: "center" },
  statusCard: { backgroundColor: C.ink, borderRadius: 18, padding: 16 },
  statusLabel: { color: "#A1A1AA", fontSize: 11, letterSpacing: 1 },
  statusTitle: { color: C.white, fontSize: 22, fontWeight: "800", marginTop: 2 },
  track: { height: 6, backgroundColor: "#3F3F46", borderRadius: 3, marginTop: 12, overflow: "hidden" },
  fill: { height: 6, backgroundColor: C.brand },
  captain: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: { width: 54, height: 54, borderRadius: 27, backgroundColor: "#FEF3C7", alignItems: "center", justifyContent: "center" },
  plate: { borderWidth: 2, borderColor: C.ink, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, fontWeight: "800", fontFamily: "monospace", color: C.ink },
  otp: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderWidth: 2, borderStyle: "dashed", borderColor: C.brand, borderRadius: 16, padding: 12 },
  otpText: { fontSize: 26, fontWeight: "900", letterSpacing: 6, color: C.ink },
  summary: { backgroundColor: C.surface, borderRadius: 16, padding: 12, gap: 6 },
  label: { fontWeight: "600", color: C.ink },
  toast: { position: "absolute", left: 24, right: 24, backgroundColor: C.ink, borderRadius: 12, padding: 12 },
  toastText: { color: C.white, textAlign: "center" },
});
