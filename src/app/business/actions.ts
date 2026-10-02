"use server";

import { createClient } from "@/lib/supabase/server";
import { sendAdminNotificationEmail } from "@/lib/email";

export interface BusinessEnquiryState {
  error?: string;
  success?: boolean;
}

// Public, unauthenticated action -- reached from the Business Enquiry page
// before an organisation has necessarily signed up at all, same posture as
// submitCallbackRequest in /contact/actions.ts. Uses the ordinary
// (anon-key) session client: business_enquiries' own RLS policy is what
// actually authorizes this insert (see 0052_business_enquiries.sql's own
// comment), not service-role bypass.
export async function submitBusinessEnquiry(
  _prevState: BusinessEnquiryState,
  formData: FormData,
): Promise<BusinessEnquiryState> {
  const organizationName = String(formData.get("organizationName") ?? "").trim();
  const contactName = String(formData.get("contactName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const approxStudents = String(formData.get("approxStudents") ?? "").trim();
  const message = String(formData.get("message") ?? "").trim();

  if (!organizationName || !contactName || !email) {
    return { error: "Please enter your organisation name, your name, and an email address." };
  }
  // Same lightweight sanity check as the login/signup forms use -- not a
  // full RFC 5322 validator, just enough to catch an empty/junk submission.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Please enter a valid email address." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("business_enquiries").insert({
    organization_name: organizationName,
    contact_name: contactName,
    email,
    phone: phone || null,
    approx_students: approxStudents || null,
    message: message || null,
  });

  if (error) {
    return { error: "Could not submit your enquiry. Please try again." };
  }

  await sendAdminNotificationEmail({
    subject: `New business enquiry: ${organizationName}`,
    text: [
      `Organisation: ${organizationName}`,
      `Contact: ${contactName}`,
      `Email: ${email}`,
      `Phone: ${phone || "-"}`,
      `Approx. students: ${approxStudents || "-"}`,
      "",
      "Message:",
      message || "-",
    ].join("\n"),
  });

  return { success: true };
}
