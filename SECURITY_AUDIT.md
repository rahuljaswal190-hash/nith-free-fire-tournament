# Security and deployment notes

**Scope:** source-level review of this workspace and local regression checks. This is not a live Vercel/Atlas penetration test or a guarantee of security.

## Authentication and request protections

- Admin sign-in reads only `TOURNAMENT_ADMIN_PIN` from the server environment. There is no default PIN, browser-side credential, source-code fallback, or hash-generation script. If unset, sign-in fails closed. Use a long, unique passphrase; a four-digit PIN is weak on a public admin panel.
- On Vercel, admin sessions are 8-hour HMAC-SHA256-signed stateless cookies so they remain valid across serverless instances. `TOURNAMENT_SESSION_SECRET` must be set privately in Vercel Environment Variables and contain at least 32 characters. The cookie is `HttpOnly`, `SameSite=Strict`, `Secure` on HTTPS, and carries a CSRF token bound to its signed payload. Clearing the cookie signs out the browser; a stolen/copied cookie remains valid until expiry or session-secret rotation.
- On the conventional local/Render Python server, the existing in-process server-side session behavior remains. Session/rate-limit state is not shared across processes.
- API writes require a same-origin `Origin`, JSON object payloads, a CSRF token for admin routes, validated server-derived registration fields, and a request-body limit. Security headers are applied by the Python handler and by `vercel.json` for Vercel static pages. No CORS access is enabled.
- IP/API rate limits are currently in process memory. On Vercel they may reset or differ across separate function instances; they are only a lightweight safeguard. For a publicly exposed admin panel, enable suitable Vercel edge/bot protections or use a shared rate-limit service. This deployment does not claim distributed rate limiting or MFA.

## Vercel routing, static assets, and storage

- Public website files live under `public/`; `vercel.json` sets that directory as the static output and routes `/api/*` through one Python Function at `api/dispatch.py`. The dispatcher only forwards known API paths. `server.py`, docs, tests, deployment configuration, and runtime state are outside the static output; `.vercelignore` also excludes docs/tests and local state from the deployment upload.
- Vercel function filesystems are not treated as durable. When `VERCEL=1`/`VERCEL_ENV` is detected, the app requires `MONGODB_URI` before reading or writing state; it returns 503 rather than using local JSON if the URI is absent or MongoDB is unavailable. The Vercel admin status also identifies the missing persistent store. `/tmp` is only a scratch path, not a persistence solution.
- MongoDB uses the existing single state document `_id: "state"`, with top-level tournament state. A configured database outage returns 503 without local fallback. The application-level state document includes registrations, contact/payment references, lobby-fee overrides, payment settings/QR, room information, and result history. Use a least-privilege database account, backups, and provider-side access controls.
- State updates use an in-process lock and replace the full MongoDB state document. Vercel can run multiple function instances, so simultaneous writes from different instances can race. This remains a known limitation for concurrent registrations/admin edits; keep off-host backups and verify data after cutover.
- On conventional local/Render server mode, JSON remains available when `MONGODB_URI` is unset. File permissions and atomic replacement protect local writes where supported, but durability depends on the host's actual storage. The existing `render.yaml` remains unchanged on Render Free and is not used by Vercel.
- The Admin State JSON transfer is partial: it omits registrations, payment settings and QR, room credentials, and lobby-fee overrides. It is not a server recovery backup.

## Secret hygiene and external data

- No literal production MongoDB URI or credential is intentionally present in the current source. A database credential was exposed in an earlier user-pasted snippet; consider it compromised, rotate it in the database provider, and use only the replacement URI in Vercel Environment Variables. Do not reuse or paste the exposed/new credential in source, Git, `vercel.json`, `public/data.js`, or chat.
- Set `TOURNAMENT_ADMIN_PIN`, `TOURNAMENT_SESSION_SECRET`, and `MONGODB_URI` directly in Vercel's protected Environment Variable settings; do not put actual values in the ZIP or repository. Generate a fresh high-entropy session secret locally, for example with `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`.
- Public `/api/state` intentionally includes public event data, released room details, published payment instructions/QR, and approved leaderboard data. Pending registrations, player contact details, and payment references remain admin-only.
- The local workspace has no Git metadata, so commit history or remote repository contents could not be scanned. No Vercel project, environment values, live MongoDB connection, or live deployment was inspected or changed.

## Verification performed in the workspace

- `python3 -m unittest discover -s tests -v` — **40 tests passed**, including Vercel rewrite dispatch, session signature/expiry, Vercel fail-closed storage, and the existing fee/tournament/security/MongoDB regression coverage. MongoDB tests use a fake collection; they do not connect to a live cluster.
- `python3 -m py_compile server.py api/dispatch.py tests/test_server_api.py` — passed.
- `node --check public/site.js` and `node --check public/data.js` — passed.
- HTML checks cover all public HTML pages, external script tags, and current cache-busting values.
- The Vercel CLI was available, but `vercel dev` could not start because the CLI requires account credentials and none were available in this workspace. No Vercel deployment or environment change was performed.

These checks validate only the local code paths exercised here; they do not validate the user's Vercel project settings, a live Vercel Function build, database network allowlists, real credentials, or every device/browser.

## Rollout checklist

1. Before cutover, secure a complete, private backup. If existing live data is already in MongoDB, use that same database/collection with a newly rotated credential and verify it. If the old host used local JSON, perform a trusted full-state migration first; this ZIP cannot recover an unbundled server file.
2. In Vercel Environment Variables, set `MONGODB_URI`, a long unique `TOURNAMENT_ADMIN_PIN`, and a fresh high-entropy `TOURNAMENT_SESSION_SECRET` for the relevant environments. Set optional database/collection overrides only if needed. Never put secret values in `vercel.json` or source.
3. Deploy the repository root. Keep `public/`, `api/dispatch.py`, `server.py`, `requirements.txt`, and `vercel.json` together; do not set Vercel's project root to `public/`.
4. Verify public registration/status, free and paid registration, admin sign-in/session restoration, lobby fee changes, registration refresh/approval, payment settings, room release, result publishing, and database connectivity.
5. Keep backups private and encrypted. If the deployment is public, enable suitable edge/bot protections and monitor MongoDB state size and concurrent edits.

---
