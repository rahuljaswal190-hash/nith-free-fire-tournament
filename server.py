#!/usr/init/env python3
import json
import os
import re
import shutil
import hashlib
import threading
from datetime import date, datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

try:
    from pymongo import MongoClient
    from pymongo.errors import ConnectionFailure
    MONGODB_AVAILABLE = True
except ImportError:
    MONGODB_AVAILABLE = False

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("TOURNAMENT_DATA_DIR", "").strip() or ROOT
DATA_FILE = os.environ.get("TOURNAMENT_DATA_FILE", "").strip() or os.path.join(DATA_DIR, "server-data.json")
MONGODB_URI = os.environ.get("MONGODB_URI", "").strip() or "mongodb+srv://rahuljaswal190_db_user:CNkQF4S7Exy5N6bh@cluster0.ligy7wo.mongodb.net/?appName=Cluster0"

STATE_LOCK = threading.RLock()
ADMIN_PIN = (os.environ.get("TOURNAMENT_ADMIN_PIN") or "2026").strip()
DEFAULT_SCHEDULE_SETTINGS = {
    "br": {"startTime": "21:00", "durationHours": 1, "gapHours": 0},
    "cs": {"startTime": "21:00", "durationHours": 1, "gapHours": 0},
}
BR_PLACEMENT_POINTS = {1: 12, 2: 9, 3: 8, 4: 7, 5: 6, 6: 5, 7: 4, 8: 3, 9: 2, 10: 1, 11: 0, 12: 0}
IMAGE_DATA_URL_RE = re.compile(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$")
MAX_QR_DATA_URL_CHARS = 1_500_000

# MongoDB Client Setup
mongo_client = None
mongo_collection = None
if MONGODB_AVAILABLE and MONGODB_URI:
    try:
        mongo_client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        mongo_client.admin.command('ping')
        db = mongo_client["nith_free_fire_db"]
        mongo_collection = db["tournament_state"]
        print("Connected to MongoDB Atlas successfully!")
    except Exception as e:
        print(f"Warning: Could not connect to MongoDB Atlas ({e}). Falling back to local JSON file.")
        mongo_collection = None


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def default_state():
    return {
        "registrations": [],
        "roomOverrides": {},
        "roomDetails": {},
        "paymentSettings": {"payeeName": "", "upiId": "", "note": "", "qrDataUrl": ""},
        "scheduleSettings": DEFAULT_SCHEDULE_SETTINGS,
        "leaderboard": {"br": [], "cs": []},
        "matchHistory": [],
        "leaderboardSettings": {"defaultView": "latest"},
        "notices": [],
        "updatedAt": now_iso(),
    }


def normalize_schedule_settings(value):
    source = value if isinstance(value, dict) else {}
    normalized = {}
    for mode in ("br", "cs"):
        raw = source.get(mode) if isinstance(source.get(mode), dict) else {}
        default = DEFAULT_SCHEDULE_SETTINGS[mode]
        start_time = str(raw.get("startTime") or default["startTime"])
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", start_time):
            start_time = default["startTime"]
        try:
            duration = int(raw.get("durationHours", default["durationHours"]))
        except (TypeError, ValueError):
            duration = default["durationHours"]
        if duration not in (1, 2):
            duration = default["durationHours"]
        try:
            gap = int(raw.get("gapHours", default["gapHours"]))
        except (TypeError, ValueError):
            gap = default["gapHours"]
        if gap not in (0, 1, 2):
            gap = default["gapHours"]
        normalized[mode] = {"startTime": start_time, "durationHours": duration, "gapHours": gap}
    return normalized


def clock_label(total_minutes):
    day_offset, minute_of_day = divmod(int(total_minutes), 1440)
    hour24, minute = divmod(minute_of_day, 60)
    suffix = "AM" if hour24 < 12 else "PM"
    hour12 = hour24 % 12 or 12
    label = f"{hour12}:{minute:02d} {suffix}"
    return label, day_offset


def schedule_windows(settings):
    configured = normalize_schedule_settings(settings)
    all_windows = {"br": [], "cs": []}
    for mode in ("br", "cs"):
        conf = configured[mode]
        start_hour, start_minute = (int(part) for part in conf["startTime"].split(":"))
        base_minutes = start_hour * 60 + start_minute
        duration = conf["durationHours"]
        step = (duration + conf["gapHours"]) * 60
        for index in range(3):
            start = base_minutes + index * step
            end = start + duration * 60
            start_label, start_day = clock_label(start)
            end_label, end_day = clock_label(end)
            if start_day > 0:
                day_suffix = " (+1 day)"
            elif end_day > start_day:
                day_suffix = " (midnight)" if end % 1440 == 0 else " (+1 day)"
            else:
                day_suffix = ""
            all_windows[mode].append({
                "id": f"slot{index + 1}",
                "label": f"Slot {index + 1}",
                "time": f"{start_label}–{end_label}{day_suffix}",
                "durationHours": duration,
                "matches": 3 if mode == "br" else 1,
            })
    return all_windows


def room_slot_index(room_id):
    match = re.search(r"-(\d+)$", str(room_id or ""))
    if not match:
        return 1
    value = int(match.group(1))
    return value if 1 <= value <= 3 else 1


def room_mode(room_id, mode=None):
    if mode in ("br", "cs"):
        return mode
    return "cs" if str(room_id or "").upper().startswith("CS-") else "br"


def valid_image_data_url(value):
    if value in (None, ""):
        return True
    return isinstance(value, str) and len(value) <= MAX_QR_DATA_URL_CHARS and bool(IMAGE_DATA_URL_RE.fullmatch(value))


def load_state():
    with STATE_LOCK:
        return _load_state_locked()


def _load_state_locked():
    loaded = None
    if mongo_collection is not None:
        try:
            doc = mongo_collection.find_one({"_id": "state"})
            if doc:
                doc.pop("_id", None)
                loaded = doc
        except Exception as e:
            print(f"MongoDB read error: {e}")

    if loaded is None:
        backup_file = DATA_FILE + ".bak"
        if not os.path.exists(DATA_FILE):
            legacy_file = os.path.join(ROOT, "server-data.json")
            source_file = backup_file if os.path.exists(backup_file) else legacy_file
            if os.path.exists(source_file) and os.path.abspath(source_file) != os.path.abspath(DATA_FILE):
                os.makedirs(os.path.dirname(os.path.abspath(DATA_FILE)), exist_ok=True)
                migrated_tmp = DATA_FILE + ".migrate.tmp"
                shutil.copy2(source_file, migrated_tmp)
                os.replace(migrated_tmp, DATA_FILE)
            else:
                return default_state()
        try:
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                loaded = json.load(f)
        except Exception:
            try:
                with open(backup_file, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
            except Exception:
                loaded = default_state()

    base = default_state()
    base.update(loaded if isinstance(loaded, dict) else {})
    base["leaderboard"] = {
        "br": list(base.get("leaderboard", {}).get("br", [])),
        "cs": list(base.get("leaderboard", {}).get("cs", [])),
    }
    base["registrations"] = [r for r in base.get("registrations", []) if isinstance(r, dict)]
    base["roomOverrides"] = dict(base.get("roomOverrides", {}))
    base["roomDetails"] = dict(base.get("roomDetails", {}))
    base["notices"] = list(base.get("notices", []))
    base["matchHistory"] = [row for row in base.get("matchHistory", []) if isinstance(row, dict)]
    
    board_settings = base.get("leaderboardSettings") if isinstance(base.get("leaderboardSettings"), dict) else {}
    default_view = str(board_settings.get("defaultView") or "latest").lower()
    base["leaderboardSettings"] = {"defaultView": default_view if default_view in ("latest", "all") else "latest"}
    base["scheduleSettings"] = normalize_schedule_settings(base.get("scheduleSettings"))
    
    payment = base.get("paymentSettings") if isinstance(base.get("paymentSettings"), dict) else {}
    base["paymentSettings"] = {
        "payeeName": str(payment.get("payeeName") or "")[:100],
        "upiId": str(payment.get("upiId") or "")[:120],
        "note": str(payment.get("note") or "")[:500],
        "qrDataUrl": payment.get("qrDataUrl") if valid_image_data_url(payment.get("qrDataUrl")) else "",
    }
    return base


def save_state(state):
    with STATE_LOCK:
        state["updatedAt"] = now_iso()
        # Save to MongoDB Atlas if connected
        if mongo_collection is not None:
            try:
                doc = dict(state)
                doc["_id"] = "state"
                mongo_collection.replace_one({"_id": "state"}, doc, upsert=True)
                return
            except Exception as e:
                print(f"MongoDB write error: {e}. Falling back to local file.")

        # Fallback to local JSON
        directory = os.path.dirname(os.path.abspath(DATA_FILE))
        os.makedirs(directory, exist_ok=True)
        tmp = DATA_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, DATA_FILE)


def is_approved(reg):
    return str(reg.get("status") or "").lower() == "approved"


def registration_counts(registrations):
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


CS_FORMAT_PLAYERS = {"SOLO": 1, "DUO": 2, "TRIO": 3, "SQUAD": 4}
CS_FORMAT_LABELS = {"SOLO": "Solo · 1v1", "DUO": "Duo · 2v2", "TRIO": "Trio · 3v3", "SQUAD": "Squad · 4v4"}


def cs_format_from_room_id(room_id):
    parts = str(room_id or "").upper().split("-")
    if len(parts) >= 5 and parts[0] == "CS" and parts[2] in CS_FORMAT_PLAYERS:
        return parts[2]
    return "SQUAD"


def room_capacity(room_id):
    return 2 if str(room_id or "").upper().startswith("CS-") else 12


def used_slots(registrations, room_id, exclude_id=None):
    used = set()
    for reg in registrations:
        if exclude_id and str(reg.get("id")) == str(exclude_id):
            continue
        if str(reg.get("roomId")) != str(room_id) or str(reg.get("status") or "Pending").lower() == "rejected":
            continue
        try:
            slot = int(reg.get("slotNumber") or 0)
        except (TypeError, ValueError):
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
        if not is_approved(reg) or not reg.get("slotNumber"):
            continue
        slots.append({
            "roomId": reg.get("roomId"),
            "roomTitle": reg.get("roomTitle"),
            "slotNumber": reg.get("slotNumber"),
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


def public_match_results(reg):
    matches = reg.get("brMatches") if isinstance(reg.get("brMatches"), list) else []
    br_matches = []
    for match in matches[:3]:
        if not isinstance(match, dict):
            br_matches.append({"kills": None, "position": None, "score": None})
        else:
            br_matches.append({"kills": match.get("kills"), "position": match.get("position"), "score": match.get("score")})
    last_match_score = next((match.get("score") for match in reversed(br_matches) if match.get("score") is not None), None)
    return {
        "brMatches": br_matches,
        "csResult": reg.get("csResult"),
        "lastMatchScore": last_match_score,
        "csRoundDiff": (reg.get("csResult") or {}).get("roundDiff") if isinstance(reg.get("csResult"), dict) else None,
    }


def approved_teams(registrations):
    teams = []
    for reg in registrations:
        if not is_approved(reg):
            continue
        roster = [str(player.get("ign") or "").strip() for player in (reg.get("players") or []) if isinstance(player, dict) and str(player.get("ign") or "").strip()]
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
            "brMatches": public_match_results(reg)["brMatches"],
            "csResult": public_match_results(reg)["csResult"],
            "lastMatchScore": public_match_results(reg)["lastMatchScore"],
            "csRoundDiff": public_match_results(reg)["csRoundDiff"],
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
        "format": reg.get("format"),
        "formatLabel": reg.get("formatLabel"),
        "playersPerEntry": reg.get("playersPerEntry"),
        "feeRule": reg.get("feeRule"),
        "variant": reg.get("variant"),
        "scheduleSlotLabel": reg.get("scheduleSlotLabel"),
        "scheduleTime": reg.get("scheduleTime"),
        "updatedAt": reg.get("statusUpdatedAt") or reg.get("serverReceivedAt"),
    }


def public_room_details(state):
    reservations = registration_counts(state.get("registrations", []))
    public_details = {}
    for room_id, detail in state.get("roomDetails", {}).items():
        if not isinstance(detail, dict):
            continue
        complete = max(int(reservations.get(room_id, 0)), int(state.get("roomOverrides", {}).get(room_id, 0) or 0)) >= room_capacity(room_id)
        released = bool(detail.get("published") and (detail.get("forcePublish") or complete))
        if released:
            public_details[room_id] = detail
        else:
            public_details[room_id] = {
                "roomId": room_id,
                "published": bool(detail.get("published")),
                "forcePublish": bool(detail.get("forcePublish")),
                "updatedAt": detail.get("updatedAt"),
            }
    return public_details


def public_state(state):
    return {
        "roomOverrides": state.get("roomOverrides", {}),
        "registrationCounts": registration_counts(state.get("registrations", [])),
        "approvedSlots": approved_slots(state.get("registrations", [])),
        "approvedTeams": approved_teams(state.get("registrations", [])),
        "roomDetails": public_room_details(state),
        "paymentSettings": state.get("paymentSettings", {}),
        "scheduleWindows": schedule_windows(state.get("scheduleSettings")),
        "leaderboard": state.get("leaderboard", {"br": [], "cs": []}),
        "matchHistory": state.get("matchHistory", []),
        "leaderboardSettings": state.get("leaderboardSettings", {"defaultView": "latest"}),
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
        "scheduleSettings": state.get("scheduleSettings", DEFAULT_SCHEDULE_SETTINGS),
        "paymentSettings": state.get("paymentSettings", {}),
        "roomDetails": state.get("roomDetails", {}),
        "matchHistory": state.get("matchHistory", []),
        "leaderboardSettings": state.get("leaderboardSettings", {"defaultView": "latest"}),
        "storageInfo": {
            "path": "MongoDB Atlas Cluster",
            "configuredDirectory": True,
            "mounted": True,
        },
        "byMode": by_mode,
        "updatedAt": state.get("updatedAt"),
    }


def normalize_name(value, limit=80):
    return " ".join(str(value or "").split())[:limit]


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
        if length > 4_000_000:
            raise ValueError("Request is too large")
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
        super().do_GET()

    def do_POST(self):
        with STATE_LOCK:
            return self._do_post_locked()

    def _do_post_locked(self):
        path = urlparse(self.path).path
        try:
            payload = self.read_json()
        except Exception:
            self.send_json({"ok": False, "error": "Invalid JSON or oversized request"}, 400)
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
            mode = room_mode(reg.get("roomId"), reg.get("mode"))
            slot, capacity = next_available_slot(state.get("registrations", []), reg.get("roomId"))
            if slot is None:
                self.send_json({"ok": False, "error": f"This lobby has no slots left (maximum {capacity}). Choose another time slot/lobby."}, 409)
                return
            reg["slotNumber"] = slot
            reg["slotCapacity"] = capacity
            reg["serverReceivedAt"] = now_iso()
            reg["status"] = "Pending"
            state.setdefault("registrations", []).insert(0, reg)
            save_state(state)
            self.send_json({
                "ok": True,
                "message": f"Registration received. Reserved slot {slot}/{capacity}; approval is pending.",
                "registration": public_registration_status(reg),
                "state": public_state(state),
            })
            return

        if path == "/api/check-status":
            room_id = str(payload.get("roomId") or "").strip()
            try:
                slot_number = int(payload.get("slotNumber") or 0)
            except (TypeError, ValueError):
                slot_number = 0
            found_reg = None
            for reg in state.get("registrations", []):
                try:
                    reg_slot = int(reg.get("slotNumber") or 0)
                except (TypeError, ValueError):
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
            updated_reg = None
            for reg in state.get("registrations", []):
                if str(reg.get("id")) != reg_id:
                    continue
                reg["status"] = status
                reg["statusUpdatedAt"] = now_iso()
                updated_reg = reg
                break
            if not updated_reg:
                self.send_json({"ok": False, "error": "Registration not found"}, 404)
                return
            save_state(state)
            self.send_json({"ok": True, "registration": public_registration_status(updated_reg), "state": public_state(state), **admin_summary(state)})
            return

        if path == "/api/admin/delete-registration":
            if not self.require_pin(payload):
                return
            reg_id = str(payload.get("registrationId") or "").strip()
            state["registrations"] = [item for item in state.get("registrations", []) if str(item.get("id")) != reg_id]
            save_state(state)
            self.send_json({"ok": True, "message": "Registration removed.", "state": public_state(state), **admin_summary(state)})
            return

        if path == "/api/admin/payment-settings":
            if not self.require_pin(payload):
                return
            settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
            state["paymentSettings"] = {
                "payeeName": normalize_name(settings.get("payeeName"), 100),
                "upiId": str(settings.get("upiId") or "").strip()[:120],
                "note": str(settings.get("note") or "").strip()[:500],
                "qrDataUrl": settings.get("qrDataUrl") or "",
                "updatedAt": now_iso(),
            }
            save_state(state)
            self.send_json({"ok": True, "state": public_state(state), **admin_summary(state)})
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
            self.send_json({"ok": True, "state": public_state(state), **admin_summary(state)})
            return

        self.send_json({"ok": False, "error": "Unknown API endpoint"}, 404)


if __name__ == "__main__":
    host = "0.0.0.0"
    port = int(os.environ.get("PORT", "8000"))
    print(f"NIT Hamirpur Free Fire Tournament server running on http://{host}:{port} with MongoDB Atlas persistence.")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
