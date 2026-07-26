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
