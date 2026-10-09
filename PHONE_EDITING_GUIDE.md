# Phone admin and deployment guide — Variable CS & date controls

The secured admin panel requires the live Python backend; there is no default password and no offline admin mode. A static GitHub Pages copy alone cannot save shared registrations or admin changes. Do not send passwords, password hashes, or environment-variable values in chat.

## Replace/deploy the update

1. Before deploying, preserve a complete server-state backup using a trusted host/backend method. The Admin State JSON import/export is only a partial local transfer and omits registrations and payment settings; it is not a recovery backup. Render Free redeploys/spin-downs may clear app-local JSON data. This update does not change the plan or add paid storage; if no complete backup exists, do not assume the browser export can recover the live state.
2. Download and extract the latest complete update ZIP. Replace the previous website files with the complete extracted set; do not mix old `site.js`, `data.js`, `server.py`, or HTML files with the new ones.
3. On a trusted computer, run `python3 generate_admin_hash.py`. It prompts for a unique passphrase (minimum 16 characters) without echoing it and outputs a salted PBKDF2-SHA256 verifier. Do not paste the plaintext passphrase or verifier into this chat or source files.
4. In Render → existing service → **Environment**, add `TOURNAMENT_ADMIN_PASSWORD_HASH` with the generated verifier. The new code ignores the old `TOURNAMENT_ADMIN_PIN`; remove that old variable after confirming the new sign-in works. Set the environment variable before deploying, or admin sign-in will remain disabled.
5. Deploy to the existing service only after preserving needed records. Open `/admin.html`, sign in with the passphrase, and test before sharing the site. Render Free has no Shell or persistent disk; a configured JSON path alone does not make data durable.

## Admin controls from your phone

1. **Set match timings:** set BR and CS start times independently, choose a duration of 1 or 2 hours, and a 0/1/2-hour gap. There are exactly three linked time slots per mode. Each BR slot has 3 matches; each CS slot has 1 match. Time choices are shown in IST.
2. **Publish payment details:** upload an optional payment QR and/or enter a payee name and UPI ID. Registrants will see the amount, instructions, QR, and a generated UPI link when available.
3. **Verify and approve:** inspect the submitted UTR/reference manually and then approve or reject. There is no payment gateway or automatic payment verification; QR payment does not change the pending status by itself.
4. **Correct names:** tap **Edit names** in the registration row. Update team/entry and player names (emoji and symbols are supported); uncheck a teammate to remove them. Use **Remove** to delete a whole registration and free its lobby slot.
5. **Use the calendar and enter results:** click any calendar date (including an empty date) to inspect registration/result states and set the match date below. Approve entries first. For every BR entry, enter kills and placement for all three matches; for CS, choose Win/Loss and enter round difference. Tap **Save Match Results** to archive that date.
6. **Release or remove room access:** choose the correct mode, format/team size, fee and type, then enter a custom room ID/password and optional QR. Details remain hidden until the lobby is full unless you check Force release. **Remove Saved Room Details** deletes the selected lobby credentials without deleting registrations.

## Current formats and fees

- Battle Royale: Solo, Duo, Trio and Squad; ₹20/₹40/₹60/₹80/₹100. Solo fee is per player; other BR fees are per team.
- Clash Squad: Normal and One Tap; Solo (1v1), Duo (2v2), Trio (3v3), Squad (4v4); ₹50/₹70/₹90/₹110 per registered side/team, regardless of team size.
- Each BR room supports 12 entries/teams (slots 1–12); each CS room has two team places (slots 1–2).
- Each size/type/fee has one room per schedule slot. CS has separate size-specific rooms; legacy 4v4 room IDs remain supported. There is no five-session/five-match display.
- Public leaderboard visitors can choose a date; dates without results display a clear unavailable state. Admins can set results for historical dates without overwriting newer dates.

## Backups and security

- `server-data.json` contains player IDs, contact numbers, payment references, admin-only room details, payment settings, and QR images. Keep full backups encrypted/private and avoid posting the file in public channels. Payment settings remain until changed/removed only while the underlying state storage survives.
- The Admin State JSON import/export is partial: it excludes registrations and payment settings. Do not use it to recover the server or paste/commit exported data into `data.js`.
- Admin authentication now uses PBKDF2-SHA256 password verification, short-lived server-side sessions, HttpOnly/SameSite cookies, CSRF checks, same-origin API writes, login/API rate limits, and security headers. Sign out on shared devices.
- Only released room credentials and intended public tournament/leaderboard/payment information are visible to visitors. Pending registration contact/payment details require an admin session.
- Render Free storage is ephemeral and has no Shell or persistent disk. For long-term persistence while staying Free, the app needs an external durable database/store and regular off-host backups; this ZIP does not silently upgrade or attach paid storage.
- Keep the event described as student-organized. Do not imply NIT Hamirpur, Garena, or Free Fire approval or endorsement.
