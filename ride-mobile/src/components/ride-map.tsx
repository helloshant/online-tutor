import { useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Polyline, type LatLng as MapLatLng } from "react-native-maps";
import type { LatLng } from "@shared/geo";
import { C } from "@/lib/theme";
import type { RideMapProps } from "./ride-map.types";

const ll = (p: LatLng): MapLatLng => ({ latitude: p.lat, longitude: p.lng });

/** Native map (Apple Maps on iOS, Google Maps on Android). */
export default function RideMap({ center, pickup, drop, route, approach, vehicle, nearby, onPress, bottomInset = 0 }: RideMapProps) {
  const map = useRef<MapView>(null);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (pickup && drop) {
      m.fitToCoordinates([ll(pickup), ll(drop)], {
        edgePadding: { top: 80, right: 60, bottom: 60 + bottomInset, left: 60 },
        animated: true,
      });
    } else if (pickup ?? drop) {
      const p = (pickup ?? drop)!;
      m.animateToRegion({ ...ll(p), latitudeDelta: 0.02, longitudeDelta: 0.02 }, 400);
    }
  }, [pickup, drop, bottomInset]);

  return (
    <MapView
      ref={map}
      style={StyleSheet.absoluteFill}
      initialRegion={{ ...ll(center), latitudeDelta: 0.12, longitudeDelta: 0.12 }}
      showsUserLocation
      showsMyLocationButton={false}
      toolbarEnabled={false}
      onPress={(e) => {
        const c = e.nativeEvent.coordinate;
        onPress?.({ lat: c.latitude, lng: c.longitude });
      }}
    >
      {nearby?.map((n, i) => (
        <Marker key={`n${i}`} coordinate={ll(n.position)} tracksViewChanges={false} anchor={{ x: 0.5, y: 0.5 }}>
          <Text style={styles.small}>{n.icon}</Text>
        </Marker>
      ))}
      {route && route.length > 1 && <Polyline coordinates={route.map(ll)} strokeColor={C.ink} strokeWidth={5} />}
      {approach && approach.length > 1 && (
        <Polyline coordinates={approach.map(ll)} strokeColor="#F59E0B" strokeWidth={4} lineDashPattern={[8, 8]} />
      )}
      {pickup && <Marker coordinate={ll(pickup)} pinColor={C.green} title="Pickup" />}
      {drop && <Marker coordinate={ll(drop)} pinColor={C.red} title="Drop" />}
      {vehicle && (
        <Marker coordinate={ll(vehicle.position)} anchor={{ x: 0.5, y: 0.5 }} zIndex={10}>
          <View style={styles.bigWrap}>
            <Text style={styles.big}>{vehicle.icon}</Text>
          </View>
        </Marker>
      )}
    </MapView>
  );
}

const styles = StyleSheet.create({
  small: { fontSize: 20 },
  bigWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: C.white,
    borderWidth: 3,
    borderColor: C.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  big: { fontSize: 24 },
});
