import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { RideStoreProvider } from "@/state/ride-store";

export default function RootLayout() {
  return (
    <RideStoreProvider>
      <StatusBar style="dark" />
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="search" options={{ presentation: "modal", title: "Search location" }} />
        <Stack.Screen name="account" options={{ presentation: "modal", title: "Account" }} />
      </Stack>
    </RideStoreProvider>
  );
}
