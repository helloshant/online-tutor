import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import type { Place } from "@shared/geo";
import { searchPlaces } from "@/lib/place-search";
import { useRideStore } from "@/state/ride-store";
import { C } from "@/lib/theme";

export default function Search() {
  const { target } = useLocalSearchParams<{ target?: string }>();
  const isDrop = target === "drop";
  const { setPickup, setDrop, saved } = useRideStore();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        setResults(await searchPlaces(q, ctrl.signal));
      } catch {
        /* aborted */
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const choose = (p: Place) => {
    (isDrop ? setDrop : setPickup)(p);
    router.back();
  };

  const shortcuts = [saved.home && { label: "🏠 Home", place: saved.home }, saved.work && { label: "💼 Work", place: saved.work }].filter(Boolean) as {
    label: string;
    place: Place;
  }[];

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: isDrop ? "Where to?" : "Pickup location" }} />
      <View style={styles.inputWrap}>
        <View style={[styles.dot, { backgroundColor: isDrop ? C.red : C.green }]} />
        <TextInput
          autoFocus
          value={q}
          onChangeText={setQ}
          placeholder={isDrop ? "Search drop location" : "Search pickup location"}
          accessibilityLabel="Search places"
          style={styles.input}
        />
        {loading && <ActivityIndicator size="small" color={C.muted} />}
      </View>
      {shortcuts.length > 0 && (
        <View style={styles.shortcuts}>
          {shortcuts.map((s) => (
            <Pressable key={s.label} style={styles.shortcut} onPress={() => choose(s.place)}>
              <Text style={{ fontWeight: "600" }}>{s.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <FlatList
        data={results}
        keyExtractor={(p) => p.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={!loading ? <Text style={styles.empty}>No places found</Text> : undefined}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" style={({ pressed }) => [styles.item, pressed && { backgroundColor: C.brandSoft }]} onPress={() => choose(item)}>
            <Text style={{ fontSize: 18 }}>📌</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.addr}>{item.address}</Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.white },
  inputWrap: { flexDirection: "row", alignItems: "center", gap: 12, margin: 16, backgroundColor: C.surface, borderRadius: 14, paddingHorizontal: 14 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  input: { flex: 1, paddingVertical: 13, fontSize: 16 },
  shortcuts: { flexDirection: "row", gap: 8, paddingHorizontal: 16, marginBottom: 8 },
  shortcut: { backgroundColor: C.surface, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  item: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  name: { fontSize: 15, fontWeight: "600", color: C.ink },
  addr: { fontSize: 12, color: C.muted, marginTop: 2 },
  empty: { padding: 16, color: C.muted },
});
