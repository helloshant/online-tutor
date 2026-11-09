"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { clearAdminPreviewCookie, requireSuperAdmin, setAdminPreviewCookie } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { AdminPageKey } from "@/lib/supabase/types";

export async function setPagePermission(userId: string, page: AdminPageKey, granted: boolean) {
  await requireSuperAdmin();
  const supabase = await createClient();

  if (granted) {
    await supabase.from("admin_page_permissions").upsert(
      { user_id: userId, page },
      { onConflict: "user_id,page", ignoreDuplicates: true }
    );
  } else {
    await supabase.from("admin_page_permissions").delete().eq("user_id", userId).eq("page", page);
  }

  revalidatePath("/admin/authorization");
}

// Grade scoping has the opposite "empty" meaning from page permissions --
// zero rows means unrestricted (see 0071_admin_grade_permissions.sql), so
// toggling a grade on actually narrows an admin's access rather than
// widening it.
export async function setGradePermission(userId: string, gradeId: string, granted: boolean) {
  await requireSuperAdmin();
  const supabase = await createClient();

  if (granted) {
    await supabase.from("admin_grade_permissions").upsert(
      { user_id: userId, grade_id: gradeId },
      { onConflict: "user_id,grade_id", ignoreDuplicates: true }
    );
  } else {
    await supabase.from("admin_grade_permissions").delete().eq("user_id", userId).eq("grade_id", gradeId);
  }

  revalidatePath("/admin/authorization");
  revalidatePath(`/admin/users/${userId}`);
}

// Lets a superadmin see /admin exactly as a given plain admin would (see
// getAdminPreviewTarget's own comment) -- requireSuperAdmin() here checks
// the REAL session, never the preview itself, so this can't be chained
// (a superadmin already previewing as one admin can't use this to jump
// straight to previewing as a different one without exiting first... well,
// they technically can, since nothing here reads the existing cookie, but
// that's harmless -- it just overwrites which admin is being previewed).
export async function enterAdminPreview(targetUserId: string) {
  await requireSuperAdmin();
  const supabase = await createClient();
  const { data: target } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", targetUserId)
    .maybeSingle();
  // Only a plain admin can be previewed -- previewing "as" another
  // superadmin is meaningless (they're already unrestricted), and a
  // student isn't an admin at all.
  if (!target || target.role !== "admin") return;

  await setAdminPreviewCookie(targetUserId);
  redirect("/admin");
}

export async function exitAdminPreview() {
  await requireSuperAdmin();
  await clearAdminPreviewCookie();
  redirect("/admin");
}
