import { Pressable, StyleSheet, Text, View } from "react-native";
import { C } from "@/lib/theme";

export function Button({ label, onPress, variant = "primary" }: { label: string; onPress: () => void; variant?: "primary" | "outline" | "danger" }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.btn, styles[variant], pressed && { opacity: 0.8 }]}
    >
      <Text style={[styles.btnText, variant === "danger" && { color: C.red }]}>{label}</Text>
    </Pressable>
  );
}

export function Chip({ label, onPress, active, danger }: { label: string; onPress: () => void; active?: boolean; danger?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      onPress={onPress}
      style={[styles.chip, active && styles.chipActive, danger && { backgroundColor: C.redSoft }]}
    >
      <Text style={[styles.chipText, active && { color: C.white }, danger && { color: C.red }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Row({ label, value, color, bold }: { label: string; value: string; color?: string; bold?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[{ color: color ?? C.ink }, bold && styles.bold]}>{label}</Text>
      <Text style={[{ color: color ?? C.ink }, bold && styles.bold]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  btn: { borderRadius: 16, paddingVertical: 15, alignItems: "center", alignSelf: "stretch" },
  primary: { backgroundColor: C.brand },
  outline: { borderWidth: 1, borderColor: C.line },
  danger: {},
  btnText: { fontWeight: "800", fontSize: 16, color: C.ink },
  chip: { flex: 1, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 6, alignItems: "center", backgroundColor: C.surface },
  chipActive: { backgroundColor: C.ink },
  chipText: { fontWeight: "600", fontSize: 13, color: C.ink },
  row: { flexDirection: "row", justifyContent: "space-between" },
  bold: { fontWeight: "800" },
});
