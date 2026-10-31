import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Adds the react-native-maps plugin with Google Maps keys from the
 * environment. Expo Go works without keys; standalone Android builds need
 * GOOGLE_MAPS_ANDROID_API_KEY (iOS falls back to Apple Maps without a key).
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  plugins: [
    ...(config.plugins ?? []),
    [
      "react-native-maps",
      {
        androidGoogleMapsApiKey: process.env.GOOGLE_MAPS_ANDROID_API_KEY,
        iosGoogleMapsApiKey: process.env.GOOGLE_MAPS_IOS_API_KEY,
      },
    ],
  ],
});
