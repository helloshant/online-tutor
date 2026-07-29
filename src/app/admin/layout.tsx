import Link from "next/link";
import { getAllowedAdminPages, requireAdmin } from "@/lib/auth";
import { LogoutButton } from "@/components/logout-button";
import type { AdminPageKey } from "@/lib/supabase/types";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdmin();
  const allowedPages = await getAllowedAdminPages();
  const canSee = (page: AdminPageKey) => allowedPages === "all" || allowedPages.has(page);
  const isSuperadmin = session.profile?.role === "superadmin";

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
        <div className="flex items-center gap-6">
          <span className="text-sm font-semibold text-brand">TutorOps Admin</span>
          <nav className="flex gap-4 text-sm">
            {canSee("users") && (
              <Link href="/admin" className="text-foreground/70 hover:text-foreground">
                Users
              </Link>
            )}
            {canSee("catalog") && (
              <Link href="/admin/catalog" className="text-foreground/70 hover:text-foreground">
                Catalog
              </Link>
            )}
            {canSee("answer_bank") && (
              <Link href="/admin/answer-bank" className="text-foreground/70 hover:text-foreground">
                Answer bank
              </Link>
            )}
            {canSee("observability") && (
              <Link href="/admin/observability" className="text-foreground/70 hover:text-foreground">
                Observability
              </Link>
            )}
            {canSee("coupons") && (
              <Link href="/admin/coupons" className="text-foreground/70 hover:text-foreground">
                Coupons
              </Link>
            )}
            {isSuperadmin && (
              <Link href="/admin/authorization" className="text-foreground/70 hover:text-foreground">
                Authorization
              </Link>
            )}
          </nav>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/dashboard" className="text-foreground/60 hover:text-foreground">
            Back to app
          </Link>
          <LogoutButton className="font-medium text-foreground/60 hover:text-foreground" />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
