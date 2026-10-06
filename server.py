#!/usr/bin/env python3
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(ROOT, "server-data.json")
ADMIN_PIN = (os.environ.get("TOURNAMENT_ADMIN_PIN") or "2026").strip()
SCHEDULE_WINDOWS = {
    "slot1": {"label": "Slot 1", "time": "9:00 PM–10:00 PM"},
    "slot2": {"label": "Slot 2", "time": "10:00 PM–11:00 PM"},
    "slot3": {"label": "Slot 3", "time": "11:00 PM–12:00 AM"},
}


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
    # Backfill slot numbers for older pending registrations and normalize capacity to this 1–12 scheme.
    changed = False
    for reg in base["registrations"]:
        if not isinstance(reg, dict):
            continue
        room_id = reg.get("roomId")
        try:
            slot = int(reg.get("slotNumber") or 0)
        except Exception:
            slot = 0
        capacity = room_capacity(room_id)
        if reg.get("slotNumber") and reg.get("slotCapacity") != capacity:
            reg["slotCapacity"] = capacity
            changed = True
        if str(reg.get("status") or "Pending").lower() != "rejected" and (slot < 1 or slot > capacity):
            new_slot, new_capacity = next_available_slot(base["registrations"], room_id, exclude_id=reg.get("id"))
            if new_slot is not None:
                reg["slotNumber"] = new_slot
                reg["slotCapacity"] = new_capacity
                changed = True
    if changed:
        save_state(base)
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
    """Count reserved slots (pending/approved) so full lobbies stop taking registrations."""
    counts = {}
    for reg in registrations:
        if str(reg.get("status") or "Pending").lower() == "rejected":
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


def room_capacity(room_id):
    """Tournament slots are 1–12 per Battle Royale lobby; Clash Squad pairs 2 teams."""
    room = str(room_id or "").upper()
    if room.startswith("CS-"):
        return 2
    if room.startswith("BR-"):
        return 12
    return 12


def used_slots(registrations, room_id, exclude_id=None):
    used = set()
    for reg in registrations:
        if exclude_id and str(reg.get("id")) == str(exclude_id):
            continue
        if str(reg.get("roomId")) != str(room_id):
            continue
        if str(reg.get("status") or "Pending").lower() == "rejected":
            continue
        try:
            slot = int(reg.get("slotNumber") or 0)
        except Exception:
            slot = 0
        if 1 <= slot <= room_capacity(room_id):
            used.add(slot)
    return used


def next_available_slot(registrations, room_id, exclude_id=None):
    capacity = room_capacity(room_id)
    used = used_slots(registrations, room_id, exclude_id=exclude_id)
    for slot in range(1, capacity + 1):
        if slot not in used:
            return slot, capacity
    return None, capacity


def approved_slots(registrations):
    slots = []
    for reg in registrations:
        if not is_approved(reg):
            continue
        slot = reg.get("slotNumber")
        if not slot:
            continue
        slots.append({
            "roomId": reg.get("roomId"),
            "roomTitle": reg.get("roomTitle"),
            "slotNumber": slot,
            "slotCapacity": room_capacity(reg.get("roomId")),
            "teamName": reg.get("teamName"),
            "mode": reg.get("mode"),
            "modeLabel": reg.get("modeLabel"),
            "formatLabel": reg.get("formatLabel"),
            "variant": reg.get("variant"),
            "scheduleSlot": reg.get("scheduleSlot"),
            "scheduleSlotLabel": reg.get("scheduleSlotLabel"),
            "finalScore": reg.get("finalScore"),
            "status": reg.get("status"),
        })
    return slots


def approved_teams(registrations):
    teams = []
    for reg in registrations:
        if not is_approved(reg):
            continue
        roster = [
            str(player.get("ign") or "").strip()
            for player in (reg.get("players") or [])
            if isinstance(player, dict) and str(player.get("ign") or "").strip()
        ]
        teams.append({
            "teamName": reg.get("teamName"),
            "mode": reg.get("mode"),
            "modeLabel": reg.get("modeLabel"),
            "format": reg.get("format"),
            "formatLabel": reg.get("formatLabel"),
            "variant": reg.get("variant"),
            "roomId": reg.get("roomId"),
            "roomTitle": reg.get("roomTitle"),
            "fee": reg.get("fee"),
            "slotNumber": reg.get("slotNumber"),
            "slotCapacity": room_capacity(reg.get("roomId")),
            "scheduleSlot": reg.get("scheduleSlot"),
            "scheduleSlotLabel": reg.get("scheduleSlotLabel"),
            "scheduleTime": reg.get("scheduleTime"),
            "players": roster,
            "finalScore": reg.get("finalScore"),
            "scoreUpdatedAt": reg.get("scoreUpdatedAt"),
        })
    return teams


def public_registration_status(reg):
    if not reg:
        return {"found": False, "message": "No registration uses that room and slot number. Check the selected lobby and try again."}
    return {
        "found": True,
        "status": reg.get("status") or "Pending",
        "teamName": reg.get("teamName"),
        "roomId": reg.get("roomId"),
        "roomTitle": reg.get("roomTitle"),
        "slotNumber": reg.get("slotNumber"),
        "slotCapacity": room_capacity(reg.get("roomId")),
        "modeLabel": reg.get("modeLabel"),
        "formatLabel": reg.get("formatLabel"),
        "variant": reg.get("variant"),
        "scheduleSlotLabel": reg.get("scheduleSlotLabel"),
        "scheduleTime": reg.get("scheduleTime"),
        "updatedAt": reg.get("statusUpdatedAt") or reg.get("serverReceivedAt"),
    }


def public_state(state):
    return {
        "roomOverrides": state.get("roomOverrides", {}),
        "registrationCounts": registration_counts(state.get("registrations", [])),
        "approvedSlots": approved_slots(state.get("registrations", [])),
        "approvedTeams": approved_teams(state.get("registrations", [])),
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
        "approvedSlots": approved_slots(regs),
        "approvedTeams": approved_teams(regs),
        "byMode": by_mode,
        "updatedAt": state.get("updatedAt"),
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

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
            if any(str(existing.get("id")) == str(reg.get("id")) for existing in state.get("registrations", [])):
                self.send_json({"ok": False, "error": "This registration was already submitted."}, 409)
                return
            schedule_key = str(reg.get("scheduleSlot") or "slot1")
            if schedule_key not in SCHEDULE_WINDOWS:
                self.send_json({"ok": False, "error": "Select a valid match time slot."}, 400)
                return
            window = SCHEDULE_WINDOWS[schedule_key]
            reg["scheduleSlot"] = schedule_key
            reg["scheduleSlotLabel"] = window["label"]
            reg["scheduleTime"] = window["time"] + " IST"
            slot, capacity = next_available_slot(state.get("registrations", []), reg.get("roomId"))
            if slot is None:
                self.send_json({"ok": False, "error": "This lobby has no slots left (maximum 12). Choose another lobby."}, 409)
                return
            reg["slotNumber"] = slot
            reg["slotCapacity"] = capacity
            reg["serverReceivedAt"] = now_iso()
            reg["status"] = "Pending"
            state.setdefault("registrations", []).insert(0, reg)
            save_state(state)
            self.send_json({
                "ok": True,
                "message": f"Registration received. Your reserved slot is {slot}/{capacity}; approval is pending.",
                "registration": public_registration_status(reg),
                "state": public_state(state),
            })
            return

        if path == "/api/check-status":
            room_id = str(payload.get("roomId") or "").strip()
            try:
                slot_number = int(payload.get("slotNumber") or 0)
            except Exception:
                slot_number = 0
            if not room_id or not 1 <= slot_number <= 12:
                self.send_json({"ok": False, "error": "Choose a lobby and enter a slot number from 1 to 12."}, 400)
                return
            found_reg = None
            for reg in state.get("registrations", []):
                try:
                    reg_slot = int(reg.get("slotNumber") or 0)
                except Exception:
                    reg_slot = 0
                if str(reg.get("roomId")) == room_id and reg_slot == slot_number:
                    found_reg = reg
                    break
            self.send_json({"ok": True, **public_registration_status(found_reg)})
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
            updated_reg = None
            for reg in state.get("registrations", []):
                if str(reg.get("id")) == reg_id:
                    previous_status = str(reg.get("status") or "Pending").lower()
                    try:
                        existing_slot = int(reg.get("slotNumber") or 0)
                    except Exception:
                        existing_slot = 0
                    conflicting_slot = existing_slot in used_slots(state.get("registrations", []), reg.get("roomId"), exclude_id=reg_id)
                    if status in ("Approved", "Pending") and (existing_slot < 1 or existing_slot > room_capacity(reg.get("roomId")) or (previous_status == "rejected" and conflicting_slot)):
                        slot, capacity = next_available_slot(state.get("registrations", []), reg.get("roomId"), exclude_id=reg_id)
                        if slot is None:
                            self.send_json({"ok": False, "error": "No slot left in this room/lobby."}, 409)
                            return
                        reg["slotNumber"] = slot
                        reg["slotCapacity"] = capacity
                    # Keep the slot on rejected records, but make it reusable by the next registration.
                    reg["status"] = status
                    reg["statusUpdatedAt"] = now_iso()
                    updated_reg = reg
                    found = True
                    break
            if not found:
                self.send_json({"ok": False, "error": "Registration not found"}, 404)
                return
            save_state(state)
            self.send_json({"ok": True, "registration": public_registration_status(updated_reg), "state": public_state(state), **admin_summary(state)})
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

        if path == "/api/admin/final-scores":
            if not self.require_pin(payload):
                return
            scores = payload.get("scores")
            if not isinstance(scores, list):
                self.send_json({"ok": False, "error": "Scores must be a list."}, 400)
                return
            registrations_by_id = {str(reg.get("id")): reg for reg in state.get("registrations", [])}
            validated = []
            for item in scores:
                if not isinstance(item, dict):
                    self.send_json({"ok": False, "error": "Invalid score row."}, 400)
                    return
                reg = registrations_by_id.get(str(item.get("registrationId") or ""))
                if not reg or not is_approved(reg):
                    self.send_json({"ok": False, "error": "Only approved registrations can receive a final score."}, 400)
                    return
                value = item.get("finalScore")
                if value is None or str(value).strip() == "":
                    validated.append((reg, None))
                    continue
                try:
                    score = float(value)
                except Exception:
                    self.send_json({"ok": False, "error": "Scores must be numbers."}, 400)
                    return
                if not 0 <= score <= 99999:
                    self.send_json({"ok": False, "error": "Scores must be between 0 and 99,999."}, 400)
                    return
                if score.is_integer():
                    score = int(score)
                validated.append((reg, score))
            stamp = now_iso()
            for reg, score in validated:
                if score is None:
                    reg.pop("finalScore", None)
                    reg.pop("scoreUpdatedAt", None)
                else:
                    reg["finalScore"] = score
                    reg["scoreUpdatedAt"] = stamp
            save_state(state)
            self.send_json({"ok": True, "message": "Final scores saved.", "state": public_state(state), **admin_summary(state)})
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
