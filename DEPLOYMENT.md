# Deployment guide — Vibely Chat + admin panel

This project can run as a **single Node.js process** (Express + Socket.IO + static JSON “database”) with an optional **InsForge** frontend (see `.env.example`). The admin panel documented here targets the **local Express API** (`server.js`).

**Tencent EdgeOne Pages:** static UI + separate API — see **`EDGEONE.md`** (root `edgeone.json`, `npm run build:pages`).

## What you are deploying

- **API + realtime**: `server.js` on a port (default `3000`).
- **Main chat UI**: build with `npm run build` and serve `dist/` (or use Vite dev on `5173`).
- **Admin UI**: build with `npm run build:admin`, output in `admin-ui/dist/`, served by Express at **`/admin`** when that folder exists.

## Prerequisites

- Node.js 20+ (LTS recommended).
- For production: a strong `JWT_SECRET`, HTTPS reverse proxy (nginx, Caddy, or AWS ALB), and backups for the `data/` directory.

## Environment variables

Copy `.env.example` to `.env` and set at least:

| Variable | Purpose |
|----------|---------|
| `JWT_SECRET` | Signing key for user and staff sessions. **Required in production.** |
| `ADMIN_BOOTSTRAP_EMAIL` | On startup, `migrateUsers` promotes this **existing** account to `admin` if it is not already. |
| `CORS_ORIGIN` | Optional. If set, CORS is restricted to that origin with credentials-friendly behavior. |
| `PORT` | HTTP port (default `3000`). |
| `AUTH_RATE_LIMIT_MAX` | Optional cap on auth requests per 15 minutes per IP (default `120`). |

InsForge-related `VITE_*` keys apply only when the main app is configured to use InsForge instead of the local API.

## First-time admin access

1. Register a normal user in the chat app with the email you will use as admin (or use an existing account).
2. Set `ADMIN_BOOTSTRAP_EMAIL` to that email and restart the server once so `lib/migrateUsers.js` can assign `role: "admin"`.
3. Remove or change `ADMIN_BOOTSTRAP_EMAIL` after bootstrap so the account is not re-promoted unexpectedly in shared environments.
4. Open **`/admin`**, sign in with that user. Additional staff can be given `sub_admin` or `editor` from **Users** in the admin UI.

## Build and run (production-style)

```bash
npm install
npm run build:admin
npm run build
node server.js
```

Serve the built main app (`dist/`) from the same origin as the API, or configure the chat client’s API base URL accordingly. The admin UI expects `/api/admin/*` and `/login` on the same host (or configure a reverse proxy so those paths reach Express).

## Security notes

- **JSON files in `data/`** are suitable for demos and small teams only. For “scalable” production, migrate users, messages, CMS, audit, and settings to **PostgreSQL/MySQL** (or MongoDB) and keep the same route shapes behind a repository layer.
- **Helmet** and **rate limiting** are enabled in `server.js` for baseline hardening. Tune `CORS_ORIGIN` for production.
- **RBAC**: `admin` > `sub_admin` > `editor`. Only `admin` can assign the `admin` role, manage API keys, and broadcast staff notifications. See `lib/permissions.js`.
- **Password reset**: `POST /api/auth/forgot-password` and `POST /api/auth/reset-password` (token store in `data/password_resets.json`). Wire outbound email in production (SMTP or provider).
- **XSS**: Admin UI uses `textContent` escaping for dynamic table content. Treat CMS `body` as untrusted when rendering publicly.
- **CSRF**: APIs use **Bearer JWT** in `Authorization`; CSRF against third-party sites is not applicable in the same way as cookie sessions. If you move tokens into `httpOnly` cookies, add CSRF tokens or double-submit cookies.

## Hosting examples

- **DigitalOcean / AWS EC2**: Ubuntu VM, install Node, run `server.js` under **systemd** or **PM2**, put **nginx** in front for TLS and `proxy_pass` to `127.0.0.1:3000`.
- **AWS**: Similar with ALB + target group; store `data/` on an EBS volume or move persistence to RDS.
- **Firebase**: Not a drop-in host for this Express server; you would deploy the API elsewhere (Cloud Run, Functions with adapters) or refactor to Firebase Auth + Firestore.

## Optional next steps

- SMTP for forgot-password and notification email.
- Move media from `uploads/` to S3-compatible object storage.
- PDF server-side generation (e.g. dedicated worker + headless Chromium or a PDF library) if you need automated PDFs beyond browser print-to-PDF.
