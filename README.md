# NIT Hamirpur Free Fire Tournament — Final Update 2.10 (Vercel-ready)

**Current GitHub-root build:** this flat repository retains the tournament, fee, Vercel, authentication, storage, and visual updates through 2.10. The latest admin addition removes one entry's saved leaderboard result for the selected match date only, preserving the registration and all results from other dates.

A mobile-first website for a **student-organized** Free Fire tournament around NIT Hamirpur. The site does not claim institute, Garena, or Free Fire approval or endorsement.

## What’s included

- Root-level `index.html`, `battle-royale.html`, `clash-squad.html`, `schedule-results.html`, `leaderboard.html`, `status-check.html`, and `room-details.html` — public tournament pages
- Root-level `admin.html` and `admin-dashboard.html` — admin PIN sign-in, per-lobby fee controls, schedules, registration management, payments, rooms, dated results, and leaderboard settings
- Root-level `data.js`, `site.js`, and `styles.css` — tournament configuration, client logic, and accessible graphite/glass design with Apple system-font fallbacks, refined easing, visible focus, and reduced-motion/transparency support
- Root-level `server.py` and `dispatch.py` — local Python API, MongoDB state store, and the single Vercel Python Function dispatcher
- `vercel.json` — Vercel routing, explicit root-level static/function builds, and security headers
- `render.yaml` — retained as a separate legacy Render Free configuration; it is not used by Vercel
- `test_server_api.py` — root-level API/security regression suite

## Tournament setup, lobby fees and slot counts

- An admin can set the fee for each individual lobby from **Free (₹0) to ₹110 in ₹10 increments**. A fee change applies to future registrations; existing registrations retain the fee recorded when submitted.
- BR Solo fees are per player; BR Duo, Trio and Squad fees are per team. CS fees are once per registered side/team, independent of team size.
- Three time-linked slots are available for each mode. There is no five-slot/five-match schedule.
- BR has Solo, Duo, Trio and Squad formats. Each BR room holds up to **12 entries/teams** (slots 1–12) and plays **3 matches** in its assigned session.
- CS has Normal and One Tap types, each offered as **Solo 1v1, Duo 2v2, Trio 3v3, and Squad 4v4**. Each size/type/fee has one room in each of the 3 time slots; each room holds **2 sides of the same size** and plays **1 match**. The winner earns 3 leaderboard points.
- BR Solo fee is per player; BR Duo, Trio and Squad fees are per team. CS fees are charged once per registered side/team, regardless of team size.

## Deploy on Vercel

This repository is intentionally flat: HTML, CSS, JavaScript, `server.py`, `dispatch.py`, `requirements.txt`, and `vercel.json` live in the repository root, with no `public/`, `api/`, or `tests/` project subfolders. `vercel.json` explicitly builds the root static files and routes `/api/*` to the root-level `dispatch.py` Python Function. Keep the GitHub repository root as the Vercel project root; do not move files into a new folder.

Before the first deploy, privately configure these Vercel Environment Variables (Production and Preview as needed):

- `MONGODB_URI` — configure this for durable tournament state on Vercel. When a URI is configured, MongoDB is authoritative; connection failures return 503 without falling back to local JSON.
- `TOURNAMENT_REQUIRE_MONGODB=1` — set this on Vercel to make state reads/writes fail closed if `MONGODB_URI` is missing. Without this flag, the current code permits JSON under `/tmp` when the URI is unset; that filesystem is ephemeral and is not durable.
- `TOURNAMENT_ADMIN_PIN` — required for admin sign-in. Use a long, unique passphrase, not a short four-digit number.
- `TOURNAMENT_SESSION_SECRET` — required on Vercel for signed, stateless admin sessions shared across serverless instances. Generate a unique value locally with `python3 -c "import secrets; print(secrets.token_urlsafe(48))"` and paste it directly into Vercel's secret environment-variable UI. Never commit or send the generated value.
- Optional `MONGODB_DATABASE` and `MONGODB_COLLECTION` default to `nith_free_fire_db` and `tournament_state`.

Never put these values in `vercel.json`, `.env` committed to Git, or front-end files. Rotate the previously exposed MongoDB credential before setting a new URI. Ensure the database provider permits connections from Vercel and use a least-privilege database user.

Deploy the repository root through Vercel's Git integration or the Vercel CLI. No frontend build step is required. After setting or changing secrets, create a new deployment. Test `/`, `/api/state`, paid/free registration, admin login, a fee change, refresh/approval, and payment/room settings. The admin session is an 8-hour signed `HttpOnly`, `SameSite=Strict` cookie; changing the session secret invalidates existing sessions.

**Data migration warning:** If the previous live host used MongoDB, use the same database/collection with a newly rotated credential and verify the existing records before changing traffic. If that host used only local JSON, its data file is not automatically visible from Vercel; move the complete state into MongoDB using a trusted backup/migration procedure before cutover. Admin State JSON import/export is partial and cannot recover registrations or payment settings. Do not assume this source ZIP contains live records.

The app's lightweight IP rate limits remain process-local and can reset or differ across Vercel function instances; use Vercel's available edge/bot protections or another shared rate-limiting layer for stronger public abuse control. MongoDB state is kept as one document, so simultaneous writes from separate instances can still race; back up state and keep an eye on registration volume/concurrent admin edits.

## Run locally or on a Python host

Python 3.9+ is required. Install the optional MongoDB driver with `pip install -r requirements.txt`; without `MONGODB_URI`, the app continues to use local JSON state.

```bash
pip install -r requirements.txt
python3 server.py
```

Open `http://localhost:8000`. When run as a conventional Python web server, it binds to `0.0.0.0` and uses the host-provided `PORT` if set. Outside Vercel, without `MONGODB_URI` the default JSON state file is `server-data.json` beside `server.py`. In Vercel mode, when `MONGODB_URI` is unset and `TOURNAMENT_REQUIRE_MONGODB=1` is not set, the code uses JSON under `/tmp`; this fallback is ephemeral, not durable. Set the flag to `1` to refuse that fallback.

To put state in a durable, writable mounted directory, set `TOURNAMENT_DATA_DIR` before starting the server. For example:

```bash
TOURNAMENT_DATA_DIR=/mnt/tournament-data python3 server.py
```

Alternatively, set `TOURNAMENT_DATA_FILE` to the exact JSON file path. The server writes an atomic state file and retains the previous valid copy as `server-data.json.bak`. When a new data directory is configured, an existing legacy `server-data.json` is migrated on first load if it is still present. The most recent result stored on each legacy registration is also migrated into the new dated history using its score timestamp; older days that were already overwritten cannot be reconstructed. Keep an additional off-host backup too; the `.bak` copy is not protection against deleting the entire volume.

## Admin authentication and security

There is no hard-coded or browser-side admin PIN. Set `TOURNAMENT_ADMIN_PIN` privately in the hosting environment; the app has no default or source-code fallback. Do not put the value in Git, `render.yaml`, `vercel.json`, `data.js`, or chat. Use a long, unique value: a four-digit PIN such as `2026` is weak for a public admin panel and should not be used. If unset, admin sign-in fails closed.

Successful sign-in uses an 8-hour `HttpOnly`, `SameSite=Strict`, `Secure` cookie and per-session CSRF token. Render/local server mode keeps server-side sessions in process memory. Vercel uses HMAC-signed stateless sessions so they work across function instances; it requires `TOURNAMENT_SESSION_SECRET` (at least 32 characters of high-entropy secret material) in Vercel Environment Variables. Clearing the cookie signs out locally; a copied stateless cookie remains valid until expiry or until the secret is rotated. Admin writes also require same-origin requests.

The Python API and Vercel root-level static responses set CSP and other security headers, reject cross-origin API writes, accept JSON objects only, and validate/sanitize submitted fields server-side. `vercel.json` lists the root-level static files explicitly and routes API requests to `dispatch.py`; `server.py` and runtime state are not exposed as static assets. Local/Render mode serves only an explicit allowlist. Public `/api/state` intentionally includes public tournament data (published payment instructions/QR, approved leaderboard names/scores, and room credentials only when released); pending registration contact/payment-reference details remain admin-only.

Login/API rate limits are in-process and may reset or diverge across serverless instances; treat them as a lightweight safeguard, not shared rate limiting, a WAF, or MFA. Configure any available Vercel edge/bot protections for a public admin panel. Vercel provides HTTPS at the edge; the app has no third-party runtime dependency besides PyMongo for MongoDB. When `MONGODB_URI` is set, MongoDB is the authoritative state store and an outage does not fall back to JSON. If the URI is unset, the code uses JSON under ephemeral `/tmp` unless `TOURNAMENT_REQUIRE_MONGODB=1` is set; do not use that fallback for durable tournament data.

## MongoDB state storage

The current code permits JSON state without MongoDB, but a configured MongoDB is the durable shared store to use on Vercel. Set `MONGODB_URI` and `TOURNAMENT_REQUIRE_MONGODB=1` in Vercel Environment Variables: the flag makes the app fail closed instead of using ephemeral `/tmp` JSON if the URI is missing. MongoDB is also optional in local/Render single-server mode. Never put a credential-bearing URI in `server.py`, `render.yaml`, `vercel.json`, `data.js`, Git, or chat. Rotate any database credential previously pasted or committed before using a replacement. The defaults are `MONGODB_DATABASE=nith_free_fire_db` and `MONGODB_COLLECTION=tournament_state`; both can be overridden through environment variables.

The database uses one state document with `_id: "state"` and tournament state fields at the document's top level. If the collection is empty and a local JSON state file is present, the backend can migrate it once; Vercel does not receive a prior host's private local JSON file automatically. An existing state document is authoritative. When a configured database cannot be reached, API requests return 503 rather than silently writing locally. The admin status distinguishes a confirmed MongoDB connection from a local/mounted JSON file. On Vercel, if `MONGODB_URI` is absent and the require flag is unset, state is stored in ephemeral `/tmp` JSON and may be lost; if `TOURNAMENT_REQUIRE_MONGODB=1` is set, missing MongoDB causes state operations to fail closed. Payment settings and QR remain available until changed or removed only when saved in a store that actually persists, such as the configured MongoDB database. On local/Render mode, JSON is durable only if the host actually preserves that filesystem.

The in-app admin table reads registrations through the authenticated `/api/admin/summary` endpoint. On `admin.html`, scroll to **Registrations & approvals** and choose **Refresh registrations**; `admin-dashboard.html` also has a refresh button. The table includes player details and existing **Approve/Reject** actions on the admin page. The ₹0 cards labeled “reported paid” and “expected from approved entries” only count approved entries; they do not prove the database has no pending registrations.

Use a least-privilege MongoDB database user with access only to this database, protect the URI as a secret, and verify Atlas/network-provider connectivity from Vercel. The complete tournament state is one document; keep QR images optimized and note that simultaneous writes from different serverless instances can race because the process lock is not shared.

The source was inspected from a shallow, read-only clone, so this review does not scan the complete Git history. Use secret scanning and rotate any credential that was ever committed; deleting it from the current files alone does not remove it from Git history.

## Legacy Render storage notes (not used by Vercel)

**Only for a separate, older Render deployment:** the following notes do not apply to Vercel. The included `render.yaml` intentionally remains on Render’s Free plan; no Render plan or disk was changed. It does not silently opt you into a paid instance or configure storage. The MongoDB integration is included but must be configured with a private `MONGODB_URI` from your chosen external database service; availability, limits, and any charges are governed by that provider. Without `MONGODB_URI`, this app writes to local JSON and Render Free local files are not durable. Merely setting `TOURNAMENT_DATA_DIR` changes the path but does not make Free storage persistent. The admin panel distinguishes a confirmed MongoDB connection from a mounted host disk.

**Optional paid-disk path only if you explicitly authorize a plan change:** to keep this JSON-backed version on Render with durable payment settings, QR images, registrations and match history:

1. In Render, the existing web service must be on a plan that supports persistent disks. Persistent disks are a paid hosting feature; check the current price shown in your Render dashboard before confirming. This project does not upgrade or add that paid resource automatically.
2. Add a persistent disk to the **existing** web service, with mount path **`/var/data`** (1 GB is sufficient to start for this JSON-backed site).
3. In the service’s environment settings, set **`TOURNAMENT_DATA_DIR=/var/data`**. It is intentionally not set by the Free-plan Blueprint.
4. Redeploy and open `admin.html`. The storage status should say **“Mounted volume detected”**. The startup log also prints the active state-file path, expected as `/var/data/server-data.json`.
5. Keep the same service and disk when replacing site files. Back up `server-data.json` and `server-data.json.bak` to a separate location periodically.

If you keep the service on Free without a durable external store, the app can still run, but local JSON state may disappear on a restart or redeploy. Merely changing the JSON/backup code or setting a data-directory environment variable cannot make an ephemeral host durable. The browser’s Admin State JSON import/export is only a partial local transfer; it omits registrations and payment settings and is not a recovery backup. If the previous deployment has already deleted its only copy, this ZIP cannot recover that lost file; only a complete server backup can. On first startup with a persistent volume, the app will migrate the old app-directory JSON if it still exists.

For other hosts, point `TOURNAMENT_DATA_DIR` at the host’s persistent mounted storage and confirm the admin panel detects it. A configured folder alone is not a guarantee if the host does not persist it.

## Admin workflow

1. Open `admin.html`, enter the PIN privately configured as `TOURNAMENT_ADMIN_PIN`, and sign in. The browser receives a short-lived secure session cookie; no PIN is stored in `data.js`.
2. **Set match timings:** BR and CS each have their own start time, session duration (1 or 2 hours), and inter-slot gap (0, 1, or 2 hours). Times use IST. The three room suffixes map to Slot 1, Slot 2, and Slot 3.
3. **Set each lobby’s fee:** under **Set entry fee for each lobby**, choose mode, format/team size, CS type when relevant, time slot, and specific lobby. Select **Free (₹0)** or any amount through **₹110** in **₹10 steps**, then save. The reference stays stable; new registrations use the saved amount, while existing registrations keep their recorded fee. A free lobby requires no payment or UTR.
4. **Publish payment details:** upload an optional PNG/JPG/WebP payment QR (maximum 1 MB), enter an optional payee name and/or UPI ID, and add instructions. Clear the fields and remove the QR, then publish, to remove the details. They persist across Vercel redeployments only when saved in configured MongoDB; set `TOURNAMENT_REQUIRE_MONGODB=1` to reject Vercel's ephemeral JSON fallback. On other hosts, survival depends on that host's actual persistence.
5. **Verify a registration:** review the submitted UTR/reference and manually confirm payment. QR/UPI instructions do **not** provide automatic payment verification; paid entries stay pending until the organizer approves them.
6. **Edit or remove registrations:** “Edit names” lets the admin correct the entry/team and roster IGN names, including emoji and symbol names. Teammates can be removed from the roster. “Remove” deletes the registration and releases its slot.
7. **Use the registration calendar:** choose a month and click any day, including a date with no registrations. Registration counts and saved leaderboard-result counts are shown separately; date-specific empty states are displayed. Calendar selection also updates the result-entry date. Dates use India Standard Time.
8. **Publish/manage dated results:** select any match date, then enter BR kills and placement (1–12) for each of the 3 matches or CS Win/Loss and round difference. Results are archived by date. Re-saving a past date updates only that date and does not replace a newer match result. Use the row's **Remove result** action to delete only that entry/date's result; the registration and results from all other dates remain. The authenticated `POST /api/admin/delete-match-result` endpoint backs this action. BR points are kills plus the placement points in `data.js`; CS wins = 3 points, losses = 0.
9. **Manage room details:** select the correct mode, format/team size, current fee, and Normal/One Tap type before saving a Room ID/password and optional QR. “Remove Saved Room Details” unpublishes and deletes only those credentials; registrations remain unchanged.
10. **Choose the public default:** select either the latest saved match date or all-time cumulative standings. Visitors can also enter any date on the public leaderboard; unavailable dates show a clear empty state.
11. **Read save confirmations:** successful admin actions show a compact auto-dismiss toast for about 2.5 seconds. Failed saves show an error toast and do not show a success confirmation.
12. **Use State JSON carefully:** the browser Import/Export section moves only selected local counts/leaderboard/history settings. It is not a full server backup, excludes registrations and payment settings, and must not be used to recover live data or committed to `data.js`.

All-time BR totals add the saved date totals; the match cells show the most recent saved session. All-time CS totals add win points and use combined round difference as a tiebreaker. Public leaderboard history contains roster names/results, not player IDs, WhatsApp numbers or payment references.

## Registration and capacity notes

- BR lobby slots are numbered 1–12 for every BR format; CS lobby slots are 1–2. A submitted registration reserves a slot immediately, while admin approval is tracked separately.
- The selected lobby suffix is the time slot. Changing the schedule does not create extra rooms or matches; it only changes the displayed time for the three existing slots.
- Each Clash Squad size has separate rooms so 1v1, 2v2, 3v3 and 4v4 sides are never mixed in one match. New room IDs include their size; existing legacy 4v4 IDs remain unchanged so saved registrations and room details continue to resolve.
- Per-lobby fee overrides are persisted in server state; format definitions, match counts, and placement scoring remain in `data.js`.

## Deployment / replacing an older version

1. Preserve a complete private backup of live registrations, payment settings, room data, and results before changing the deployment. The browser State JSON transfer is incomplete.
2. If existing live state is already in MongoDB, configure the Vercel deployment to use the same database and collection with a newly rotated credential, then verify the state before directing users to it. If the old host used only a local JSON file, migrate its complete state to MongoDB using a trusted procedure first.
3. Deploy the repository root to Vercel as-is. The project is flat: Vercel uses the root `vercel.json`, static HTML/JS/CSS, root-level `dispatch.py`, and `requirements.txt`; do not create `public/` or `api/` subfolders.
4. Set `MONGODB_URI`, `TOURNAMENT_ADMIN_PIN`, and `TOURNAMENT_SESSION_SECRET` directly in Vercel Environment Variables. No secret belongs in source, `vercel.json`, or chat. Redeploy after changing environment variables.
5. Verify the public pages, `/api/state`, paid and free registrations, admin sign-in/session restoration, each-lobby fee change, registration refresh/approval, payment settings, room release, and dated result publishing.
6. `render.yaml` remains a separate legacy Render Free file; Vercel does not use it, and no Render plan/disk changes were made here. Do not treat the State JSON export as a full backup or recovery path.

## Files in this update

- Root-level HTML pages — registration, admin, dashboard, leaderboard, schedule, room details, status, and rules
- Root-level `data.js`, `site.js`, and `styles.css` — site data, UI logic, and styling
- Root-level `server.py` and `dispatch.py` — Python API/state handling and Vercel Function routing
- `vercel.json` — explicit root-level static and function builds, API rewrites, and security headers
- `render.yaml` — unchanged legacy Render Free config; not used by Vercel
- `requirements.txt` — PyMongo SRV driver
- `.gitignore` — excludes environment secrets, runtime JSON/backups and local tool files
- `README.md`, `PHONE_EDITING_GUIDE.md`, `SECURITY_AUDIT.md` — deployment, auth, storage, backup and verification guidance
- Root-level `test_server_api.py` — 47 API/security regressions, including selected-date result deletion

## Tests

Run the included backend regression tests and syntax checks from the repository root with:

```bash
python3 -m unittest discover -s . -p 'test_server_api.py' -v
node --check site.js
node --check data.js
python3 -m py_compile server.py dispatch.py test_server_api.py
```

The API/security regression suite covers per-lobby fee overrides from Free through ₹110, ₹10-step validation, fee persistence and free-entry registration; environment-configured PIN verification and fail-closed login; sessions/CSRF/rate limits; same-origin and JSON checks; static-file restrictions; safe partial State JSON transfer; MongoDB reads/writes/migration/outage handling; registration refresh controls; bounded-server configuration; payment QR persistence/backup recovery; legacy-file migration; dated results; date-scoped result deletion with registration/other-date preservation and score synchronization; leaderboard defaults; schedules; manual payment approval; BR scoring; variable-size and legacy CS rosters; room capacity/privacy; emoji edits; and registration removal.

## Privacy and event wording

Registration records contain player names/IDs, contact numbers and payment references. Restrict server and admin-PIN access. Share room credentials only with the registered players who need them. Keep all event copy as student-organized and do not imply institute/Garena/Free Fire approval.
