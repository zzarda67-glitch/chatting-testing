# Deploy on Tencent EdgeOne Pages

This project is **split** for EdgeOne:

| Part | Where it runs | Why |
|------|----------------|-----|
| **Chat UI + Admin UI (static)** | **EdgeOne Pages** | HTML, JS, CSS, edge CDN |
| **API + WebSocket + `data/`** | **Your own Node host** | Express, Socket.IO, JSON/DB need a long‑running server |

EdgeOne Pages does **not** run `server.js`. Deploy the backend separately, then point the frontend at it with build-time env vars.

## 1. Deploy the API (required first)

Run Node **20+** somewhere public (examples):

- **Tencent Cloud Lighthouse / CVM** (same account family as EdgeOne)
- **Container** (Tencent TKE, or any Docker host)
- **Railway, Render, Fly.io**, etc.

On the server:

```bash
git clone <your-repo>
cd chatting-public-app
npm ci --omit=dev   # production: install without dev-only tools if you split deps
# Or: npm ci
export NODE_ENV=production
export JWT_SECRET=<strong-random-string>
export PORT=3000
export CORS_ORIGIN=https://<your-pages-domain>.edgeone.app
# Optional: promote first admin user on boot
# export ADMIN_BOOTSTRAP_EMAIL=you@example.com
node server.js
```

Use **HTTPS** in front of Node (Nginx, Caddy, or Tencent load balancer). Example public API origin:

`https://api.yourdomain.com`

**CORS:** set `CORS_ORIGIN` to your **EdgeOne Pages** URL (and later your custom domain). The app uses `Authorization` headers, not cookies, for the chat API.

**WebSocket:** Socket.IO must be reachable on the **same host** you set for `VITE_SOCKET_URL` (usually the API origin). Ensure your reverse proxy forwards **WebSocket** upgrades for path `/socket.io/`.

**Persistence:** `data/*.json` and `uploads/` must live on a **persistent disk** on the API server (not on Pages).

## 2. EdgeOne Pages project

### Git import

1. Push this repo to GitHub / Gitee / Coding.
2. In [EdgeOne Pages](https://pages.edgeone.ai/), **Import Git Repository** and select the repo.
3. The repo root includes **`edgeone.json`** — build uses:
   - **Install:** `npm install`
   - **Build:** `npm run build:pages`
   - **Output:** `dist`

### Environment variables (build time)

Vite inlines these at **build** time. Set them in the Pages console **Environment variables** for Production (and Preview if needed):

| Variable | Example | Purpose |
|----------|---------|---------|
| `VITE_API_BASE_URL` | `https://api.yourdomain.com` | REST: `/login`, `/register`, `/messages`, … |
| `VITE_SOCKET_URL` | `https://api.yourdomain.com` | Socket.IO client (same origin as API in most setups) |

No trailing slash. After changing vars, **redeploy** so the client bundle rebuilds.

### Custom domain

Bind your domain in Pages, then:

- Update `CORS_ORIGIN` on the API to that origin (e.g. `https://chat.yourdomain.com`).
- Rebuild Pages if you change `VITE_*` URLs.

## 3. What `build:pages` does

1. `vite build` → main chat app in `dist/`.
2. `build:admin` → admin UI in `admin-ui/dist/` (base path `/admin/`).
3. `scripts/prepare-edgeone-dist.mjs` → copies `admin-ui/dist` → `dist/admin/`.

Result:

- `https://<pages>/` — chat  
- `https://<pages>/admin/` — admin panel (staff login still calls your API)

## 4. InsForge mode

If the chat uses **InsForge** (`VITE_INSFORGE_*` in `.env`), configure those in Pages as well. The **local** Express API is unused for chat in that mode, but **admin** may still target your server if you use this project’s admin API — align env with your architecture.

## 5. CLI deploy (optional)

```bash
npm install -g edgeone
edgeone login
edgeone pages deploy -n <project-name>
```

See: [EdgeOne CLI](https://edgeone.ai/document/162228053922476032).

## 6. Checklist

- [ ] API live with TLS and WebSocket for `/socket.io/`
- [ ] `CORS_ORIGIN` matches Pages URL
- [ ] `VITE_API_BASE_URL` and `VITE_SOCKET_URL` set on Pages, then redeploy
- [ ] `JWT_SECRET` set on API (not default)
- [ ] Persistent volume for `data/` (and `uploads/` if you use media)

For generic hosting notes, see `DEPLOYMENT.md`.
