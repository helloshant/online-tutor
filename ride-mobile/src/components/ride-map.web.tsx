import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import type { LatLng } from "@shared/geo";
import { C } from "@/lib/theme";
import type { RideMapProps } from "./ride-map.types";

/**
 * Web preview fallback: react-native-maps has no web implementation, so we
 * draw a schematic (no tiles) by projecting points into the view box. The
 * native app uses real maps (ride-map.tsx).
 */
export default function RideMap({ center, pickup, drop, route, approach, vehicle, nearby, onPress, bottomInset = 0 }: RideMapProps) {
  const [size, setSize] = useState({ w: 0, h: 0 });

  const bounds = useMemo(() => {
    const pts = [pickup, drop].filter(Boolean) as LatLng[];
    if (pts.length === 0) pts.push(center);
    let minLat = Math.min(...pts.map((p) => p.lat));
    let maxLat = Math.max(...pts.map((p) => p.lat));
    let minLng = Math.min(...pts.map((p) => p.lng));
    let maxLng = Math.max(...pts.map((p) => p.lng));
    const pad = Math.max(0.012, (maxLat - minLat) * 0.25, (maxLng - minLng) * 0.25);
    minLat -= pad;
    maxLat += pad;
    minLng -= pad;
    maxLng += pad;
    return { minLat, maxLat, minLng, maxLng };
  }, [pickup, drop, center]);

  const usableH = Math.max(1, size.h - bottomInset);
  const project = (p: LatLng) => ({
    left: ((p.lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * size.w,
    top: ((bounds.maxLat - p.lat) / (bounds.maxLat - bounds.minLat)) * usableH,
  });
  const unproject = (x: number, y: number): LatLng => ({
    lat: bounds.maxLat - (y / usableH) * (bounds.maxLat - bounds.minLat),
    lng: bounds.minLng + (x / size.w) * (bounds.maxLng - bounds.minLng),
  });

  const dots = (path: LatLng[] | null | undefined, color: string, every = 1) =>
    path?.filter((_, i) => i % every === 0).map((p, i) => {
      const { left, top } = project(p);
      return <View key={`${color}${i}`} style={[styles.dot, { left: left - 2.5, top: top - 2.5, backgroundColor: color }]} />;
    });

  const at = (p: LatLng, w: number, h: number) => {
    const { left, top } = project(p);
    return { left: left - w / 2, top: top - h / 2 };
  };

  return (
    <Pressable
      style={[StyleSheet.absoluteFill, styles.bg]}
      onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      onPress={(e: GestureResponderEvent) => onPress?.(unproject(e.nativeEvent.locationX, e.nativeEvent.locationY))}
      testID="map"
    >
      {size.w > 0 && (
        <>
          {nearby?.map((n, i) => (
            <Text key={`n${i}`} style={[styles.abs, styles.small, at(n.position, 22, 22)]}>
              {n.icon}
            </Text>
          ))}
          {dots(route, C.ink)}
          {dots(approach, "#F59E0B", 2)}
          {pickup && <Pin p={pickup} color={C.green} label="P" at={at} />}
          {drop && <Pin p={drop} color={C.red} label="D" at={at} />}
          {vehicle && (
            <View style={[styles.abs, styles.bigWrap, at(vehicle.position, 44, 44)]}>
              <Text style={styles.big}>{vehicle.icon}</Text>
            </View>
          )}
          <Text style={styles.note}>Map preview · real maps run in the iOS/Android app</Text>
        </>
      )}
    </Pressable>
  );
}

function Pin({ p, color, label, at }: { p: LatLng; color: string; label: string; at: (p: LatLng, w: number, h: number) => { left: number; top: number } }) {
  return (
    <View style={[styles.abs, styles.pin, { backgroundColor: color }, at(p, 28, 28)]}>
      <Text style={styles.pinText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bg: { backgroundColor: "#E8EEF0", overflow: "hidden" },
  abs: { position: "absolute" },
  dot: { position: "absolute", width: 5, height: 5, borderRadius: 3 },
  small: { fontSize: 18 },
  pin: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: C.white, alignItems: "center", justifyContent: "center" },
  pinText: { color: C.white, fontWeight: "800", fontSize: 12 },
  bigWrap: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.white, borderWidth: 3, borderColor: C.brand, alignItems: "center", justifyContent: "center" },
  big: { fontSize: 24 },
  note: { position: "absolute", top: 64, alignSelf: "center", fontSize: 10, color: C.muted, backgroundColor: "rgba(255,255,255,0.8)", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
});
