// Safe landing page for an admin who hits requireAdminPage() without the
// right grant. Deliberately has no permission check of its own -- the
// layout's requireAdmin() already guarantees staff-only access, and adding
// a requireAdminPage() call here would risk a redirect loop for an admin
// with zero page grants.
export default function NoAccessPage() {
  return (
    <div className="rounded-xl border border-border bg-surface p-6">
      <h1 className="text-lg font-semibold">Access restricted</h1>
      <p className="mt-2 max-w-md text-sm text-foreground/60">
        You don&apos;t have permission to view this page. Ask a superadmin to grant it from Admin →
        Authorization.
      </p>
    </div>
  );
}
