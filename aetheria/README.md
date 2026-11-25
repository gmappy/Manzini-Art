---
title: Aetheria Virtual Gallery
emoji: 🏛️
colorFrom: red
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

# AETHERIA

A 3D virtual art gallery (`index.html`) with live multiplayer visitor presence (`server.js`) and a curator interface (`admin.html`). No build step, zero npm dependencies.

## Run locally (with multiplayer)
```
node server.js
```
(or `npm start`.) Open http://localhost:8000 in two or more browser tabs or devices on your network to see visitors walk around in real time. Curator UI: http://localhost:8000/admin.html.

If opened from a plain static file server (e.g. `python3 -m http.server 8000`) without `server.js`, Aetheria falls back to same-browser `BroadcastChannel` presence across local tabs unless `window.AETHERIA_WS_URL` is configured in `multiplayer-config.js`.

## Controls
- Move: WASD / arrow keys, on-screen pad on touch. Look: drag. Click the floor to walk, click an artwork to go to it.
- Click the minimap to travel. The **Sky** slider previews other times of day; **Live** returns to your local time.
- **Visitors** pill (top-left): set your display name and avatar color, see who is currently in the gallery, and click **Visit** to walk over to another visitor.
- Guided Tour: Previous / Play / Next.

## Curating and publishing
Visitors see `exhibition.json` (shipped with the site). The admin edits a private draft in your browser; it never changes what visitors see on its own.
1. Open `admin.html`, curate, and check it with **Preview draft**.
2. Click **Publish: download exhibition.json**, replace `exhibition.json` in the project, and redeploy.

**Password:** on first open, `admin.html` asks you to create a curator password and shows one line to paste into `admin-config.js`; do that before deploying so it works on every device. This gate is client-side (a salted PBKDF2 hash): it keeps people out of the curator UI but is not server security. Use your host's access control on `/admin.html` for hard protection. Forgot it? Clear `admin-config.js` and site storage to set a new one.

The admin is not linked from the gallery. Exposing it is harmless: a visitor's edits only affect their own browser. Protect it with your host's password feature or leave it out of the deploy if you prefer.

Draft details: everything is saved to `localStorage` under `aetheria_exhibition_v1` in the visitor's browser. Use the admin to add or edit works, assign one of 16 wall slots, and set tour order (0 = not on the tour). Export JSON to back up or move to another device, then Import there. Reset restores the sample show. Uploaded images are downscaled to about 900px JPEG to fit browser storage.

## Deploy
- **Full multiplayer (Node host — Render, Railway, Fly.io, VPS)**: run `node server.js` (or `npm start`). It serves both the static gallery files and the `/ws` WebSocket endpoint on `process.env.PORT || 8000`.
- **Static frontend + separate WebSocket server (Vercel / Netlify)**: deploy `server.js` to any Node host, set `window.AETHERIA_WS_URL = 'wss://your-ws-host.example.com/ws'` in `multiplayer-config.js`, and deploy the static files to Vercel (`vercel.json`) or Netlify (`netlify.toml`). For a `public` publish dir, copy `index.html`, `admin.html`, `admin-config.js`, `multiplayer-config.js`, `store.js`, and `exhibition.json` into it; `public/_redirects` handles `/admin`.

Three.js r128 loads from cdnjs. If it or WebGL is unavailable, the gallery falls back to a 2D list of the exhibition. Curation is per-browser; exhibitions are shared through exported JSON.
