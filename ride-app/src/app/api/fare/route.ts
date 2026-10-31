import { quoteAll } from "@/lib/fares";

type Body = {
  pickup?: { lat?: unknown; lng?: unknown };
  drop?: { lat?: unknown; lng?: unknown };
  coupon?: unknown;
};

function asPoint(p: Body["pickup"]) {
  const lat = Number(p?.lat);
  const lng = Number(p?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const pickup = asPoint(body.pickup);
  const drop = asPoint(body.drop);
  if (!pickup || !drop) return Response.json({ error: "pickup and drop {lat,lng} are required" }, { status: 400 });

  const coupon = typeof body.coupon === "string" && body.coupon.trim() ? body.coupon : null;
  return Response.json({ quotes: quoteAll(pickup, drop, { coupon }) });
}
