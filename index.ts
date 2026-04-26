import {
  createLogger,
  createStaticHandler,
  mountAuthRoutes,
  Router,
  validateSession,
} from "@mac9sb/deno-foundation";

const kv = await Deno.openKv();
const log = createLogger("app");

const BASE_URL = Deno.env.get("BASE_URL") ?? "http://localhost:8000";
const RP_ID = new URL(BASE_URL).hostname;
const RP_NAME = Deno.env.get("RP_NAME") ?? "Where Are We Moving";

const LOCALES = ["en"];
const serve = createStaticHandler({ locales: LOCALES });

// ── Seed countries to KV if not present ────────────────────────────────────────────────────

const SEEDED_KEY = ["seeded", "countries"];

async function seedCountries() {
  const existing = await kv.get<{ version: number }>(SEEDED_KEY);
  if (existing.value) {
    // Check if old seeded data without flagEmoji - re-seed if needed
    const oldList = await kv.get(["countries", "list"]);
    const version = existing.value?.version || 1;
    if (
      version < 2 && oldList.value && Array.isArray(oldList.value) &&
      !oldList.value[0]?.flagEmoji
    ) {
      log.info("re-seeding countries with flagEmoji...");
      const { ALL_METRICS, COUNTRIES } = await import("./shared/countries.ts");

      await kv.atomic().set(["countries", "metrics"], ALL_METRICS)
        .set(["countries", "list"], COUNTRIES)
        .set(SEEDED_KEY, { version: 2 })
        .commit();

      log.info(`re-seeded ${COUNTRIES.length} countries`);
      return;
    }
    log.info("countries already seeded");
    return;
  }

  log.info("seeding countries to KV...");
  const { ALL_METRICS, COUNTRIES } = await import("./shared/countries.ts");

  await kv.atomic().set(["countries", "metrics"], ALL_METRICS)
    .set(["countries", "list"], COUNTRIES)
    .set(SEEDED_KEY, { version: 1 })
    .commit();

  log.info(`seeded ${COUNTRIES.length} countries`);
}

await seedCountries();

// ── Helpers ───────────────────────────────────────────────────────────────────

function pairId(a: string, b: string): string {
  return [a, b].sort().join(":");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requireSession(session: { userId: string } | null): Response | null {
  if (!session) return new Response(null, { status: 401 });
  return null;
}

// ── Routes ────────────────────────────────────────────────────────────────────

const router = new Router();

mountAuthRoutes(router, kv, {
  baseUrl: BASE_URL,
  rpId: RP_ID,
  rpName: RP_NAME,
  successPath: "/app",
});

// Stripe: import { mountStripeRoutes } from "@mac9sb/deno-foundation"
// and call mountStripeRoutes(router, kv, { baseUrl: BASE_URL }) to add billing routes.

router.route("/", {
  get: () => Response.redirect(`${BASE_URL}/get-started`, 302),
});

router.route("/get-started", {
  get: async (req) => {
    const session = await validateSession(kv, req);
    if (session) return Response.redirect(`${BASE_URL}/app`, 302);
    return serve.html(req, "/get-started.html");
  },
});

router.route("/app", {
  get: async (req) => {
    const session = await validateSession(kv, req);
    if (!session) return Response.redirect(`${BASE_URL}/get-started`, 302);
    return serve.html(req, "/app.html");
  },
});

router.route("/auth/success", {
  get: async (req) => {
    const session = await validateSession(kv, req);
    if (!session) return Response.redirect(`${BASE_URL}/get-started`, 302);
    return Response.redirect(`${BASE_URL}/app`, 302);
  },
});

router.route("/invite/:token", {
  get: async (req) => {
    const session = await validateSession(kv, req);
    const token = new URL(req.url).pathname.split("/").pop()!;
    const entry = await kv.get<string>(["invite", token]);
    if (!entry.value) {
      return new Response("Invite link not found or already used.", {
        status: 404,
      });
    }
    if (!session) {
      // Store token in cookie so we can claim it after sign-in
      const res = new Response(null, {
        status: 302,
        headers: {
          Location: `${BASE_URL}/get-started`,
          "Set-Cookie":
            `pending_invite=${token}; Path=/; HttpOnly; SameSite=Lax`,
        },
      });
      return res;
    }
    return serve.html(req, "/invite.html");
  },
});

// ── API: session info ─────────────────────────────────────────────────────────

router.route("/api/me", {
  get: async (req) => {
    const session = await validateSession(kv, req);
    if (!session) return json({ error: "unauthenticated" }, 401);

    const profileEntry = await kv.get<{ name: string; accentColor?: string }>([
      "profile",
      session.userId,
    ]);
    const pairEntry = await kv.get<string>(["pair", session.userId]);
    const partnerId = pairEntry.value ?? null;

    let partnerProfile: { name: string; accentColor?: string } | null = null;
    if (partnerId) {
      const pProfile = await kv.get(["profile", partnerId]);
      if (pProfile.value) {
        partnerProfile = pProfile.value as {
          name: string;
          accentColor?: string;
        };
      }
    }

    return json({
      userId: session.userId,
      name: profileEntry.value?.name ?? null,
      accentColor: profileEntry.value?.accentColor ?? "#c8a96e",
      partnerId,
      partnerName: partnerProfile?.name ?? null,
      partnerAccentColor: partnerProfile?.accentColor ?? "#c8a96e",
    });
  },
});

// ── API: check passkey exists ───────────────────────────────────────────────

router.route("/api/passkey/exists", {
  get: async (req) => {
    const session = await validateSession(kv, req);
    const err = requireSession(session);
    if (err) return err;

    // Using foundation's key structure: ["passkey", "users", userId]
    const creds = await kv.get(["passkey", "users", session!.userId]);
    const hasPasskey = !!(creds.value && (creds.value as unknown[]).length > 0);
    return json({ hasPasskey });
  },
});

// ── API: update own name ──────────────────────────────────────────────────────

router.route("/api/profile", {
  post: async (req) => {
    const session = await validateSession(kv, req);
    const err = requireSession(session);
    if (err) return err;

    const body = (await req.json()) as { name?: string; accentColor?: string };
    const name = (body.name ?? "").trim().slice(0, 64);
    const accentColor = body.accentColor ?? "#c8a96e";

    // Merge with existing profile
    const existing = await kv.get(["profile", session!.userId]);
    const profile = { ...(existing.value as object || {}), name, accentColor };
    await kv.set(["profile", session!.userId], profile);
    return json({ ok: true });
  },
});

// ── API: create invite link ───────────────────────────────────────────────────

router.route("/api/invite", {
  post: async (req) => {
    const session = await validateSession(kv, req);
    const err = requireSession(session);
    if (err) return err;

    const existing = await kv.get<string>(["pair", session!.userId]);
    if (existing.value) return json({ error: "Already paired" }, 400);

    // Revoke any old invite from this user
    const oldInviteEntry = await kv.get<string>([
      "invite-by-user",
      session!.userId,
    ]);
    if (oldInviteEntry.value) {
      await kv.delete(["invite", oldInviteEntry.value]);
    }

    const token = crypto.randomUUID();
    await kv.set(["invite", token], session!.userId, {
      expireIn: 7 * 24 * 60 * 60 * 1000,
    });
    await kv.set(["invite-by-user", session!.userId], token);
    return json({ url: `${BASE_URL}/invite/${token}` });
  },
});

// ── API: check & accept pending invite from cookie ───────────────────────────────

router.route("/api/invite/check", {
  post: async (req) => {
    const session = await validateSession(kv, req);
    const err = requireSession(session);
    if (err) return json({ paired: false, error: "Not authenticated" }, 401);

    // Check cookie for pending_invite
    const cookieHeader = req.headers.get("Cookie") ?? "";
    const match = cookieHeader.match(/(?:^|;\s*)pending_invite=([^;]+)/);
    if (!match) return json({ paired: false });

    const token = match[1].trim();

    // Verify invite exists
    const inviterEntry = await kv.get<string>(["invite", token]);
    if (!inviterEntry.value) {
      return json({ paired: false });
    }

    const inviterId = inviterEntry.value;
    if (inviterId === session!.userId) {
      return json({ paired: false, error: "Cannot pair with yourself" });
    }

    // Check neither already has a partner
    const [myPair, theirPair] = await Promise.all([
      kv.get<string>(["pair", session!.userId]),
      kv.get<string>(["pair", inviterId]),
    ]);
    if (myPair.value) return json({ paired: false, error: "Already paired" });
    if (theirPair.value) return json({ paired: false, error: "Inviter already paired" });

    // Create the pair
    await kv.set(["pair", session!.userId], inviterId);
    await kv.set(["pair", inviterId], session!.userId);
    await kv.delete(["invite", token]);
    await kv.delete(["invite-by-user", inviterId]);

    return json({ paired: true, partnerId: inviterId });
  },
});

// ── API: accept invite ────────────────────────────────────────────────────────

router.route("/api/invite/:token/accept", {
  post: async (req) => {
    const session = await validateSession(kv, req);
    const err = requireSession(session);
    if (err) return err;

    const token = req.url.split("/invite/")[1]?.split("/accept")[0];
    if (!token) return json({ error: "Invalid" }, 400);

    const inviterEntry = await kv.get<string>(["invite", token]);
    if (!inviterEntry.value) {
      return json({ error: "Invite not found or expired" }, 404);
    }

    const inviterId = inviterEntry.value;
    if (inviterId === session!.userId) {
      return json({ error: "Cannot pair with yourself" }, 400);
    }

    // Check neither already has a partner
    const [myPair, theirPair] = await Promise.all([
      kv.get<string>(["pair", session!.userId]),
      kv.get<string>(["pair", inviterId]),
    ]);
    if (myPair.value) return json({ error: "You are already paired" }, 400);
    if (theirPair.value) {
      return json({ error: "Inviter is already paired" }, 400);
    }

    await kv.set(["pair", session!.userId], inviterId);
    await kv.set(["pair", inviterId], session!.userId);
    await kv.delete(["invite", token]);
    await kv.delete(["invite-by-user", inviterId]);

    return json({ ok: true, partnerId: inviterId });
  },
});

// ── API: unpair ───────────────────────────────────────────────────────────────

router.route("/api/unpair", {
  post: async (req) => {
    const session = await validateSession(kv, req);
    const err = requireSession(session);
    if (err) return err;

    const pairEntry = await kv.get<string>(["pair", session!.userId]);
    if (!pairEntry.value) return json({ error: "Not paired" }, 400);

    const partnerId = pairEntry.value;
    await kv.delete(["pair", session!.userId]);
    await kv.delete(["pair", partnerId]);
    return json({ ok: true });
  },
});

// ── API: get countries data —───────────────────────────────────────────────────────

router.route("/api/countries", {
  get: async (_req) => {
    const [metrics, countries] = await Promise.all([
      kv.get(["countries", "metrics"]),
      kv.get(["countries", "list"]),
    ]);
    return json({
      metrics: metrics.value ?? [],
      countries: countries.value ?? [],
    });
  },
});

// ── API: shared pair data (ratings, pins, notes, hidden, profile settings) ────

router.route("/api/data", {
  get: async (req) => {
    const session = await validateSession(kv, req);
    const err = requireSession(session);
    if (err) return err;

    const pairEntry = await kv.get<string>(["pair", session!.userId]);
    const pid = pairEntry.value
      ? pairId(session!.userId, pairEntry.value)
      : `solo:${session!.userId}`;

    const [ratings, pins, notes, prefs, hidden] = await Promise.all([
      kv.get<unknown>(["data", pid, "ratings"]),
      kv.get<unknown>(["data", pid, "pins"]),
      kv.get<unknown>(["data", pid, "notes"]),
      kv.get<unknown>(["data", pid, "prefs"]),
      kv.get<unknown>(["data", pid, "hidden"]),
    ]);

    return json({
      ratings: ratings.value ?? null,
      pins: pins.value ?? null,
      notes: notes.value ?? null,
      prefs: prefs.value ?? null,
      hidden: hidden.value ?? null,
    });
  },

  post: async (req) => {
    const session = await validateSession(kv, req);
    const err = requireSession(session);
    if (err) return err;

    const body = (await req.json()) as { key: string; value: unknown };
    const allowed = ["ratings", "pins", "notes", "prefs", "hidden"];
    if (!allowed.includes(body.key)) return json({ error: "Invalid key" }, 400);

    const pairEntry = await kv.get<string>(["pair", session!.userId]);
    const pid = pairEntry.value
      ? pairId(session!.userId, pairEntry.value)
      : `solo:${session!.userId}`;

    await kv.set(["data", pid, body.key], body.value);
    return json({ ok: true });
  },
});

router.route("/link-expired", {
  get: (req) => serve.html(req, "/link-expired.html"),
});

// ── Claim pending invite after sign-in ────────────────────────────────────────

// The foundation's auth success redirect goes to /app; we handle pending_invite
// there in the client by checking for the cookie and calling the accept API.

// ── Server ────────────────────────────────────────────────────────────────────

log.info("server starting", { baseUrl: BASE_URL });
Deno.serve({ port: 8000 }, async (req) => {
  const { pathname } = new URL(req.url);
  if (serve.isStatic(pathname)) return serve.file(pathname);

  const res = await router.handle(req);

  // Fix cookie for localhost: strip Secure flag so browser accepts it over HTTP
  const setCookie = res.headers.get("Set-Cookie");
  if (setCookie?.includes("Secure")) {
    const fixedRes = new Response(res.body, {
      status: res.status,
      headers: new Headers(res.headers),
    });
    fixedRes.headers.set("Set-Cookie", setCookie.replace("; Secure", ""));
    return fixedRes;
  }

  return res;
});
