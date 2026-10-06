# NIT Hamirpur Free Fire Tournament Website

A multi-page, mobile-first website for a student-organized Free Fire tournament around NIT Hamirpur.

## Pages included

- `index.html` — homepage and live availability overview
- `clash-squad.html` — Clash Squad registration with Normal and One Tap options
- `battle-royale.html` — Battle Royale registration with Solo, Duo, Trio and Squad sections
- `rules.html` — NIT Hamirpur tournament rulebook
- `leaderboard.html` — automatic approved-team standings and final scores
- `status-check.html` — approval checker using lobby + slot number only
- `room-details.html` — room ID/password page released by admin
- `schedule-results.html` — schedule, check-in flow, and result verification flow
- `admin.html` — admin controls for slots, leaderboard, and room details
- `admin-dashboard.html` — admin-only dashboard for registrations, players, and payment totals
- `server.py` — live preview/backend server for registrations and admin updates
- `data.js` — tournament configuration
- `site.js` — interactivity and API logic
- `styles.css` — design/theme

## Key tournament setup

- Battle Royale fee tiers: ₹20, ₹40, ₹60, ₹80, ₹100
- Clash Squad fee tiers: ₹50, ₹70, ₹90, ₹100
- Battle Royale Solo, Duo, Trio and Squad: up to 12 entries/teams per lobby (slots 1–12), 3 matches in the selected one-hour window
- Clash Squad: 2 teams per room, 1 match, winner rewarded
- Clash Squad types: Normal and One Tap
- Custom rooms per fee tier: 5
- Registration asks for team/entry name, IGL/player name and ID, WhatsApp, teammate names and IDs, selected lobby, match time window, and payment reference

## Live admin mode

Run:

```bash
python3 server.py
```

Then open the site. Admin PIN default is `2026`.

The live server enables:

- registrations saved centrally in `server-data.json`
- admin dashboard totals
- live reserved slot counts and approval statuses
- approve or reject registrations in the admin page
- live leaderboard publishing
- live room ID/password publishing
- public approval checks by lobby + slot number
- automatic approved-team leaderboard and bulk final-score saving

## Static hosting note

GitHub Pages alone cannot make admin changes instantly visible unless you connect a backend. For real deployment, use this `server.py` on a hosting service, or connect Google Sheets, Firebase, or Supabase.

## Disclaimer

This is a student-organized tournament portal. It is not affiliated with, endorsed by, or sponsored by Garena or Free Fire. Use institute-official wording only after proper permission.

## Slot status, public standings, and scores

- Public status page: `status-check.html`.
- Players select the same lobby they chose at registration and enter the reserved slot number (1–12). No registration ID or WhatsApp input is used on this page.
- The server assigns/reserves a slot when registration is submitted, so Pending, Approved, and Rejected statuses can be checked by lobby + slot.
- Admin approval automatically adds the entry to the public leaderboard with its team/entry name, slot, roster IGNs, format, lobby, and match time. Player IDs and WhatsApp are not displayed publicly.
- Admin page has a bulk final-score table. Enter each approved team's final combined score and press **Save All Scores**; the public leaderboard sorts by score and refreshes live.

## Match timings

All times below are India Standard Time (IST). The event date is still to be announced.

| Time slot | Time | Battle Royale | Clash Squad |
|---|---|---|---|
| Slot 1 | 9:00–10:00 PM | 3 matches in the hour | 1 match in the hour |
| Slot 2 | 10:00–11:00 PM | 3 matches in the hour | 1 match in the hour |
| Slot 3 | 11:00 PM–12:00 AM (midnight) | 3 matches in the hour | 1 match in the hour |

Players select one of the three time windows on the registration form.

## Admin scoring workflow

1. Open `admin.html` and unlock using your private Render `TOURNAMENT_ADMIN_PIN`.
2. Review each registration and press **Approve** or **Reject**.
3. Approved teams appear in the **Enter final scores** table, grouped by lobby and slot.
4. After matches, enter the final score for each approved team and press **Save All Scores**.
5. The public `leaderboard.html` updates automatically. BR final score is the cumulative score for the 3 matches; CS final score is the score/result for its 1 match.
