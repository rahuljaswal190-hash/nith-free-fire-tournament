# NIT Hamirpur Free Fire Tournament — Dated Results & Durable Storage Update

A mobile-first website for a **student-organized** Free Fire tournament around NIT Hamirpur. The site does not claim institute, Garena, or Free Fire approval or endorsement.

## What’s included

- `index.html` — event overview and live availability
- `battle-royale.html` — Solo, Duo, Trio, Squad registrations and BR sessions
- `clash-squad.html` — Normal and One Tap CS registrations
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
- Three time-linked slots are available for each mode. A fee tier has **3 rooms**, one for each slot; there is no five-room/five-match schedule.
- BR has Solo, Duo, Trio and Squad formats. Each BR room holds up to **12 entries/teams** (slots 1–12) and plays **3 matches** in its assigned session.
- CS has Normal and One Tap types. Each CS room holds **2 teams** and plays **1 match**; the winner earns 3 leaderboard points.
- Solo BR entry fee is per player. Duo, Trio, Squad and CS fees are per team.

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

Set a private admin PIN in the host environment as `TOURNAMENT_ADMIN_PIN` before inviting players. Do not publish the PIN. If unset, the fallback PIN is `2026`.

## Important: persistent storage on Render

The included `render.yaml` **intentionally remains on Render’s Free plan**; it does not silently opt you into a paid instance or configure a disk. Render Free local files are not a durable storage guarantee. Until you explicitly attach a persistent volume and set its path, the admin panel will warn that storage is not persistent.

For durable payment settings, QR images, registrations and match history on Render:

1. In Render, upgrade the existing web service to a plan that supports persistent disks. Persistent disks are a paid hosting feature; check the current price shown in your Render dashboard before confirming. This project does not upgrade or add that paid resource automatically.
2. Add a persistent disk to the **existing** web service, with mount path **`/var/data`** (1 GB is sufficient to start for this JSON-backed site).
3. In the service’s environment settings, set **`TOURNAMENT_DATA_DIR=/var/data`**. It is intentionally not set by the Free-plan Blueprint.
4. Redeploy and open `admin.html`. The storage status should say **“Mounted volume detected”**. The startup log also prints the active state-file path, expected as `/var/data/server-data.json`.
5. Keep the same service and disk when replacing site files. Back up `server-data.json` and `server-data.json.bak` to a separate location periodically.

If you keep the service on Free without an attached persistent disk, the app can still run, but local JSON state may disappear on a restart or redeploy. Merely changing the JSON/backup code cannot make an ephemeral host durable. If the previous deployment has already deleted its only copy, this ZIP cannot recover that lost file; restore from any server backup or export you retained. On first startup with the new volume, the app will migrate the old app-directory JSON if it still exists.

For other hosts, point `TOURNAMENT_DATA_DIR` at the host’s persistent mounted storage and confirm the admin panel detects it. A configured folder alone is not a guarantee if the host does not persist it.

## Admin workflow

1. Open `admin.html`, enter the server’s admin PIN, and unlock the controls.
2. **Set match timings:** BR and CS each have their own start time, session duration (1 or 2 hours), and inter-slot gap (0, 1, or 2 hours). Times use IST. The three room suffixes map to Slot 1, Slot 2, and Slot 3.
3. **Publish payment details:** upload an optional PNG/JPG/WebP payment QR (maximum 1 MB), enter an optional payee name and/or UPI ID, and add instructions. Payment details remain in server state until an admin changes or removes them. Their survival across host restarts still depends on the persistent-storage setup above.
4. **Verify a registration:** review the submitted UTR/reference and manually confirm payment. QR/UPI instructions do **not** provide automatic payment verification; entries stay pending until the organizer approves them.
5. **Edit or remove registrations:** “Edit names” lets the admin correct the entry/team and roster IGN names, including emoji and symbol names. Teammates can be removed from the roster. “Remove” deletes the registration and releases its slot.
6. **Use the registration calendar:** choose a month and click a day with registrations to inspect that day’s entries. Dates and counts use India Standard Time.
7. **Publish dated results:** choose a match date, then enter BR kills and placement (1–12) for each of the 3 matches or CS Win/Loss and round difference. Results are archived by date. Re-saving a past date updates only that date and does not replace a newer match result. BR points are kills plus the placement points in `data.js`; CS wins = 3 points, losses = 0.
8. **Choose the public default:** select either the latest saved match date or all-time cumulative standings. Players can still choose a particular saved date (including earlier dates) on the public leaderboard.
9. **Read save confirmations:** successful admin actions show a compact auto-dismiss toast for about 2.5 seconds. Failed saves show an error toast and do not show a success confirmation.

All-time BR totals add the saved date totals; the match cells show the most recent saved session. All-time CS totals add win points and use combined round difference as a tiebreaker. Public leaderboard history contains roster names/results, not player IDs, WhatsApp numbers or payment references.

## Registration and capacity notes

- BR lobby slots are numbered 1–12 for every BR format; CS lobby slots are 1–2. A submitted registration reserves a slot immediately, while admin approval is tracked separately.
- The selected lobby suffix is the time slot. Changing the schedule does not create extra rooms or matches; it only changes the displayed time for the three existing slots.
- The BR fee, CS fee, match counts, and placement table are configured in `data.js`.

## Deployment / replacing an older version

1. Extract the complete updated ZIP.
2. Replace the previous site files with the extracted files as one set; do not keep an old `data.js`, `site.js`, `server.py`, page HTML, or `styles.css` alongside the new files.
3. Keep the existing Render Free service unchanged unless you explicitly choose to upgrade. For durable data, follow the paid-disk steps above; do not collect real registrations until the admin status reports a mounted persistent volume.
4. Set `TOURNAMENT_ADMIN_PIN` to a new private value and start with `python server.py` (or use the included Render configuration).
5. After deployment, test the public registration, status check, admin approval, payment instructions, date selection, dated result publishing, calendar and storage-status message.
6. Static hosting such as GitHub Pages alone does not provide shared, durable registration/admin storage. Use the included Python backend for shared live behavior.

## Files changed in this update

- `server.py` — configurable durable data path, atomic backup/restore, legacy migration, dated match archive/API, public view setting, and storage-status reporting
- `site.js` — date-aware leaderboard, historical result entry, registration calendar, compact success toasts, and local archive handling
- `admin.html` — storage warning, registration calendar, match-date field, and leaderboard-default control; removed the full-screen admin success dialog
- `leaderboard.html` — public match-date, latest, and all-time controls
- `styles.css` — calendar, date filter, storage-status, and toast styling
- `render.yaml` — explicitly documents the existing Free/ephemeral setup; no paid plan or disk is enabled
- `.gitignore` — excludes JSON state and its backup/temp files
- `tests/test_server_api.py` — regression coverage for persistence, archives, settings and migration
- `README.md` — deployment, storage and feature documentation

## Tests

Run the included backend regression tests and syntax checks with:

```bash
python3 -m unittest discover -s tests -v
node --check site.js
node --check data.js
python3 -m py_compile server.py
```

The API regression suite covers payment QR persistence/backup recovery, legacy-file migration to a configured data directory, dated result archives and backfills, leaderboard defaults, schedules, manual payment approval, BR scoring, CS results, room-QR privacy/release, emoji edits, registration removal and lobby capacity.

## Privacy and event wording

Registration records contain player names/IDs, contact numbers and payment references. Restrict server and admin-PIN access. Share room credentials only with the registered players who need them. Keep all event copy as student-organized and do not imply institute/Garena/Free Fire approval.
