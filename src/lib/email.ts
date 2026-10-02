// Best-effort admin notification email via Resend's HTTP API -- no SDK
// dependency, just a fetch() call, since this is the only place in the app
// that sends transactional email (see README's own note that the app has
// no transactional email configured otherwise). Used by the public
// business-enquiry and callback-request forms so staff learn about a new
// submission without having to poll the admin queue pages.
//
// Deliberately never throws: a notification failing (missing API key,
// Resend outage, etc.) must never block or fail the visitor's own form
// submission, which already succeeded in the database by the time this is
// called.
export async function sendAdminNotificationEmail(params: { subject: string; text: string }) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFICATION_EMAIL;
  if (!apiKey || !to) {
    console.warn("sendAdminNotificationEmail: RESEND_API_KEY or NOTIFICATION_EMAIL not set, skipping.");
    return;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || "SyllabusMate <onboarding@resend.dev>",
        to: [to],
        subject: params.subject,
        text: params.text,
      }),
    });
    if (!res.ok) {
      console.error("sendAdminNotificationEmail: Resend API error", res.status, await res.text());
    }
  } catch (err) {
    console.error("sendAdminNotificationEmail: request failed", err);
  }
}
