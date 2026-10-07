# Phone admin and deployment guide — Final 2.0

The admin panel works with the live Python backend. Default PIN: `2026`; set a private `TOURNAMENT_ADMIN_PIN` before deployment and do not share it. A static GitHub Pages copy alone cannot save shared registrations or admin changes.

## Replace/deploy the update

1. Download and extract the **final 2.0 updates** ZIP.
2. Replace the previous website files with the complete extracted set. Do not mix old `site.js`, `data.js`, `server.py`, or HTML files with the new ones.
3. Deploy the folder to a Python-capable host (the included `render.yaml` is configured for Render). Use `python server.py` as the start command.
4. Set `TOURNAMENT_ADMIN_PIN` to a private value. Enable persistent storage for `server-data.json` so registrations, settings and QR images survive restarts.
5. Open `/admin.html`, enter the PIN, and test the controls before sharing the site.

## Admin controls from your phone

1. **Set match timings:** set BR and CS start times independently, choose a duration of 1 or 2 hours, and a 0/1/2-hour gap. There are exactly three linked time slots per mode. Each BR slot has 3 matches; each CS slot has 1 match. Time choices are shown in IST.
2. **Publish payment details:** upload an optional payment QR and/or enter a payee name and UPI ID. Registrants will see the amount, instructions, QR, and a generated UPI link when available.
3. **Verify and approve:** inspect the submitted UTR/reference manually and then approve or reject. There is no payment gateway or automatic payment verification; QR payment does not change the pending status by itself.
4. **Correct names:** tap **Edit names** in the registration row. Update team/entry and player names (emoji and symbols are supported); uncheck a teammate to remove them. Use **Remove** to delete a whole registration and free its lobby slot.
5. **Enter results:** approve entries first. For every BR team, enter kills and placement for each of its three matches; points calculate from `data.js` automatically. For CS, choose Win/Loss and enter round difference. Tap **Save Match Results** to publish match scores, last-match score and cumulative standings.
6. **Release room access:** enter a custom room ID and password, optionally upload a room QR, then publish. The details remain hidden until the lobby is full unless you check Force release.

## Current formats and fees

- Battle Royale: Solo, Duo, Trio and Squad; ₹20/₹40/₹60/₹80/₹100. Solo fee is per player; other BR fees are per team.
- Clash Squad: Normal and One Tap; ₹50/₹70/₹90/₹110 per team.
- Each BR room supports 12 entries/teams (slots 1–12); each CS room has two team places (slots 1–2).
- There are three rooms per fee tier, one for each of the three schedule slots. There is no five-session/five-match display.

## Backups and security

- Use the host’s persistent storage for `server-data.json`; it includes registrations, payment references, private room details and QR images.
- Back up the data file securely and limit access to the PIN.
- Keep the event described as student-organized. Do not imply NIT Hamirpur, Garena, or Free Fire approval or endorsement.
