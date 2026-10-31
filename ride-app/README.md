# Sawari — bike-taxi, auto & cab booking (demo)

A Rapido-style ride-hailing web app built with Next.js 16, React 19, Tailwind 4 and Leaflet/OpenStreetMap.
It is a standalone project and does not share code or deployment with the online-tutor app in the repo root.

## Run

```bash
cd ride-app
npm install
npm run dev        # http://localhost:3100
```

## What it does

- **Pickup & drop**: search (curated Bengaluru places plus OpenStreetMap Nominatim across India), tap the map to drop a pin, use your current location, swap ends, and save Home/Work shortcuts.
- **Fares for 4 vehicle types**: Bike, Auto, Cab Economy and Cab Premium. Each fare is base + per-km + per-minute, with a minimum fare. Peak hours (8–11, 17–21 IST) add 1.2× demand pricing and late nights add 1.1×.
- **Coupons**: `FIRST50` (50% up to ₹75), `BIKE20` (bike only), `AUTO15` (auto only).
- **Payment**: Cash, UPI or the in-app Wallet. The wallet starts at ₹250 and is demo money only.
- **Live trip flow**: searching → captain assigned (name, rating, plate, vehicle model, 4-digit OTP) → captain drives to the pickup on the map → OTP verified → ride in progress with the vehicle moving along the route → ride complete with fare breakdown, rating and tip.
- **During a trip**: Call, Share trip (Web Share API or clipboard), SOS (demo), and Cancel.
- **Account drawer**: ride history with "Book again", wallet top-up and saved places. Everything is kept in `localStorage`.

## Structure

```
src/app/page.tsx              entry: renders <RideApp/>
src/app/api/fare/route.ts     POST {pickup, drop, coupon?} → quotes for every vehicle
src/app/api/places/route.ts   GET ?q= → local places + Nominatim results
src/components/ride-app.tsx   booking state machine + bottom sheet UI
src/components/map-view.tsx   Leaflet map (client-only)
src/lib/fares.ts              vehicles, pricing, surge, coupons
src/lib/geo.ts                haversine, curved route generation, interpolation
src/lib/captains.ts           simulated captain matching
src/lib/storage.ts            localStorage persistence
```

## Simulated parts

There is no real driver network, routing engine or payment gateway. Captains are randomly generated.
Routes are smooth curves, and distance is the straight-line distance × 1.35.
Travel time is compressed: one trip-minute plays as 2.5 s.
To make it real, replace `captains.ts` and the effects in `ride-app.tsx` with a backend that does dispatch and pushes location updates (for example over WebSockets or Supabase Realtime), plug in a routing API such as OSRM or Google Directions, and use a payment gateway for UPI.
