import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { LogoutButton } from "@/components/logout-button";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
        <div className="flex items-center gap-6">
          <span className="text-sm font-semibold text-brand">TutorOps Admin</span>
          <nav className="flex gap-4 text-sm">
            <Link href="/admin" className="text-foreground/70 hover:text-foreground">
              Users
            </Link>
            <Link href="/admin/catalog" className="text-foreground/70 hover:text-foreground">
              Catalog
            </Link>
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
