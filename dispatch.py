"""Single Vercel Python Function that dispatches the existing tournament API."""
from pathlib import Path
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import server  # noqa: E402

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
    "/api/admin/edit-registration",
    "/api/admin/delete-registration",
    "/api/admin/clear-registrations",
    "/api/admin/room-count",
    "/api/admin/lobby-fee",
    "/api/admin/schedule-settings",
    "/api/admin/payment-settings",
    "/api/admin/leaderboard-settings",
    "/api/admin/match-results",
    "/api/admin/room-details",
    "/api/admin/delete-room-details",
})


def dispatch_target(request_target):
    """Recover the original API path from Vercel's internal rewrite query."""
    try:
        parsed = urlsplit(str(request_target or ""))
        query = parse_qsl(parsed.query, keep_blank_values=True, max_num_fields=256)
    except (ValueError, TypeError):
        return None
    route_values = [value for key, value in query if key == ROUTE_QUERY_KEY]
    if len(route_values) != 1 or route_values[0] not in API_PATHS:
        return None
    remaining = [(key, value) for key, value in query if key != ROUTE_QUERY_KEY]
    clean_query = urlencode(remaining, doseq=True)
    return urlunsplit(("", "", route_values[0], clean_query, ""))


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
