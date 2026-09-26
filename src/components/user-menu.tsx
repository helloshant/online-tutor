"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LogoutButton } from "@/components/logout-button";

// Clubs the username, Account link, and Log out button into a single
// dropdown -- reported directly: those three sat as separate header items,
// which read as more clutter than one identity control needs. Reuses
// LogoutButton as-is (its own sign-out/redirect logic, just restyled to
// look like a menu row) rather than duplicating that logic here.
export function UserMenu({ userName }: { userName: string }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-foreground/82 hover:bg-foreground/5 hover:text-foreground"
      >
        <span aria-hidden="true" className="sm:hidden">
          👤
        </span>
        <span className="hidden sm:inline">{userName}</span>
        <span aria-hidden="true" className="text-[10px] text-foreground/65">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-10 mt-1 w-40 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg"
        >
          <Link
            href="/account"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-1.5 text-sm text-foreground/88 hover:bg-brand/5"
          >
            Account
          </Link>
          <LogoutButton className="block w-full px-3 py-1.5 text-left text-sm text-foreground/88 hover:bg-brand/5 disabled:opacity-60" />
        </div>
      )}
    </div>
  );
}
