#!/usr/bin/env python3
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(ROOT, "server-data.json")
ADMIN_PIN = os.environ.get("TOURNAMENT_ADMIN_PIN", "2026")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def default_state():
    return {
        "registrations": [],
        "roomOverrides": {},
        "roomDetails": {},
        "leaderboard": {"br": [], "cs": []},
        "notices": [],
        "updatedAt": now_iso(),
    }


def load_state():
    if not os.path.exists(DATA_FILE):
        return default_state()
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            state = json.load(f)
    except Exception:
        state = default_state()
    base = default_state()
    base.update(state if isinstance(state, dict) else {})
    base["leaderboard"] = {
        "br": list(base.get("leaderboard", {}).get("br", [])),
        "cs": list(base.get("leaderboard", {}).get("cs", [])),
    }
    base["registrations"] = list(base.get("registrations", []))
    base["roomOverrides"] = dict(base.get("roomOverrides", {}))
    base["roomDetails"] = dict(base.get("roomDetails", {}))
    base["notices"] = list(base.get("notices", []))
    return base


def save_state(state):
    state["updatedAt"] = now_iso()
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
    os.replace(tmp, DATA_FILE)


def is_approved(reg):
    return str(reg.get("status") or "").lower() == "approved"


def registration_counts(registrations):
    counts = {}
    for reg in registrations:
        if not is_approved(reg):
            continue
        room_id = reg.get("roomId")
        if room_id:
            counts[room_id] = counts.get(room_id, 0) + 1
    return counts


def payment_is_reported(payment_ref):
    text = str(payment_ref or "").strip().lower()
    if not text:
        return False
    pending_words = ["pay after", "after confirmation", "pending", "later", "not paid"]
    return not any(word in text for word in pending_words)


def public_state(state):
    return {
        "roomOverrides": state.get("roomOverrides", {}),
        "registrationCounts": registration_counts(state.get("registrations", [])),
        "roomDetails": state.get("roomDetails", {}),
        "leaderboard": state.get("leaderboard", {"br": [], "cs": []}),
        "notices": state.get("notices", []),
        "updatedAt": state.get("updatedAt"),
    }


def admin_summary(state):
    regs = state.get("registrations", [])
    approved = [r for r in regs if is_approved(r)]
    pending = [r for r in regs if str(r.get("status") or "").lower() in ("", "pending admin approval", "pending")]
    rejected = [r for r in regs if str(r.get("status") or "").lower() == "rejected"]
    total_players = sum(int(r.get("playersPerEntry") or len(r.get("players", [])) or 0) for r in regs)
    approved_players = sum(int(r.get("playersPerEntry") or len(r.get("players", [])) or 0) for r in approved)
    expected_amount = sum(int(float(r.get("fee") or 0)) for r in regs)
    approved_expected_amount = sum(int(float(r.get("fee") or 0)) for r in approved)
    reported_paid = sum(int(float(r.get("fee") or 0)) for r in regs if payment_is_reported(r.get("paymentRef")))
    approved_reported_paid = sum(int(float(r.get("fee") or 0)) for r in approved if payment_is_reported(r.get("paymentRef")))
    by_mode = {}
    for r in regs:
        key = r.get("formatLabel") or r.get("variant") or r.get("modeLabel") or "Unknown"
        by_mode[key] = by_mode.get(key, 0) + 1
    return {
        "registrations": regs,
        "approvedRegistrations": approved,
        "totalEntries": len(regs),
        "approvedEntries": len(approved),
        "pendingEntries": len(pending),
        "rejectedEntries": len(rejected),
        "totalPlayers": total_players,
        "approvedPlayers": approved_players,
        "expectedAmount": expected_amount,
        "approvedExpectedAmount": approved_expected_amount,
        "reportedPaidAmount": reported_paid,
        "approvedReportedPaidAmount": approved_reported_paid,
        "registrationCounts": registration_counts(regs),
        "byMode": by_mode,
        "updatedAt": state.get("updatedAt"),
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8") or "{}")

    def require_pin(self, payload):
        if str(payload.get("pin") or "") != str(ADMIN_PIN):
            self.send_json({"ok": False, "error": "Invalid admin PIN"}, 403)
            return False
        return True

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            self.send_json(public_state(load_state()))
            return
        if path in ("/server-data.json", "/server.py"):
            self.send_json({"ok": False, "error": "Not found"}, 404)
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            payload = self.read_json()
        except Exception:
            self.send_json({"ok": False, "error": "Invalid JSON"}, 400)
            return

        state = load_state()

        if path == "/api/register":
            reg = dict(payload or {})
            if not reg.get("id") or not reg.get("roomId") or not reg.get("teamName"):
                self.send_json({"ok": False, "error": "Missing registration details"}, 400)
                return
            reg["serverReceivedAt"] = now_iso()
            reg["status"] = "Pending"
            state.setdefault("registrations", []).insert(0, reg)
            save_state(state)
            self.send_json({"ok": True, "message": "Registration saved on the live server. Final slot needs admin confirmation.", "state": public_state(state)})
            return

        if path == "/api/admin/summary":
            if not self.require_pin(payload):
                return
            self.send_json({"ok": True, **admin_summary(state)})
            return

        if path == "/api/admin/registration-status":
            if not self.require_pin(payload):
                return
            reg_id = str(payload.get("registrationId") or "").strip()
            status = str(payload.get("status") or "").strip().title()
            if status not in ("Pending", "Approved", "Rejected"):
                self.send_json({"ok": False, "error": "Invalid status"}, 400)
                return
            found = False
            for reg in state.get("registrations", []):
                if str(reg.get("id")) == reg_id:
                    reg["status"] = status
                    reg["statusUpdatedAt"] = now_iso()
                    found = True
                    break
            if not found:
                self.send_json({"ok": False, "error": "Registration not found"}, 404)
                return
            save_state(state)
            self.send_json({"ok": True, "state": public_state(state), **admin_summary(state)})
            return

        if path == "/api/admin/clear-registrations":
            if not self.require_pin(payload):
                return
            state["registrations"] = []
            save_state(state)
            self.send_json({"ok": True, "state": public_state(state)})
            return

        if path == "/api/admin/room-count":
            if not self.require_pin(payload):
                return
            room_id = str(payload.get("roomId") or "").strip()
            count = int(payload.get("count") or 0)
            if not room_id:
                self.send_json({"ok": False, "error": "Missing room ID"}, 400)
                return
            state.setdefault("roomOverrides", {})[room_id] = max(0, count)
            save_state(state)
            self.send_json({"ok": True, "state": public_state(state)})
            return

        if path == "/api/admin/leaderboard":
            if not self.require_pin(payload):
                return
            mode = payload.get("mode")
            entry = payload.get("entry") or {}
            if mode not in ("br", "cs") or not entry.get("teamName"):
                self.send_json({"ok": False, "error": "Invalid leaderboard entry"}, 400)
                return
            state.setdefault("leaderboard", {"br": [], "cs": []}).setdefault(mode, []).append(entry)
            save_state(state)
            self.send_json({"ok": True, "state": public_state(state)})
            return

        if path == "/api/admin/room-details":
            if not self.require_pin(payload):
                return
            detail = payload.get("detail") or {}
            room_id = str(detail.get("roomId") or "").strip()
            if not room_id:
                self.send_json({"ok": False, "error": "Missing website room"}, 400)
                return
            detail["updatedAt"] = now_iso()
            state.setdefault("roomDetails", {})[room_id] = detail
            save_state(state)
            self.send_json({"ok": True, "state": public_state(state)})
            return

        self.send_json({"ok": False, "error": "Unknown API endpoint"}, 404)


if __name__ == "__main__":
    host = "0.0.0.0"
    port = int(os.environ.get("PORT", "8000"))
    print(f"NIT Hamirpur Free Fire Tournament server running on http://{host}:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
