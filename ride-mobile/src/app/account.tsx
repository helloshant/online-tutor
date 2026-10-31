import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { vehicleByType } from "@shared/fares";
import { useRideStore } from "@/state/ride-store";
import { Chip } from "@/components/ui";
import { C, rupee } from "@/lib/theme";

type Tab = "rides" | "wallet" | "places";

export default function Account() {
  const s = useRideStore();
  const [tab, setTab] = useState<Tab>("rides");
  const [note, setNote] = useState<string | null>(null);
  const completed = s.history.filter((r) => r.status === "completed");
  const spent = completed.reduce((n, r) => n + r.fare + r.tip, 0);

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View>
        <Text style={styles.h1}>Hi, rider 👋</Text>
        <Text style={styles.muted}>
          {completed.length} rides · {rupee(spent)} spent
        </Text>
      </View>
      <View style={styles.tabs}>
        {(["rides", "wallet", "places"] as Tab[]).map((t) => (
          <Chip key={t} active={tab === t} label={t === "rides" ? "My rides" : t[0].toUpperCase() + t.slice(1)} onPress={() => setTab(t)} />
        ))}
      </View>

      {note && <Text style={styles.note}>{note}</Text>}

      {tab === "rides" && (
        <>
          {s.history.length === 0 && <Text style={styles.muted}>No rides yet. Your trips will show up here.</Text>}
          {s.history.map((r) => {
            const v = vehicleByType(r.vehicle);
            return (
              <View key={r.id} style={styles.card}>
                <View style={styles.between}>
                  <Text style={styles.muted}>
                    {v.icon} {v.label} · {new Date(r.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                  </Text>
                  <Text style={{ fontSize: 12, color: r.status === "completed" ? C.green : C.red }}>{r.status}</Text>
                </View>
                <Text numberOfLines={1} style={{ marginTop: 4, color: C.ink }}>
                  {r.pickup.name} → {r.drop.name}
                </Text>
                <View style={[styles.between, { marginTop: 4 }]}>
                  <Text style={{ fontWeight: "700", color: C.ink }}>
                    {r.status === "completed" ? rupee(r.fare + r.tip) : "—"} {r.rating ? "⭐".repeat(r.rating) : ""}
                  </Text>
                  <Pressable
                    onPress={() => {
                      if (s.tripActive) return setNote("Finish your current ride first.");
                      s.setPickup(r.pickup);
                      s.setDrop(r.drop);
                      s.setVehicle(r.vehicle);
                      router.back();
                    }}
                  >
                    <Text style={styles.link}>Book again</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
          {s.history.length > 0 && (
            <Pressable onPress={s.clearHistory}>
              <Text style={[styles.muted, { textAlign: "center", padding: 8 }]}>Clear history</Text>
            </Pressable>
          )}
        </>
      )}

      {tab === "wallet" && (
        <>
          <View style={styles.walletCard}>
            <Text style={{ color: C.ink }}>Sawari Wallet</Text>
            <Text style={styles.balance}>{rupee(s.wallet)}</Text>
          </View>
          <Text style={styles.label}>Add money (demo)</Text>
          <View style={styles.tabs}>
            {[100, 200, 500].map((n) => (
              <Chip
                key={n}
                label={`+ ${rupee(n)}`}
                onPress={() => {
                  s.setWallet(s.wallet + n);
                  setNote(`${rupee(n)} added to wallet`);
                }}
              />
            ))}
          </View>
          <Text style={styles.muted}>Pay with your wallet at booking to skip cash. No real money moves in this demo.</Text>
        </>
      )}

      {tab === "places" && (
        <>
          {(["home", "work"] as const).map((k) => (
            <View key={k} style={[styles.card, styles.between, { alignItems: "center" }]}>
              <View>
                <Text style={styles.label}>{k === "home" ? "🏠 Home" : "💼 Work"}</Text>
                <Text style={styles.muted}>{s.saved[k]?.name ?? "Not set"}</Text>
              </View>
              <Pressable
                onPress={() => {
                  if (!s.pickup) return setNote("Set a pickup location first, then save it.");
                  s.setSaved({ ...s.saved, [k]: s.pickup });
                  setNote(`Saved "${s.pickup.name}" as ${k}`);
                }}
              >
                <Text style={styles.link}>Set to current pickup</Text>
              </Pressable>
            </View>
          ))}
          <Text style={styles.muted}>Saved places appear as shortcuts on the search screen.</Text>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.white },
  h1: { fontSize: 20, fontWeight: "800", color: C.ink },
  muted: { fontSize: 12, color: C.muted },
  tabs: { flexDirection: "row", gap: 8 },
  card: { borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 12 },
  between: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  link: { color: "#B45309", fontWeight: "600", fontSize: 13 },
  walletCard: { backgroundColor: C.brand, borderRadius: 18, padding: 20 },
  balance: { fontSize: 32, fontWeight: "900", color: C.ink },
  label: { fontWeight: "600", color: C.ink },
  note: { backgroundColor: C.brandSoft, borderRadius: 10, padding: 10, color: C.ink },
});
