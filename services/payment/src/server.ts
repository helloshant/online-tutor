import express from "express";
import type { NextFunction, Request, Response } from "express";
import { generateCoupons, redeemCoupon, revokeCoupon } from "./coupons.js";
import { handleCallback, initiatePayment } from "./ccavenuePayment.js";

const PORT = Number(process.env.PORT) || 4200;
const SHARED_SECRET = process.env.PAYMENT_SHARED_SECRET;

// Fail closed, unlike the orchestrator/observability services' fail-open
// startup warning: this service handles real payments and free-access
// coupon codes, so refusing to run unauthenticated is a better default than
// a warning that's easy to miss in container logs. Setting the env var
// costs nothing.
if (!SHARED_SECRET) {
  console.error(
    "FATAL: PAYMENT_SHARED_SECRET is not set. This service refuses to start without it -- see " +
      "services/payment/.env.example."
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    storage: {
      supabaseUrl: process.env.SUPABASE_URL || null,
      configured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
    ccavenue: {
      configured: Boolean(
        process.env.CCAVENUE_MERCHANT_ID && process.env.CCAVENUE_ACCESS_CODE && process.env.CCAVENUE_WORKING_KEY
      ),
    },
  });
});

function requireSharedSecret(req: Request, res: Response, next: NextFunction) {
  if (req.header("x-internal-api-key") !== SHARED_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// Every route below must return through res.json -- this top-level catch is
// the backstop so an unexpected throw (e.g. a missing CCAvenue env var, or
// getSupabaseClient() throwing when unconfigured) never reaches the caller
// as a hung/empty response.
function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch((err) => {
      console.error(`Unexpected error in ${req.method} ${req.path}:`, err);
      res.status(500).json({ error: "Something went wrong. Please try again." });
    });
  };
}

// Called by the web app's /api/ccavenue/initiate proxy route after it's
// already confirmed the caller has a pending_payment subscription of their
// own (a cheap RLS-bound check) -- this service re-verifies the same thing
// independently via its own Supabase connection rather than trusting that
// check, since it's the actual trust boundary for what amount gets charged.
app.post(
  "/v1/payment/initiate",
  requireSharedSecret,
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<{
      subscriptionId: string;
      userId: string;
      userEmail: string;
      origin: string;
    }>;

    if (
      typeof body.subscriptionId !== "string" ||
      !body.subscriptionId ||
      typeof body.userId !== "string" ||
      !body.userId ||
      typeof body.origin !== "string" ||
      !body.origin
    ) {
      res.status(400).json({ error: "subscriptionId, userId, and origin are required" });
      return;
    }

    const result = await initiatePayment({
      subscriptionId: body.subscriptionId,
      userId: body.userId,
      userEmail: body.userEmail ?? "",
      origin: body.origin,
    });

    if ("error" in result) {
      res.status(404).json({ error: result.error });
      return;
    }
    res.json(result);
  })
);

// Called by the web app's /api/ccavenue/callback proxy route, which is the
// actual public endpoint CCAvenue's redirect lands on (this service has no
// public ingress of its own). Returns where the browser should be
// redirected next -- the web app performs the actual HTTP redirect.
app.post(
  "/v1/payment/callback",
  requireSharedSecret,
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<{ encResp: string }>;
    if (typeof body.encResp !== "string" || !body.encResp) {
      res.json({ redirectTo: "/subscribe?error=invalid_response" });
      return;
    }
    res.json(await handleCallback(body.encResp));
  })
);

app.post(
  "/v1/coupons/generate",
  requireSharedSecret,
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<{ count: number; createdBy: string }>;
    const count = Number.isFinite(body.count) ? Math.min(100, Math.max(1, Math.trunc(body.count!))) : 1;

    if (typeof body.createdBy !== "string" || !body.createdBy) {
      res.status(400).json({ error: "createdBy is required" });
      return;
    }

    const codes = await generateCoupons(count, body.createdBy);
    res.json({ codes });
  })
);

app.post(
  "/v1/coupons/revoke",
  requireSharedSecret,
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<{ id: string }>;
    if (typeof body.id !== "string" || !body.id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    await revokeCoupon(body.id);
    res.json({ ok: true });
  })
);

app.post(
  "/v1/coupons/redeem",
  requireSharedSecret,
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<{ code: string; userId: string; subscriptionId: string }>;
    if (
      typeof body.code !== "string" ||
      !body.code ||
      typeof body.userId !== "string" ||
      !body.userId ||
      typeof body.subscriptionId !== "string" ||
      !body.subscriptionId
    ) {
      res.status(400).json({ error: "code, userId, and subscriptionId are required" });
      return;
    }

    const result = await redeemCoupon({ code: body.code, userId: body.userId, subscriptionId: body.subscriptionId });
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  })
);

app.listen(PORT, () => {
  console.log(`Payment service listening on port ${PORT}`);
});
