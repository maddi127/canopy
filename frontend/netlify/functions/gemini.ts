// Server-side proxy for Google's Generative Language (Gemini) API.
// Keeps GEMINI_API_KEY off the client: the frontend posts to
// /.netlify/functions/gemini?model=<model> and this function injects the key.
//
// Requires a Netlify environment variable: GEMINI_API_KEY (no VITE_ prefix).
//
// Hardening — NO auth requirement (feature detection and street-view analysis
// run on /diy/boundary, which is before account creation), so defense is:
//   1. POST only + model allowlist
//   2. Origin/Referer allowlist (this site's own URLs + localhost dev)
//   3. Per-IP sliding-window rate limit
//   4. Request body size cap

const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash-image',
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-3.5-flash',
]);

// Bodies legitimately carry base64 satellite/street-view JPEGs (~1-3 MB), so cap at 6 MB.
const MAX_BODY_BYTES = 6 * 1024 * 1024;

// ── Origin allowlist ─────────────────────────────────────────────────────────
// Netlify injects URL (the site's primary URL) and DEPLOY_PRIME_URL (the
// deploy/branch URL). localhost / 127.0.0.1 on any port are allowed for local dev.
const isAllowedOrigin = (value: string): boolean => {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    return false;
  }
  if (origin.protocol === 'http:' && (origin.hostname === 'localhost' || origin.hostname === '127.0.0.1')) {
    return true;
  }
  return [process.env.URL, process.env.DEPLOY_PRIME_URL]
    .filter((u): u is string => Boolean(u))
    .some((allowed) => {
      try {
        return new URL(allowed).origin === origin.origin;
      } catch {
        return false;
      }
    });
};

// ── Per-IP rate limiting ─────────────────────────────────────────────────────
// NOTE: module scope means this Map is shared across warm invocations of ONE
// lambda instance only — it is best-effort, not a global limit (Netlify can run
// several instances in parallel, each with its own window). Good enough to
// blunt casual abuse; the upgrade path is a durable store (Supabase or Netlify
// Blobs) once JWT auth lands and requests are attributable to users.
const RATE_LIMIT = 20; // max requests…
const RATE_WINDOW_MS = 60_000; // …per IP per window

const hits = new Map<string, number[]>(); // ip → request timestamps (ms)
let lastPrune = Date.now();

// Periodic full sweep so IPs that stopped calling don't accumulate forever.
const pruneHits = (now: number): void => {
  if (now - lastPrune < RATE_WINDOW_MS) return;
  lastPrune = now;
  for (const [ip, times] of hits) {
    const fresh = times.filter((t) => now - t < RATE_WINDOW_MS);
    if (fresh.length === 0) hits.delete(ip);
    else hits.set(ip, fresh);
  }
};

/** Records the hit and returns 0 if allowed, else seconds until a slot frees up. */
const rateLimit = (ip: string): number => {
  const now = Date.now();
  pruneHits(now);
  const fresh = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (fresh.length >= RATE_LIMIT) {
    hits.set(ip, fresh);
    return Math.max(1, Math.ceil((fresh[0] + RATE_WINDOW_MS - now) / 1000));
  }
  fresh.push(now);
  hits.set(ip, fresh);
  return 0;
};

const payloadTooLarge = (): Response =>
  Response.json({ error: 'Request body too large (max 6 MB)' }, { status: 413 });

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Browsers send Origin on cross-context POSTs; fall back to Referer, and
  // reject when neither is present (curl-style scripted calls). Header names
  // arrive lowercase on Netlify; Headers.get() is case-insensitive anyway.
  const source = req.headers.get('origin') ?? req.headers.get('referer');
  if (!source || !isAllowedOrigin(source)) {
    return Response.json({ error: 'Forbidden origin' }, { status: 403 });
  }

  const ip =
    req.headers.get('x-nf-client-connection-ip') ??
    req.headers.get('client-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown';
  const retryAfter = rateLimit(ip);
  if (retryAfter > 0) {
    return Response.json(
      { error: 'Too many requests, retry shortly' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
  }

  const model = new URL(req.url).searchParams.get('model') ?? '';
  if (!ALLOWED_MODELS.has(model)) {
    return Response.json({ error: `Model not allowed: ${model}` }, { status: 400 });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return Response.json({ error: 'GEMINI_API_KEY is not configured on the server' }, { status: 500 });
  }

  // Size cap: early-reject on the declared Content-Length, then verify what was
  // actually read (the header can be absent or wrong). Body is JSON/base64, so
  // string length ≈ byte length.
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return payloadTooLarge();
  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) return payloadTooLarge();

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body,
    },
  );

  // Stream the response straight back — image generations can be large.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
  });
};
