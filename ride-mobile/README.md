# Sawari Mobile — iOS & Android app

The native companion to the [Sawari web app](../ride-app). It is built with Expo SDK 58, React Native 0.88 and Expo Router.
It has the same booking flow as the web app and uses the same pricing code, imported directly from `../ride-app/src/lib`.

## Run it on your phone

```bash
cd ride-mobile
npm install
npx expo start
```

Scan the QR code with **Expo Go** (Android) or the iPhone Camera (iOS). Every dependency used here ships inside Expo Go, so you don't need a custom build.

Other ways to run it:

- `npx expo start --android` or `--ios` opens it in an emulator or simulator.
- `npx expo start --web` opens a browser preview. The browser has no real map; it shows a schematic map instead.

## Features

- **Full-screen map** using Apple Maps on iOS and Google Maps on Android, with pickup and drop pins, the route, nearby captains and the live vehicle position.
- **Bottom sheet** for booking:
  - Pick a vehicle: Bike, Auto, Cab Economy or Cab Premium.
  - Fares include demand pricing.
  - Coupons: `FIRST50`, `BIKE20`, `AUTO15`.
  - Pay with Cash, UPI or the wallet.
- **Search screen** (a modal) covering curated places, OpenStreetMap search across India, and saved Home/Work shortcuts.
- **Pickup options:** your GPS location (`expo-location`) or a tap on the map.
- **Trip flow:**
  1. Searching for a captain.
  2. Captain assigned, with a 4-digit OTP.
  3. Live arrival time while the captain approaches.
  4. Ride in progress.
  5. Fare summary, rating and tip.
- **During a trip:** Call (dialer), Share (native share sheet), SOS (demo only) and Cancel.
- **Account screen:** ride history with "Book again", wallet top-up and saved places. Data is stored on the device with AsyncStorage.

## Project layout

```
src/app/_layout.tsx        Stack navigator + state provider
src/app/index.tsx          map + booking bottom sheet (ride state machine)
src/app/search.tsx         place search modal (?target=pickup|drop)
src/app/account.tsx        rides / wallet / saved places
src/components/ride-map.tsx      react-native-maps (iOS/Android)
src/components/ride-map.web.tsx  schematic fallback for web preview
src/state/ride-store.tsx   app state + AsyncStorage persistence
@shared/*                  → ../ride-app/src/lib (fares, geo, places, captains)
```

The shared modules have to stay free of browser, Node and React Native APIs. `metro.config.js` adds `../ride-app/src/lib` to Metro's watch folders, and `tsconfig.json` maps the `@shared/*` alias to that folder.

## Store builds

To produce installable builds, use EAS:

```bash
npx eas-cli@latest build -p android   # or -p ios
```

- **Android:** standalone builds need a Google Maps key. Set `GOOGLE_MAPS_ANDROID_API_KEY`; `app.config.ts` passes it to the `react-native-maps` plugin.
- **iOS:** Apple Maps works without a key.
- **Before publishing:** change `ios.bundleIdentifier` and `android.package` in `app.json`. They are currently placeholders (`com.example.sawari`).

## Checks

```bash
npm run typecheck
npm run lint
npx expo export --platform android   # verifies the native JS bundle builds
```

## Simulated parts

As in the web app, captains, routes and payments are simulated, and one trip-minute plays as 2.5 s.
