import { enterAdminPreviewFromPicker } from "@/app/admin/authorization/actions";

// Lets a superadmin jump straight into "preview as this admin" mode (see
// getAdminPreviewTarget's own comment in src/lib/auth.ts) from right here
// on the dashboard header, next to StaffPreviewPicker -- same idea, one
// level up: that picker previews what a STUDENT under a board/grade sees,
// this previews what a specific ADMIN's own restricted /admin/* view looks
// like. Reported directly: a superadmin expected this next to "Preview as
// student," not only reachable from a specific admin's own user page or
// the Authorization list.
//
// No "use client" needed -- enterAdminPreviewFromPicker is a Server Action
// (src/app/admin/authorization/actions.ts), so a plain <form action={...}>
// works here even though this renders inside dashboard-shell.tsx's client
// component tree, same as StaffPreviewPicker's own plain GET form does.
export function AdminPreviewPicker({
  admins,
}: {
  admins: { id: string; name: string }[];
}) {
  return (
    <form action={enterAdminPreviewFromPicker} className="flex items-center gap-1.5">
      <select
        name="adminId"
        required
        defaultValue=""
        className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground"
      >
        <option value="" disabled>
          Admin…
        </option>
        {admins.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="rounded-lg bg-brand px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-dark"
      >
        Preview as Admin
      </button>
    </form>
  );
}
