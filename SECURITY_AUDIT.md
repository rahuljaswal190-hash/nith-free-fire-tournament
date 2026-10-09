# Security hardening notes

**Scope:** source-level review and changes in this workspace. This is not a production penetration test or a guarantee of security.

## What was changed

- **Admin credential exposure:** removed the browser-side/default admin PIN flow. Treat the previously exposed PIN as compromised; never reuse it. Admin sign-in now checks a salted PBKDF2-HMAC-SHA256 verifier (`600,000` iterations) from `TOURNAMENT_ADMIN_PASSWORD_HASH`. The generator prompts without echoing the passphrase. Use a unique passphrase of at least 16 characters. If the environment variable is absent or invalid, sign-in fails closed.
- **Admin sessions:** successful sign-in creates a random, server-side session with an 8-hour lifetime. The browser receives an `HttpOnly`, `SameSite=Strict` cookie, marked `Secure` for HTTPS, plus a CSRF token required for admin writes. Sign-out invalidates the session.
- **Request protections:** added same-origin checks, JSON content-type/object checks, a 2 MB request-body limit, input validation and server-derived registration fields. Login and API routes have per-IP/in-process rate limits. Client sockets time out after 15 seconds and production request threads are bounded.
- **Static-file exposure:** the server now serves an explicit list of public site assets rather than arbitrary project files. Source, configuration, documentation, tests, runtime JSON, and backup files are not served as static assets.
- **Browser protections:** responses include a Content Security Policy, frame/content-type/referrer/permissions/cross-origin protections, and HTTPS HSTS when the request is identified as HTTPS. No CORS access is enabled.
- **State-file handling:** JSON writes are atomic, keep a previous valid backup, and request owner-only file permissions where supported. The JSON still contains personal/contact/payment-reference data and admin-only room credentials; restrictive permissions are not encryption. The browser Admin State JSON transfer was clarified as partial, excludes room credentials, registrations, and payment settings, and must not be used as a server recovery backup.
- **Secret hygiene:** the current source scan found no API-key/private-key or production credential assignments. There is no `.env` file in the workspace. The test suite contains a dummy test-only passphrase. Git metadata/history and remote repository contents were not available to scan.
- **Dependencies:** the app uses Python’s standard library and has no third-party Python or JavaScript dependencies to update.

## Verification performed

- `python3 -m unittest discover -s tests -v` — **27 tests passed**. Tests cover admin login/session/CSRF/rate limiting, origin/content-type checks, static-file restrictions, registration validation, payment/room privacy, safe partial State JSON transfer, bounded-server configuration, and existing tournament behavior.
- `python3 -m py_compile server.py generate_admin_hash.py tests/test_server_api.py` — passed.
- `node --check site.js` and `node --check data.js` — passed.
- HTML scan found no inline script blocks, consistent with the response CSP.

These checks validate the local code paths exercised by the suite; they do not validate Render’s live environment, TLS/proxy configuration, backups, or every browser/device.

## Important remaining risks and deployment limits

1. **Set a new live admin verifier before deploying.** On a trusted computer run `python3 generate_admin_hash.py`, then set the printed verifier as `TOURNAMENT_ADMIN_PASSWORD_HASH` in the existing Render service’s Environment settings. Do not paste the password or verifier into chat, source control, or a public document. The new code ignores `TOURNAMENT_ADMIN_PIN`; remove the old variable after the new sign-in is verified. Until the new hash is configured, admin sign-in is disabled.
2. **Back up live state before deploying.** No Render deployment or environment change was made. This workspace cannot access the live service’s environment, files, logs, or backup. Render Free local storage is ephemeral; a redeploy/restart can lose JSON state. Setting `TOURNAMENT_DATA_DIR` alone does not make it durable. The app remains on Render Free and no paid disk or plan change was made. For durable operation while staying Free, this app still needs an external durable data store and migration work; that has not been implemented here.
3. **Payment settings and QR images live in the same JSON state.** They remain until an admin changes/removes them only while that state file survives. Do not treat an app-local backup as off-host disaster recovery. Keep a private, encrypted off-host backup and test recovery.
4. **Data at rest is not encrypted by this app.** The state file includes personal information and payment references. File permissions reduce exposure on supported local filesystems but do not encrypt it. A managed database with appropriate access controls/encryption and backups is preferable for durable production data.
5. **Rate limits and sessions are process-local.** They reset on restart and are not shared across multiple instances. They are lightweight safeguards, not a WAF or identity provider. There is one shared admin passphrase and no MFA or per-admin audit identity.
6. **History and production checks remain unavailable.** The local workspace had no `.git` metadata, so removed credentials cannot be checked or purged from prior commits. No live Render environment values, production source, or current service state could be inspected. If the old PIN or any other secret was committed or reused, rotate it and review repository access/history.

## Safe rollout checklist

- Before any restart/redeploy, obtain a complete private backup of live registrations and payment settings using a trusted host/backend method. The browser Admin State JSON export is incomplete and cannot supply this backup; if a full copy is unavailable, do not assume the update can recover it.
- Confirm the service remains on the existing Free plan; do not rely on local JSON for durable records.
- Generate a fresh unique passphrase and set `TOURNAMENT_ADMIN_PASSWORD_HASH` in the existing service environment before deploying.
- Deploy the complete updated source set together; do not mix old `data.js`, `site.js`, HTML, or `server.py` with new files.
- Verify public registration/status, payment instructions, admin sign-in/sign-out, approval, and result publishing. Confirm the storage warning is understood; a custom JSON path is not proof of durable storage.
- Remove the obsolete PIN environment variable only after confirming the new admin login works. Never send secrets through chat or commit them.
