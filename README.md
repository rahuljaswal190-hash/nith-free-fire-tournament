# NIT Hamirpur Free Fire Tournament — Variable CS Formats & Date Controls

A mobile-first website for a **student-organized** Free Fire tournament around NIT Hamirpur. The site does not claim institute, Garena, or Free Fire approval or endorsement.

## What’s included

- `index.html` — event overview and live availability
- `battle-royale.html` — Solo, Duo, Trio, Squad registrations and BR sessions
- `clash-squad.html` — Normal and One Tap Clash Squad registrations in 1v1, 2v2, 3v3 and 4v4 sizes
- `schedule-results.html` — separate BR/CS slot schedules and event flow
- `leaderboard.html` — latest, selected-date, and all-time standings
- `status-check.html` — registration status by selected room and assigned slot
- `room-details.html` — released custom-room ID/password and optional room QR
- `admin.html` — schedule, registration calendar, payment, room, dated results, and leaderboard-default controls
- `admin-dashboard.html` — admin-only registration and payment summary
- `server.py` — standard-library Python web server and JSON API
- `data.js`, `site.js`, `styles.css` — tournament configuration, site logic and styling

## Tournament setup and slot counts

- Battle Royale fee tiers: **₹20, ₹40, ₹60, ₹80, ₹100**
- Clash Squad fee tiers: **₹50, ₹70, ₹90, ₹110**
- Three time-linked slots are available for each mode. There is no five-slot/five-match schedule.
- BR has Solo, Duo, Trio and Squad formats. Each BR room holds up to **12 entries/teams** (slots 1–12) and plays **3 matches** in its assigned session.
- CS has Normal and One Tap types, each offered as **Solo 1v1, Duo 2v2, Trio 3v3, and Squad 4v4**. Each size/type/fee has one room in each of the 3 time slots; each room holds **2 sides of the same size** and plays **1 match**. The winner earns 3 leaderboard points.
- BR Solo fee is per player; BR Duo, Trio and Squad fees are per team. CS fees are charged once per registered side/team, regardless of team size.

## Run locally or on a Python host

Python 3.9+ is sufficient; there are no third-party package requirements.

```bash
python3 server.py
```

Open `http://localhost:8000`. On deployment, the server binds to `0.0.0.0` and uses the host-provided `PORT` environment variable if set. The default state file is `server-data.json` beside `server.py`.

To put state in a durable, writable mounted directory, set `TOURNAMENT_DATA_DIR` before starting the server. For example:

```bash
TOURNAMENT_DATA_DIR=/mnt/tournament-data python3 server.py
```

Alternatively, set `TOURNAMENT_DATA_FILE` to the exact JSON file path. The server writes an atomic state file and retains the previous valid copy as `server-data.json.bak`. When a new data directory is configured, an existing legacy `server-data.json` is migrated on first load if it is still present. The most recent result stored on each legacy registration is also migrated into the new dated history using its score timestamp; older days that were already overwritten cannot be reconstructed. Keep an additional off-host backup too; the `.bak` copy is not protection against deleting the entire volume.

## Admin authentication and security

There is no hard-coded or browser-side admin password. The server accepts an admin passphrase only after checking a salted PBKDF2-HMAC-SHA256 verifier held in `TOURNAMENT_ADMIN_PASSWORD_HASH`. Generate one interactively with:

```bash
python3 generate_admin_hash.py
```

Use a unique passphrase of at least 16 characters. The script prompts without echoing it and prints a verifier; copy the verifier directly to the host environment variable. Never commit a plaintext password, verifier, API key, `.env`, or registration JSON. Remove any old `TOURNAMENT_ADMIN_PIN` environment variable after configuring the new hash; the new code does not use it. If the verifier is unset, admin sign-in is disabled (public pages can still run).

Successful sign-in creates an 8-hour, server-side session and an `HttpOnly`, `SameSite=Strict`, `Secure` cookie on HTTPS. Admin writes require a per-session CSRF token and same-origin requests. Login attempts and API routes are rate-limited. Offline/browser-only admin writes are disabled on HTTP(S) so a local browser fallback cannot bypass the server.

The server sends CSP and other security headers, rejects cross-origin API writes, accepts JSON objects only, validates/sanitizes submitted fields server-side, and serves only an explicit allowlist of public HTML/JS/CSS files. State JSON and temporary/backup files are written with owner-only permissions where supported. Public `/api/state` intentionally contains public tournament data (published payment instructions/QR, approved leaderboard names/scores, and room credentials only when released); pending registration contact/payment-reference details remain admin-only.

Rate limiting and sessions are in-memory and reset on a process restart; they are suitable as a lightweight single-instance safeguard, not a substitute for a managed WAF/identity provider. HTTPS is expected in production; Render provides TLS termination. This project has no API keys or third-party dependencies. The JSON file is not a database and Render Free storage remains ephemeral.

The local workspace has no `.git` metadata, so its historical commits cannot be scanned here. If you publish this source in a Git repository, use secret scanning and rotate any credential that was ever committed; deleting it from the current files alone does not remove it from Git history.

## Important: persistent storage on Render

The included `render.yaml` **intentionally remains on Render’s Free plan**; it does not silently opt you into a paid instance or configure storage. This version writes state to a local JSON file, and Render Free local files are not durable. A durable Render Free setup needs integration with an external database/store; that integration is not included. Merely setting `TOURNAMENT_DATA_DIR` does not make Free storage persistent. The admin panel warns when it cannot detect a mounted volume.

**Optional paid-disk path only if you explicitly authorize a plan change:** to keep this JSON-backed version on Render with durable payment settings, QR images, registrations and match history:

1. In Render, the existing web service must be on a plan that supports persistent disks. Persistent disks are a paid hosting feature; check the current price shown in your Render dashboard before confirming. This project does not upgrade or add that paid resource automatically.
2. Add a persistent disk to the **existing** web service, with mount path **`/var/data`** (1 GB is sufficient to start for this JSON-backed site).
3. In the service’s environment settings, set **`TOURNAMENT_DATA_DIR=/var/data`**. It is intentionally not set by the Free-plan Blueprint.
4. Redeploy and open `admin.html`. The storage status should say **“Mounted volume detected”**. The startup log also prints the active state-file path, expected as `/var/data/server-data.json`.
5. Keep the same service and disk when replacing site files. Back up `server-data.json` and `server-data.json.bak` to a separate location periodically.

If you keep the service on Free without a durable external store, the app can still run, but local JSON state may disappear on a restart or redeploy. Merely changing the JSON/backup code or setting a data-directory environment variable cannot make an ephemeral host durable. The browser’s Admin State JSON import/export is only a partial local transfer; it omits registrations and payment settings and is not a recovery backup. If the previous deployment has already deleted its only copy, this ZIP cannot recover that lost file; only a complete server backup can. On first startup with a persistent volume, the app will migrate the old app-directory JSON if it still exists.

For other hosts, point `TOURNAMENT_DATA_DIR` at the host’s persistent mounted storage and confirm the admin panel detects it. A configured folder alone is not a guarantee if the host does not persist it.

## Admin workflow

1. Open `admin.html`, enter the configured admin passphrase, and sign in. The browser receives a short-lived secure session cookie; no password is stored in `data.js`.
2. **Set match timings:** BR and CS each have their own start time, session duration (1 or 2 hours), and inter-slot gap (0, 1, or 2 hours). Times use IST. The three room suffixes map to Slot 1, Slot 2, and Slot 3.
3. **Publish payment details:** upload an optional PNG/JPG/WebP payment QR (maximum 1 MB), enter an optional payee name and/or UPI ID, and add instructions. Payment details remain in server state until an admin changes or removes them. Their survival across host restarts still depends on the persistent-storage setup above.
4. **Verify a registration:** review the submitted UTR/reference and manually confirm payment. QR/UPI instructions do **not** provide automatic payment verification; entries stay pending until the organizer approves them.
5. **Edit or remove registrations:** “Edit names” lets the admin correct the entry/team and roster IGN names, including emoji and symbol names. Teammates can be removed from the roster. “Remove” deletes the registration and releases its slot.
6. **Use the registration calendar:** choose a month and click any day, including a date with no registrations. Registration counts and saved leaderboard-result counts are shown separately; date-specific empty states are displayed. Calendar selection also updates the result-entry date. Dates use India Standard Time.
7. **Publish dated results:** select any match date, then enter BR kills and placement (1–12) for each of the 3 matches or CS Win/Loss and round difference. Results are archived by date. Re-saving a past date updates only that date and does not replace a newer match result. BR points are kills plus the placement points in `data.js`; CS wins = 3 points, losses = 0.
8. **Manage room details:** select the correct mode, format/team size, fee, and Normal/One Tap type before saving a Room ID/password and optional QR. “Remove Saved Room Details” unpublishes and deletes only those credentials; registrations remain unchanged.
9. **Choose the public default:** select either the latest saved match date or all-time cumulative standings. Visitors can also enter any date on the public leaderboard; unavailable dates show a clear empty state.
10. **Read save confirmations:** successful admin actions show a compact auto-dismiss toast for about 2.5 seconds. Failed saves show an error toast and do not show a success confirmation.
11. **Use State JSON carefully:** the browser Import/Export section moves only selected local counts/leaderboard/history settings. It is not a full server backup, excludes registrations and payment settings, and must not be used to recover live data or committed to `data.js`.

All-time BR totals add the saved date totals; the match cells show the most recent saved session. All-time CS totals add win points and use combined round difference as a tiebreaker. Public leaderboard history contains roster names/results, not player IDs, WhatsApp numbers or payment references.

## Registration and capacity notes

- BR lobby slots are numbered 1–12 for every BR format; CS lobby slots are 1–2. A submitted registration reserves a slot immediately, while admin approval is tracked separately.
- The selected lobby suffix is the time slot. Changing the schedule does not create extra rooms or matches; it only changes the displayed time for the three existing slots.
- Each Clash Squad size has separate rooms so 1v1, 2v2, 3v3 and 4v4 sides are never mixed in one match. New room IDs include their size; existing legacy 4v4 IDs remain unchanged so saved registrations and room details continue to resolve.
- The BR fee, CS fee, match counts, and placement table are configured in `data.js`.

## Deployment / replacing an older version

1. Extract the complete updated ZIP.
2. Replace the previous site files with the extracted files as one set; do not keep an old `data.js`, `site.js`, `server.py`, page HTML, or `styles.css` alongside the new files.
3. Keep the existing Render service on Free unless you explicitly authorize a plan change. This JSON-backed version cannot guarantee durable records on Render Free; a durable Free setup needs external-store integration, which is not included. Do not treat the browser’s partial State JSON export as a full backup or recovery path.
4. Generate a new hash with `python3 generate_admin_hash.py`; set `TOURNAMENT_ADMIN_PASSWORD_HASH` in the host environment before deploying this version. Remove the unused legacy `TOURNAMENT_ADMIN_PIN` variable after verifying sign-in. Never send the password or verifier in chat or commit either value.
5. After deployment, test the public registration, status check, admin approval, payment instructions, date selection, dated result publishing, calendar and storage-status message.
6. Static hosting such as GitHub Pages alone does not provide shared, durable registration/admin storage. Use the included Python backend for shared live behavior.

## Files changed in this update

- `server.py` — password-hash auth, server-side sessions/CSRF, same-origin and JSON validation, rate limits, security headers, static-file allowlist, bounded request threads/socket timeout, safer state-file writes, and existing tournament API behavior
- `site.js` — server-backed admin login/logout, fail-closed admin writes, and local State JSON export that omits room credentials
- `data.js` — removed the exposed client-side admin credential; tournament formats and room configuration remain
- `admin.html`, `admin-dashboard.html` — passphrase sign-in/sign-out and clear limits for partial State JSON export/import
- `generate_admin_hash.py` — interactive salted PBKDF2 verifier generator
- `render.yaml` — remains on Render Free; no paid plan, disk, or secret value is enabled
- `.gitignore` — excludes local environment/secrets, runtime JSON, backups, temporary files, and key files
- `README.md`, `PHONE_EDITING_GUIDE.md`, `SECURITY_AUDIT.md` — authentication, backup, Render Free, deployment and verification guidance
- `tests/test_server_api.py` — 27 API/security regression tests, including bounded-server configuration, safe State JSON transfer, and tournament behavior

## Tests

Run the included backend regression tests and syntax checks with:

```bash
python3 -m unittest discover -s tests -v
node --check site.js
node --check data.js
python3 -m py_compile server.py
```

The 27-test API/security regression suite covers password-hash/session/CSRF/rate-limit behavior, same-origin and JSON checks, static-file restrictions, safe partial State JSON transfer, bounded-server configuration, payment QR persistence/backup recovery, legacy-file migration, dated results, leaderboard defaults, schedules, manual payment approval, BR scoring, variable-size and legacy CS rosters, room capacity/privacy, emoji edits, and registration removal.

## Privacy and event wording

Registration records contain player names/IDs, contact numbers and payment references. Restrict server and admin-passphrase access. Share room credentials only with the registered players who need them. Keep all event copy as student-organized and do not imply institute/Garena/Free Fire approval.
