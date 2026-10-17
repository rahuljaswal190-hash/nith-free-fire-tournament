"""Single Vercel Python Function that dispatches the existing tournament API."""
import os
from pathlib import Path
import sys
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE if (HERE / "server.py").is_file() else HERE.parent
for candidate in (str(PROJECT_ROOT), str(HERE)):
    if candidate not in sys.path:
        sys.path.insert(0, candidate)

import server  # noqa: E402

if not os.path.isdir(server.PUBLIC_DIR):
    server.PUBLIC_DIR = str(PROJECT_ROOT)

ROUTE_QUERY_KEY = "__nith_vercel_path"
API_PATHS = frozenset({
    "/api/state",
    "/api/admin/session",
    "/api/admin/login",
    "/api/admin/logout",
    "/api/register",
    "/api/check-status",
    "/api/admin/summary",
    "/api/admin/registration-status",
    "/api/admin/assign-slot",
    "/api/admin/edit-registration",
    "/api/admin/delete-registration",
    "/api/admin/clear-registrations",
    "/api/admin/room-count",
    "/api/admin/lobby-fee",
    "/api/admin/schedule-settings",
    "/api/admin/payment-settings",
    "/api/admin/leaderboard-settings",
    "/api/admin/match-results",
    "/api/admin/delete-match-result",
    "/api/admin/room-details",
    "/api/admin/delete-room-details",
})


def dispatch_target(request_target):
    """Recover the original API path from Vercel's internal rewrite query or direct API path."""
    try:
        parsed = urlsplit(str(request_target or ""))
        query = parse_qsl(parsed.query, keep_blank_values=True, max_num_fields=256)
    except (ValueError, TypeError):
        return None
    route_values = [unquote(value) for key, value in query if key == ROUTE_QUERY_KEY]
    if len(route_values) > 1:
        return None
    if len(route_values) == 1:
        candidate = route_values[0]
        if candidate not in API_PATHS:
            return None
        subpath = candidate[len("/api/"):]
        remaining = [
            (key, value)
            for key, value in query
            if key != ROUTE_QUERY_KEY and not (key == "path" and value == subpath)
        ]
        clean_query = urlencode(remaining, doseq=True)
        return urlunsplit(("", "", candidate, clean_query, ""))
    if parsed.path in API_PATHS:
        clean_query = urlencode(query, doseq=True)
        return urlunsplit(("", "", parsed.path, clean_query, ""))
    return None


class handler(server.Handler):
    """Vercel's supported BaseHTTPRequestHandler-compatible function handler."""

    def setup(self):
        # Vercel controls invocation timeouts; avoid applying TCP socket timeouts there.
        if server.VERCEL_RUNTIME:
            super(server.Handler, self).setup()
        else:
            super().setup()

    def _restore_api_path(self):
        target = dispatch_target(self.path)
        if target is None:
            self.send_json({"ok": False, "error": "Not found"}, 404)
            return False
        self.path = target
        return True

    def do_GET(self):
        if self._restore_api_path():
            super().do_GET()

    def do_POST(self):
        if self._restore_api_path():
            super().do_POST()

    def do_OPTIONS(self):
        if self._restore_api_path():
            super().do_OPTIONS()

    def do_HEAD(self):
        if self._restore_api_path():
            super().do_HEAD()
