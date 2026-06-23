# Canopy — DIY Flow

A Vite + React single-page app for the Canopy DIY landscape-design flow. This
branch (`diy`) is the deployable subset of the larger Canopy project: only the
DIY user journey and the modules it depends on.

## Stack
- React 18 + React Router (client-side routing)
- Vite 5 build (esbuild), Tailwind CSS
- Calls Google Gemini, Google Maps, and Mapbox **directly from the browser**

## Local development
```bash
cd frontend
npm install
cp .env.example .env   # then fill in your keys
npm run dev            # http://localhost:5173
```

## Environment variables
Set these at build time (Vite inlines `VITE_*` into the client bundle, so they
are publicly visible — use browser-safe / referrer-restricted keys):

| Variable | Used for |
| --- | --- |
| `VITE_GEMINI_API_KEY` | Gemini image/text generation |
| `VITE_GOOGLE_MAPS_KEY` | Google Maps |
| `VITE_MAPBOX_TOKEN` | Mapbox GL |

## Build
```bash
cd frontend
npm run build     # outputs frontend/dist
npm run typecheck # optional: tsc --noEmit (project has known WIP type errors)
```

## Deploy (Netlify)
Configured via [`netlify.toml`](netlify.toml): base `frontend`, build
`npm run build`, publish `dist`, with an SPA fallback so `/diy/*` routes resolve
on direct load. Set the three `VITE_*` variables in the Netlify site settings.

## Routes
- `/` — home
- `/diy/preferences` → `/diy/boundary` → `/diy/concept` → `/diy/plan` … the DIY flow
