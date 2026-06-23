// Server-side proxy for Google's Generative Language (Gemini) API.
// Keeps GEMINI_API_KEY off the client: the frontend posts to
// /.netlify/functions/gemini?model=<model> and this function injects the key.
//
// Requires a Netlify environment variable: GEMINI_API_KEY (no VITE_ prefix).

const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash-image',
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-3.5-flash',
]);

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const model = new URL(req.url).searchParams.get('model') ?? '';
  if (!ALLOWED_MODELS.has(model)) {
    return Response.json({ error: `Model not allowed: ${model}` }, { status: 400 });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return Response.json({ error: 'GEMINI_API_KEY is not configured on the server' }, { status: 500 });
  }

  const body = await req.text();
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
