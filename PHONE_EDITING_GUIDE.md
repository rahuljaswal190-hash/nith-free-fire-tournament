# How to control and edit the website from your phone

## What is live now in this preview

The preview uses `server.py`, so admin changes can go live immediately while the server is running:

- player registrations
- slot counts
- leaderboard entries
- room ID/password releases
- admin dashboard totals

Admin PIN default: `2026`

## Admin pages

- `admin.html` — approve registrations, enter final team scores, publish room details, and manage slots
- `admin-dashboard.html` — see total registrations, total players, expected amount, and reported paid amount
- `room-details.html` — public page where players see room ID/password after admin release

## Important deployment note

If you host only on GitHub Pages, the website becomes static. Static GitHub Pages cannot save registrations or publish admin changes live by itself.

For the same live admin behavior online, use one of these:

1. Host `server.py` on a Python-supported host.
2. Connect Google Sheets + Apps Script.
3. Connect Firebase or Supabase.

## GitHub Pages upload for static version

1. Open GitHub in Chrome or install the GitHub app.
2. Create a repository, for example `nith-free-fire-tournament`.
3. Upload all files.
4. Open **Settings → Pages**.
5. Choose **Deploy from branch → main → root**.

## Edit tournament details

Open `data.js` and edit:

```js
event: {
  name: "NIT Hamirpur Free Fire Tournament",
  dateText: "Date and time to be announced",
  supportChannel: "Official WhatsApp group/contact to be added",
  whatsappNumber: "919876543210",
  upiId: "yourupi@bank",
  adminPin: "2026"
}
```

## Battle Royale formats

- Each Battle Royale lobby has up to 12 numbered entries/teams (slots 1–12).
- Each lobby's BR session contains 3 matches in its selected one-hour window.

Solo fee is per player. Duo, Trio and Squad fee is per team.

## Clash Squad fees

Clash Squad now starts directly from ₹50.

Current Clash Squad tiers:

- ₹50
- ₹70
- ₹90
- ₹100

## Safety tips

- Do not share admin PIN publicly.
- Share room ID/password only after the room is ready.
- Keep payment and refund rules clear before accepting money.
- Ask for screen recording proof when suspicious gameplay is reported.


## Approval and slot status

1. Player submits the registration, chooses a lobby and one of the three match time windows.
2. The server reserves a slot number (1–12 for BR; Clash Squad uses its 2 team places) and shows it in the submission confirmation.
3. The player opens `/status-check.html`, selects the same lobby and enters the slot number. No registration ID or WhatsApp is needed on this page.
4. In `admin.html`, review the entry and press **Approve** or **Reject**. Approved entries appear on the public leaderboard automatically.

## Enter final scores

1. Unlock `admin.html` with the admin PIN.
2. Approve the teams first so they appear in the score table.
3. Find each team by **slot + team name** and enter its final combined score.
4. Press **Save All Scores**. The public leaderboard updates automatically.
5. BR score is the cumulative final score for all 3 matches in the assigned hour. CS score is the result score for its 1 match.

## Match windows

All times are IST; the event date will be announced separately.

- Slot 1: 9:00–10:00 PM — BR plays 3 matches; CS plays 1 match.
- Slot 2: 10:00–11:00 PM — BR plays 3 matches; CS plays 1 match.
- Slot 3: 11:00 PM–12:00 AM — BR plays 3 matches; CS plays 1 match.

The time-window selector is on both registration forms. The chosen time appears in admin and on the leaderboard.
