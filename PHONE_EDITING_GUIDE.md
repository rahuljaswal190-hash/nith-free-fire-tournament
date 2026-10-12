# Phone admin and Vercel deployment guide

The admin panel requires the live Python API. There is no default PIN or offline admin mode. Do not send the admin PIN, MongoDB URI, or session secret in chat.

## Deploy this project on Vercel

The repo is configured for Vercel static hosting plus one Python Function. Vercel serves `public/` as the website and sends `/api/*` to `api/dispatch.py`. Keep the project root at the repository root; do **not** set the Vercel root directory to `public/`.

### Before switching traffic

1. Make a complete, private backup of registrations, payment settings/QR, room data, lobby-fee overrides, and results. The Admin State JSON transfer is partial and is not a recovery backup.
2. If the previous live site already used MongoDB, connect Vercel to the same database and collection using a newly rotated credential, then verify the existing state. A credential from the earlier pasted snippet is compromised and must not be reused.
3. If the previous site used only local JSON, that private file is not automatically available to Vercel. Migrate the **complete** state into MongoDB using a trusted backup/migration method before cutover; this ZIP contains application code, not live registrations.

### Set Vercel environment variables

In Vercel Project Settings → Environment Variables, add the following privately for Production (and Preview if you need to test there):

- `MONGODB_URI` — required on Vercel. Without it, state reads and writes fail closed with HTTP 503; the function will not use ephemeral local files as a database.
- `TOURNAMENT_ADMIN_PIN` — use a long, unique passphrase, not a short four-digit value.
- `TOURNAMENT_SESSION_SECRET` — Vercel's signed admin cookies require a random secret at least 32 characters long. Generate one locally with `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`; add the result directly in Vercel, and do not paste it into source or chat.
- Optional `MONGODB_DATABASE` and `MONGODB_COLLECTION` — defaults are `nith_free_fire_db` and `tournament_state`.

Keep the MongoDB user least-privileged and configure provider network access for Vercel. Do not put secret values in `vercel.json`, the public folder, Git, or this guide. Redeploy after changing environment variables.

### Deploy and verify

1. Import/connect the repository in Vercel or deploy the repository root with the Vercel CLI. The checked-in `vercel.json` sets `public/` as static output and routes the API; no front-end build command is needed.
2. After deployment, open the homepage and test `/api/state`. If MongoDB is not configured or reachable, the API correctly returns 503 rather than silently storing data in temporary files.
3. Test one paid and one free registration, admin PIN sign-in, session restoration, a lobby fee change, registration refresh/approval, payment settings, room release, and result publishing.
4. If the previous host had local-only JSON, keep it intact until the complete migration and post-deploy checks are verified. Do not use the browser State JSON transfer as the migration source.

Vercel's serverless instances can scale independently. Admin sessions use signed 8-hour cookies so they work across instances. The lightweight API/IP rate limits are still process-local and are not a distributed rate-limiting service; enable available edge/bot protections for a public panel. The state is stored as one MongoDB document, so concurrent writes may race; keep backups and verify critical admin edits.

## Admin controls from your phone

1. Open `/admin.html`, enter the private PIN, and sign in. Do not store the PIN in the page source or in `public/data.js`.
2. **Set match timings:** set BR and CS start times independently, choose a duration of 1 or 2 hours, and a 0/1/2-hour gap. There are exactly three linked time slots per mode. Each BR slot has 3 matches; each CS slot has 1 match. Time choices are shown in IST.
3. **Set individual lobby fees:** in **Set entry fee for each lobby**, select BR or CS, format/team size, CS type where relevant, and time slot. Choose the specific lobby and set its fee to Free or ₹10–₹110 in ₹10 steps. Fees save to MongoDB-backed server state. New registrations use the updated fee; existing entries retain the amount already recorded. Free registrations do not require a payment reference.
4. **Publish payment details:** upload an optional payment QR and/or enter a payee name and UPI ID. Registrants see payment instructions for paid lobbies; free lobbies show that no payment is due.
5. **Verify and approve:** inspect the submitted UTR/reference manually, then approve or reject. There is no payment gateway or automatic payment verification; QR payment does not change a pending status by itself.
6. **View/retrieve registrations:** on `/admin.html`, scroll to **Registrations & approvals** and tap **Refresh registrations**. The table fetches current authenticated server data and shows roster/contact/payment references. Use **Approve** or **Reject** after review. The dashboard has a read-only registrations table and its own refresh button. ₹0 approved-entry cards do not mean there are no pending registrations.
7. **Correct names:** tap **Edit names** in a registration row. Update team/entry and player IGN names (emoji and symbols are supported); uncheck a teammate to remove them. Use **Remove** to delete a registration and free its lobby slot.
8. **Use the calendar and enter results:** select a month and tap any date, including an empty date, to inspect registration/results and set the match date. Approve entries first. For BR, enter kills and placement for all three matches; for CS, choose Win/Loss and enter round difference. Tap **Save Match Results** to archive that date.
9. **Release or remove room access:** choose the correct mode, format/team size, current fee and type, then enter a custom room ID/password and optional QR. Details remain hidden until the lobby is full unless **Force release** is selected. **Remove Saved Room Details** deletes only the selected lobby credentials, not registrations.

## Formats and fees

- Each BR or CS lobby has an independent fee from **Free (₹0) to ₹110 in ₹10 steps**. Changes apply to new registrations only; existing entries keep their saved fee.
- Battle Royale: Solo, Duo, Trio and Squad. Solo fee is per player; Duo/Trio/Squad fees are per team.
- Clash Squad: Normal and One Tap; Solo 1v1, Duo 2v2, Trio 3v3, Squad 4v4. CS fee is per registered side/team, regardless of team size.
- Free lobbies require no payment or UTR. Paid lobbies still need organizer verification before approval.
- Each BR room supports 12 entries/teams (slots 1–12); each CS room has two team places (slots 1–2).
- Each size/type/fee has one room per schedule slot. Legacy 4v4 room IDs remain supported; there is no five-session/five-match display.

## Backups, privacy, and legacy Render note

- Tournament state contains player IDs, contact numbers, payment references, room credentials, payment settings, and QR images. Keep complete backups encrypted/private. The browser State JSON transfer excludes registrations/payment settings and is not a recovery backup.
- Store the rotated MongoDB URI, admin PIN, and Vercel session secret only in Vercel's protected Environment settings; never in `server.py`, `vercel.json`, public files, Git, or chat.
- Vercel requires MongoDB for state. If the database is unavailable, writes return an error and do not fall back to temporary local files. Verify the admin storage message says MongoDB is connected.
- Admin authentication uses environment-only secrets, short-lived signed sessions on Vercel, HttpOnly/SameSite/Secure cookies, CSRF checks, and same-origin API writes. Rate limits are process-local; sign out on shared devices and enable available Vercel edge protections.
- The repository's `render.yaml` is retained only as a separate legacy configuration and remains on Render Free. It is not used by Vercel; no Render plan or disk change is part of this update.
- Only released room credentials and intended public tournament/payment/leaderboard information are visible to visitors. Pending registration contact/payment details require an admin session.
- Keep the event described as student-organized. Do not imply NIT Hamirpur, Garena, or Free Fire approval or endorsement.
