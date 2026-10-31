"use client";

import { useState } from "react";
import { vehicleByType } from "@/lib/fares";
import type { RideRecord, SavedPlaces } from "@/lib/storage";

type Props = {
  open: boolean;
  onClose: () => void;
  history: RideRecord[];
  wallet: number;
  onAddMoney: (n: number) => void;
  saved: SavedPlaces;
  onSave: (kind: "home" | "work") => void;
  onRebook: (r: RideRecord) => void;
  onClearHistory: () => void;
};

const rupee = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export default function SideDrawer({ open, onClose, history, wallet, onAddMoney, saved, onSave, onRebook, onClearHistory }: Props) {
  const [tab, setTab] = useState<"rides" | "wallet" | "places">("rides");
  if (!open) return null;

  const completed = history.filter((r) => r.status === "completed");
  const spent = completed.reduce((s, r) => s + r.fare + r.tip, 0);

  return (
    <div className="fixed inset-0 z-[2000] flex justify-end" role="dialog" aria-modal="true" aria-label="Account">
      <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-sm flex-col bg-white shadow-2xl dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-100 p-4 dark:border-zinc-800">
          <div>
            <p className="font-bold">Hi, rider 👋</p>
            <p className="text-xs text-zinc-500">
              {completed.length} rides · {rupee(spent)} spent
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1 text-xl" aria-label="Close">
            ×
          </button>
        </div>

        <nav className="flex gap-1 p-2">
          {(["rides", "wallet", "places"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`flex-1 rounded-lg py-2 text-sm font-medium capitalize ${tab === t ? "bg-amber-400 text-zinc-900" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
            >
              {t === "rides" ? "My rides" : t}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === "rides" && (
            <div className="space-y-3">
              {history.length === 0 && <p className="text-sm text-zinc-500">No rides yet. Your trips will show up here.</p>}
              {history.map((r) => {
                const v = vehicleByType(r.vehicle);
                return (
                  <div key={r.id} className="rounded-xl border border-zinc-100 p-3 dark:border-zinc-800">
                    <div className="flex items-center justify-between text-xs text-zinc-500">
                      <span>
                        {v.icon} {v.label} · {new Date(r.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                      </span>
                      <span className={r.status === "completed" ? "text-green-700" : "text-red-600"}>{r.status}</span>
                    </div>
                    <p className="mt-1 truncate text-sm">
                      {r.pickup.name} → {r.drop.name}
                    </p>
                    <div className="mt-1 flex items-center justify-between">
                      <span className="text-sm font-semibold">
                        {r.status === "completed" ? rupee(r.fare + r.tip) : "—"}
                        {r.rating ? <span className="ml-2 text-xs font-normal">{"⭐".repeat(r.rating)}</span> : null}
                      </span>
                      <button type="button" onClick={() => onRebook(r)} className="text-xs font-medium text-amber-700 hover:underline dark:text-amber-400">
                        Book again
                      </button>
                    </div>
                  </div>
                );
              })}
              {history.length > 0 && (
                <button type="button" onClick={onClearHistory} className="w-full py-2 text-xs text-zinc-500 hover:text-red-600">
                  Clear history
                </button>
              )}
            </div>
          )}

          {tab === "wallet" && (
            <div className="space-y-4">
              <div className="rounded-2xl bg-gradient-to-br from-amber-300 to-amber-500 p-5 text-zinc-900">
                <p className="text-sm">Sawari Wallet</p>
                <p className="text-3xl font-black">{rupee(wallet)}</p>
              </div>
              <div>
                <p className="mb-2 text-sm font-medium">Add money (demo)</p>
                <div className="flex gap-2">
                  {[100, 200, 500].map((n) => (
                    <button key={n} type="button" onClick={() => onAddMoney(n)} className="flex-1 rounded-xl border border-zinc-200 py-2 text-sm font-medium hover:border-amber-400 dark:border-zinc-700">
                      + {rupee(n)}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-xs text-zinc-500">Pay with your wallet at booking to skip cash. No real money moves in this demo.</p>
            </div>
          )}

          {tab === "places" && (
            <div className="space-y-3">
              {(["home", "work"] as const).map((k) => (
                <div key={k} className="flex items-center justify-between rounded-xl border border-zinc-100 p-3 dark:border-zinc-800">
                  <div>
                    <p className="text-sm font-medium capitalize">
                      {k === "home" ? "🏠" : "💼"} {k}
                    </p>
                    <p className="text-xs text-zinc-500">{saved[k]?.name ?? "Not set"}</p>
                  </div>
                  <button type="button" onClick={() => onSave(k)} className="text-xs font-medium text-amber-700 hover:underline dark:text-amber-400">
                    Set to current pickup
                  </button>
                </div>
              ))}
              <p className="text-xs text-zinc-500">Saved places appear as shortcuts in the pickup and drop search.</p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
