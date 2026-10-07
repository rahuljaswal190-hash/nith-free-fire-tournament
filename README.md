# NIT Hamirpur Free Fire Tournament — Final 2.0 Updates

A mobile-first website for a **student-organized** Free Fire tournament around NIT Hamirpur. The site does not claim institute, Garena, or Free Fire approval or endorsement.

## What’s included

- `index.html` — event overview and live availability
- `battle-royale.html` — Solo, Duo, Trio, Squad registrations and BR sessions
- `clash-squad.html` — Normal and One Tap CS registrations
- `schedule-results.html` — separate BR/CS slot schedules and event flow
- `leaderboard.html` — approved teams, BR match-by-match scores, last-match score and cumulative standings; CS results and round-difference tiebreaks
- `status-check.html` — registration status by selected room and assigned slot
- `room-details.html` — released custom-room ID/password and optional room QR
- `admin.html` — schedule, registration, payment, room and scoring controls
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

Open `http://localhost:8000`. On deployment, the server binds to `0.0.0.0` and uses the host-provided `PORT` environment variable if set.

The default admin PIN is `2026`. Set a private value in the host’s environment as `TOURNAMENT_ADMIN_PIN` before inviting players. Do not publish the PIN.

The live server stores registrations and admin configuration in `server-data.json` beside `server.py`. Use a host with persistent storage for that file, or ensure its storage survives redeployments. Back up this file regularly; it includes registration contact/payment-reference information and QR images.

## Admin workflow

1. Open `admin.html`, enter the server’s admin PIN, and unlock the controls.
2. **Set match timings:** BR and CS each have their own start time, session duration (1 or 2 hours), and inter-slot gap (0, 1, or 2 hours). Times use IST. The three room suffixes map to Slot 1, Slot 2, and Slot 3, so the room selector, registration time selector, schedule page and status/leaderboard times stay aligned.
3. **Publish payment details:** upload an optional PNG/JPG/WebP payment QR (maximum 1 MB), enter an optional payee name and/or UPI ID, and add any payment instructions. A fee-specific UPI payment link is generated for registrants when a UPI ID is published.
4. **Verify a registration:** review the submitted UTR/reference and manually confirm the payment. QR/UPI instructions do **not** provide automatic payment verification; entries stay pending until the organizer approves them.
5. **Edit or remove registrations:** “Edit names” lets the admin correct the team/entry and roster IGN names, including emoji and symbol names. Teammates can be removed from the roster. “Remove” deletes the registration and releases its slot.
6. **Publish room access:** choose the website lobby, enter its custom room ID/password, and optionally upload a room QR. Details are hidden until the room is full (12 BR entries or 2 CS teams) unless “Force release” is selected.
7. **Publish results:** BR result inputs ask for kills and placement (1–12) for each of the 3 matches. The server calculates each match’s points as kills plus the placement points in `data.js`, then calculates cumulative points and publishes each match and the latest scored match. CS records Win/Loss and round difference (wins = 3 points, losses = 0); round difference breaks ties.

The leaderboard only includes approved registrations. Player IDs and WhatsApp numbers are not displayed publicly.

## Registration and capacity notes

- BR lobby slots are numbered 1–12 for every BR format; CS lobby slots are 1–2. A submitted registration reserves a slot immediately, while admin approval is tracked separately.
- The selected lobby suffix is the time slot. Changing the schedule does not create extra rooms or matches; it only changes the displayed start/end time for the three existing slots.
- The BR fee, CS fee, match counts, and placement table are configured in `data.js`.

## Deployment / replacing an older version

1. Extract the complete `final 2.0 updates` ZIP.
2. Replace the previous site files with the extracted files as one set; do not keep the old `data.js`, `site.js`, `server.py`, or page HTML alongside the new files.
3. Deploy the folder to a Python-capable web host using `python server.py` as the start command (or the included Render configuration). Set `TOURNAMENT_ADMIN_PIN` to a new private PIN.
4. Configure persistent disk/storage for `server-data.json` before collecting real registrations. Test the public registration, status check, admin approval, and leaderboard after deployment.
5. If using static hosting such as GitHub Pages only, the public pages can display the bundled static content, but registrations/admin changes will not be shared or saved centrally. Use the included backend for live behavior.

## Tests

Run the included backend regression tests with:

```bash
python3 -m unittest discover -s tests -v
node --check site.js
node --check data.js
python3 -m py_compile server.py
```

The API tests cover independent BR/CS schedules, schedule-to-room mapping, UTR-pending behavior, admin PIN enforcement, BR point calculation and last-match scores, CS winner/round-difference results, QR privacy/release, emoji name edits, removal/slot freeing, and lobby capacity.

## Privacy and event wording

Registration records contain player names/IDs, contact numbers and payment references. Restrict server access and admin PIN access. Share room credentials only with the registered players who need them. Keep all event copy as student-organized and do not imply institute/Garena/Free Fire approval.
