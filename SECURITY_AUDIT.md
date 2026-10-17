# Security and deployment notes

**Scope:** source-level review of this workspace and local regression checks. This is not a live Vercel/Atlas penetration test or a guarantee of security.

## Authentication and request protections

- Admin sign-in reads only `TOURNAMENT_ADMIN_PIN` from the server environment. There is no default PIN, browser-side credential, source-code fallback, or hash-generation script. If unset, sign-in fails closed. Use a long, unique passphrase; a four-digit PIN is weak on a public admin panel.
- On Vercel, admin sessions are 8-hour HMAC-SHA256-signed stateless cookies so they remain valid across serverless instances. `TOURNAMENT_SESSION_SECRET` must be set privately in Vercel Environment Variables and contain at least 32 characters. The cookie is `HttpOnly`, `SameSite=Strict`, `Secure` on HTTPS, and carries a CSRF token bound to its signed payload. Clearing the cookie signs out the browser; a stolen/copied cookie remains valid until expiry or session-secret rotation.
- On the conventional local/Render Python server, the existing in-process server-side session behavior remains. Session/rate-limit state is not shared across processes.
- API writes require a same-origin `Origin`, JSON object payloads, a CSRF token for admin routes, validated server-derived registration fields, and a request-body limit. The new `POST /api/admin/delete-match-result` action uses this existing admin protection and is included in the Vercel dispatcher allowlist. Security headers are applied by the Python handler and by `vercel.json` for Vercel static pages. No CORS access is enabled.
- IP/API rate limits are currently in process memory. On Vercel they may reset or differ across separate function instances; they are only a lightweight safeguard. For a publicly exposed admin panel, enable suitable Vercel edge/bot protections or use a shared rate-limit service. This deployment does not claim distributed rate limiting or MFA.

## Vercel routing, static assets, and storage

- The GitHub repository layout is flat: website HTML/CSS/JS, `server.py`, `dispatch.py`, `requirements.txt`, and `vercel.json` are at the root; there are no `public/`, `api/`, or `tests/` project subfolders. `vercel.json` explicitly lists the root static files and routes `/api/*` to the root `dispatch.py` Python Function. The dispatcher forwards only known API paths; `server.py` and runtime state are not built as static assets.
- Vercel function filesystems are not durable. When `VERCEL=1`/`VERCEL_ENV` is detected, the code uses JSON under `/tmp` if `MONGODB_URI` is absent and `TOURNAMENT_REQUIRE_MONGODB` is not `1`; that fallback may be lost and is not appropriate for durable state. Set `MONGODB_URI` and `TOURNAMENT_REQUIRE_MONGODB=1` for persistent MongoDB-backed operation and fail-closed behavior if the URI is missing. A configured database outage returns 503 without local fallback.
- MongoDB uses the existing single state document `_id: "state"`, with top-level tournament state. A configured database outage returns 503 without local fallback. The application-level state document includes registrations, contact/payment references, lobby-fee overrides, payment settings/QR, room information, and result history. Use a least-privilege database account, backups, and provider-side access controls.
- State updates use an in-process lock and replace the full MongoDB state document. Vercel can run multiple function instances, so simultaneous writes from different instances can race. This remains a known limitation for concurrent registrations/admin edits; keep off-host backups and verify data after cutover.
- On conventional local/Render server mode, JSON remains available when `MONGODB_URI` is unset. File permissions and atomic replacement protect local writes where supported, but durability depends on the host's actual storage. On Render Free, setting `TOURNAMENT_DATA_DIR` only changes the path; it does not itself make storage persistent. The existing `render.yaml` remains unchanged on Render Free and is not used by Vercel.
- The Admin State JSON transfer is partial: it omits registrations, payment settings and QR, room credentials, and lobby-fee overrides. It is not a server recovery backup.

## Secret hygiene and external data

- No literal production MongoDB URI or credential is intentionally present in the current source. A database credential was exposed in an earlier user-pasted snippet; consider it compromised, rotate it in the database provider, and use only the replacement URI in Vercel Environment Variables. Do not reuse or paste the exposed/new credential in source, Git, `vercel.json`, `data.js`, or chat.
- Set `TOURNAMENT_ADMIN_PIN`, `TOURNAMENT_SESSION_SECRET`, `MONGODB_URI`, and `TOURNAMENT_REQUIRE_MONGODB=1` directly in Vercel's protected Environment Variable settings; do not put actual secret values in the ZIP or repository. Generate a fresh high-entropy session secret locally, for example with `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`.
- Public `/api/state` intentionally includes public event data, released room details, published payment instructions/QR, and approved leaderboard data. Pending registrations, player contact details, and payment references remain admin-only.
- The public GitHub `main` snapshot was inspected from a shallow, read-only clone; no full-history secret scan was performed. No GitHub commit/push, Vercel project access, environment changes, live MongoDB connection, or live deployment was performed.

## Verification performed in the workspace

- `python3 -m unittest discover -s . -p 'test_server_api.py'` — **48 tests passed**, including Vercel rewrite dispatch, session signature/expiry, the optional fail-closed MongoDB flag, the visible admin delete control, and result deletion auth/scope/score synchronization. MongoDB tests use a fake collection; they do not connect to a live cluster.
- `python3 -m py_compile server.py dispatch.py test_server_api.py` — passed.
- `node --check site.js` and `node --check data.js` — passed.
- `python3 -m json.tool vercel.json` and `git diff --check` — passed.
- HTML asset checks cover all 11 root-level HTML pages; they validate local asset references and the current shared cache-busting key (30 versioned references).
- The Vercel CLI was available, but `vercel dev` could not start because the CLI requires account credentials and none were available in this workspace. No Vercel deployment or environment change was performed.

These checks validate only the local code paths exercised here; they do not validate the user's Vercel project settings, a live Vercel Function build, database network allowlists, real credentials, or every device/browser.

## Rollout checklist

1. Before cutover, secure a complete, private backup. If existing live data is already in MongoDB, use that same database/collection with a newly rotated credential and verify it. If the old host used local JSON, perform a trusted full-state migration first; this ZIP cannot recover an unbundled server file.
2. In Vercel Environment Variables, set `MONGODB_URI`, `TOURNAMENT_REQUIRE_MONGODB=1`, a long unique `TOURNAMENT_ADMIN_PIN`, and a fresh high-entropy `TOURNAMENT_SESSION_SECRET` for the relevant environments. Set optional database/collection overrides only if needed. Never put secret values in `vercel.json` or source.
3. Deploy the repository root with its existing flat layout. Keep the static files, root-level `dispatch.py`, `server.py`, `requirements.txt`, and `vercel.json` at the root; do not introduce `public/` or `api/` subfolders.
4. Verify public registration/status, free and paid registration, admin sign-in/session restoration, lobby fee changes, registration refresh/approval, payment settings, room release, result publishing, and database connectivity.
5. Keep backups private and encrypted. If the deployment is public, enable suitable edge/bot protections and monitor MongoDB state size and concurrent edits.

---
