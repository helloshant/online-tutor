"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth";
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
}
