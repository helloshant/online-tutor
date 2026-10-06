"use client";

import { useState, useTransition } from "react";
import { switchLlmProvider } from "./actions";
import type { LlmProvider } from "@/lib/supabase/types";

const OPTIONS: { value: LlmProvider; label: string; description: string }[] = [
  {
    value: "gemini",
    label: "Gemini",
    description: "The default. Included in your wallet balance at the standard rate.",
  },
  {
    value: "anthropic",
    label: "Anthropic (Claude)",
    description:
      "A premium model. Costs more per reply, so your wallet balance burns faster -- no separate charge, just a higher rate.",
  },
];

// Lets a student switch which LLM provider their account uses -- see
// supabase/migrations/0055_student_wallets.sql and switchLlmProvider in
// ./actions.ts. Switching either direction is free and immediate; there's
// no refund for tokens already spent on Anthropic when switching back.
export function AiModelSwitcher({
  currentProvider,
}: {
  currentProvider: LlmProvider;
}) {
  const [selected, setSelected] = useState(currentProvider);
  const [isPending, startTransition] = useTransition();

  function handleSelect(provider: LlmProvider) {
    if (provider === selected) return;
    setSelected(provider);
    startTransition(async () => {
      await switchLlmProvider(provider);
    });
  }

  return (
    <div className="space-y-2">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={isPending}
          onClick={() => handleSelect(option.value)}
          className={`w-full rounded-lg border p-3 text-left transition disabled:opacity-60 ${
            selected === option.value
              ? "border-brand bg-brand/5"
              : "border-border hover:border-brand/50"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-medium">{option.label}</span>
            {selected === option.value && (
              <span className="text-xs font-semibold text-brand">Active</span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-foreground/68">{option.description}</p>
        </button>
      ))}
    </div>
  );
}
