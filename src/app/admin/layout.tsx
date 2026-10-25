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
      {/* Split into two rows rather than one unwrapped flex row -- with
          this many admin pages (12 links, growing with every new admin
          tool this app adds), a single `justify-between` row had no
          `flex-wrap` and no `whitespace-nowrap` on the links themselves,
          so under any real width pressure a two-word label like "Topic
          summaries" would wrap mid-phrase onto two lines, and -- worse --
          the nav group and the Back to app/Log out group (two separate
          flex children of the same justify-between row, with no gap
          enforced BETWEEN them) would get squeezed together with zero
          space, reading as one run-on word ("AuthorizationBack to app").
          Reported directly. The brand/utilities row above is always just
          those few fixed items, so it can stay a single tidy row; the nav
          row below is free to flex-wrap onto as many lines as the page
          count needs, each label kept on one line via whitespace-nowrap
          so wrapping only ever happens BETWEEN links, never inside one. */}
      <header className="border-b border-border bg-surface">
        <div className="flex items-center justify-between px-6 py-3">
          <span className="text-sm font-semibold text-brand">SyllabusMate Admin</span>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/dashboard" className="whitespace-nowrap text-foreground/75 hover:text-foreground">
              Back to app
            </Link>
            <LogoutButton className="whitespace-nowrap font-medium text-foreground/75 hover:text-foreground" />
          </div>
        </div>
        <nav className="flex flex-wrap gap-x-4 gap-y-2 border-t border-border px-6 py-2 text-sm">
          {canSee("users") && (
            <Link href="/admin" className="whitespace-nowrap text-foreground/82 hover:text-foreground">
              Users
            </Link>
          )}
          {canSee("catalog") && (
            <Link href="/admin/catalog" className="whitespace-nowrap text-foreground/82 hover:text-foreground">
              Catalog
            </Link>
          )}
          {canSee("answer_bank") && (
            <Link href="/admin/answer-bank" className="whitespace-nowrap text-foreground/82 hover:text-foreground">
              Answer bank
            </Link>
          )}
          {canSee("observability") && (
            <Link href="/admin/observability" className="whitespace-nowrap text-foreground/82 hover:text-foreground">
              Observability
            </Link>
          )}
          {canSee("coupons") && (
            <Link href="/admin/coupons" className="whitespace-nowrap text-foreground/82 hover:text-foreground">
              Coupons
            </Link>
          )}
          {canSee("chapter_notes") && (
            <Link href="/admin/chapter-notes" className="whitespace-nowrap text-foreground/82 hover:text-foreground">
              Chapter notes
            </Link>
          )}
          {canSee("topic_summaries") && (
            <Link href="/admin/topic-summaries" className="whitespace-nowrap text-foreground/82 hover:text-foreground">
              Topic summaries
            </Link>
          )}
          {canSee("broadcasts") && (
            <Link href="/admin/broadcasts" className="whitespace-nowrap text-foreground/82 hover:text-foreground">
              Broadcasts
            </Link>
          )}
          {canSee("feedback") && (
            <Link href="/admin/feedback" className="whitespace-nowrap text-foreground/82 hover:text-foreground">
              Feedback
            </Link>
          )}
          {canSee("archetype_miner") && (
            <Link href="/admin/archetype-miner" className="whitespace-nowrap text-foreground/82 hover:text-foreground">
              Archetype Miner
            </Link>
          )}
          {canSee("callback_requests") && (
            <Link href="/admin/callback-requests" className="whitespace-nowrap text-foreground/82 hover:text-foreground">
              Callback requests
            </Link>
          )}
          {canSee("business_enquiries") && (
            <Link href="/admin/business-enquiries" className="whitespace-nowrap text-foreground/82 hover:text-foreground">
              Business enquiries
            </Link>
          )}
          {isSuperadmin && (
            <Link href="/admin/authorization" className="whitespace-nowrap text-foreground/82 hover:text-foreground">
              Authorization
            </Link>
          )}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
