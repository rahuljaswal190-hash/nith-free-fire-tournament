#!/usr/bin/env python3
import json
import os
import re
import shutil
import hashlib
import threading
from datetime import date, datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("TOURNAMENT_DATA_DIR", "").strip() or ROOT
DATA_FILE = os.environ.get("TOURNAMENT_DATA_FILE", "").strip() or os.path.join(DATA_DIR, "server-data.json")
STATE_LOCK = threading.RLock()
ADMIN_PIN = (os.environ.get("TOURNAMENT_ADMIN_PIN") or "2026").strip()
DEFAULT_SCHEDULE_SETTINGS = {
    "br": {"startTime": "21:00", "durationHours": 1, "gapHours": 0},
    "cs": {"startTime": "21:00", "durationHours": 1, "gapHours": 0},
}
BR_PLACEMENT_POINTS = {1: 12, 2: 9, 3: 8, 4: 7, 5: 6, 6: 5, 7: 4, 8: 3, 9: 2, 10: 1, 11: 0, 12: 0}
IMAGE_DATA_URL_RE = re.compile(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$")
MAX_QR_DATA_URL_CHARS = 1_500_000


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
            restore_tmp = DATA_FILE + ".restore.tmp"
            shutil.copy2(backup_file, restore_tmp)
            os.replace(restore_tmp, DATA_FILE)
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
    base["matchHistory"] = [row for row in base.get("matchHistory", []) if isinstance(row, dict) and valid_match_date(row.get("date"))]
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
    changed = False
    known_history = {(str(row.get("registrationId") or ""), row.get("date")) for row in base["matchHistory"]}
    for reg in base["registrations"]:
        registration_id = str(reg.get("id") or "")
        match_date = match_date_from_timestamp(reg.get("scoreUpdatedAt"))
        if not registration_id or not match_date or (registration_id, match_date) in known_history or reg.get("finalScore") is None:
            continue
        mode = room_mode(reg.get("roomId"), reg.get("mode"))
        result_details = public_match_results(reg)
        base["matchHistory"].append({
            "registrationId": registration_id,
            "entryKey": hashlib.sha256(registration_id.encode("utf-8")).hexdigest()[:16],
            "date": match_date,
            "mode": mode,
            "teamName": reg.get("teamName"),
            "modeLabel": reg.get("modeLabel"),
            "format": reg.get("format"),
            "formatLabel": reg.get("formatLabel"),
            "variant": reg.get("variant"),
            "roomId": reg.get("roomId"),
            "roomTitle": reg.get("roomTitle"),
            "slotNumber": reg.get("slotNumber"),
            "slotCapacity": room_capacity(reg.get("roomId")),
            "fee": reg.get("fee"),
            "scheduleSlotLabel": reg.get("scheduleSlotLabel"),
            "scheduleTime": reg.get("scheduleTime"),
            "players": [str(player.get("ign") or "").strip() for player in reg.get("players", []) if isinstance(player, dict) and str(player.get("ign") or "").strip()],
            "brMatches": result_details["brMatches"],
            "csResult": result_details["csResult"],
            "finalScore": reg.get("finalScore"),
            "lastMatchScore": result_details["lastMatchScore"],
            "csRoundDiff": result_details["csRoundDiff"],
            "scoreUpdatedAt": reg.get("scoreUpdatedAt"),
        })
        known_history.add((registration_id, match_date))
        changed = True
    if changed:
        base["matchHistory"].sort(key=lambda row: (str(row.get("date") or ""), str(row.get("registrationId") or "")))
    windows = schedule_windows(base["scheduleSettings"])
    for reg in base["registrations"]:
        room_id = reg.get("roomId")
        mode = room_mode(room_id, reg.get("mode"))
        capacity = room_capacity(room_id)
        expected_slot = f"slot{room_slot_index(room_id)}"
        if reg.get("scheduleSlot") != expected_slot:
            reg["scheduleSlot"] = expected_slot
            changed = True
        window = next((item for item in windows[mode] if item["id"] == expected_slot), windows[mode][0])
        new_time = window["time"] + " IST"
        if reg.get("scheduleSlotLabel") != window["label"] or reg.get("scheduleTime") != new_time:
            reg["scheduleSlotLabel"] = window["label"]
            reg["scheduleTime"] = new_time
            changed = True
        try:
            slot = int(reg.get("slotNumber") or 0)
        except (TypeError, ValueError):
            slot = 0
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


def data_storage_is_mounted():
    configured_directory = os.environ.get("TOURNAMENT_DATA_DIR", "").strip()
    configured_file = os.environ.get("TOURNAMENT_DATA_FILE", "").strip()
    if configured_directory:
        configured_path = os.path.abspath(configured_directory)
    elif configured_file:
        configured_path = os.path.dirname(os.path.abspath(configured_file))
    else:
        return False
    return os.path.ismount(configured_path)


def save_state(state):
    with STATE_LOCK:
        state["updatedAt"] = now_iso()
        directory = os.path.dirname(os.path.abspath(DATA_FILE))
        os.makedirs(directory, exist_ok=True)
        if os.path.exists(DATA_FILE):
            try:
                with open(DATA_FILE, "r", encoding="utf-8") as current:
                    json.load(current)
                backup_tmp = DATA_FILE + ".bak.tmp"
                shutil.copy2(DATA_FILE, backup_tmp)
                os.replace(backup_tmp, DATA_FILE + ".bak")
            except Exception:
                pass
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
        "formatLabel": reg.get("formatLabel"),
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
        "matchHistory": public_match_history(state),
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
            "path": DATA_FILE,
            "configuredDirectory": bool(os.environ.get("TOURNAMENT_DATA_DIR") or os.environ.get("TOURNAMENT_DATA_FILE")),
            "mounted": data_storage_is_mounted(),
        },
        "byMode": by_mode,
        "updatedAt": state.get("updatedAt"),
    }


def normalize_name(value, limit=80):
    return " ".join(str(value or "").split())[:limit]


def score_match_result(kills, position):
    return int(kills) + BR_PLACEMENT_POINTS[int(position)]


def valid_match_date(value):
    text = str(value or "")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return False
    try:
        return date.fromisoformat(text).isoformat() == text
    except ValueError:
        return False


def match_date_from_timestamp(value):
    if not value:
        return ""
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        ist = timezone(timedelta(hours=5, minutes=30))
        return parsed.astimezone(ist).date().isoformat()
    except (TypeError, ValueError):
        return ""


def public_match_history(state):
    public_rows = []
    for row in state.get("matchHistory", []):
        if not isinstance(row, dict) or not valid_match_date(row.get("date")):
            continue
        player_values = row.get("players") if isinstance(row.get("players"), list) else []
        players = [str(name).strip() for name in player_values if str(name).strip()]
        br_matches = row.get("brMatches") if isinstance(row.get("brMatches"), list) else []
        cs_result = row.get("csResult") if isinstance(row.get("csResult"), dict) else None
        public_rows.append({
            "entryKey": str(row.get("entryKey") or ""),
            "date": row.get("date"),
            "mode": row.get("mode") if row.get("mode") in ("br", "cs") else room_mode(row.get("roomId"), row.get("mode")),
            "teamName": str(row.get("teamName") or ""),
            "modeLabel": str(row.get("modeLabel") or ""),
            "format": str(row.get("format") or ""),
            "formatLabel": str(row.get("formatLabel") or ""),
            "variant": str(row.get("variant") or ""),
            "roomId": str(row.get("roomId") or ""),
            "roomTitle": str(row.get("roomTitle") or ""),
            "slotNumber": row.get("slotNumber"),
            "slotCapacity": row.get("slotCapacity"),
            "fee": row.get("fee"),
            "scheduleSlotLabel": str(row.get("scheduleSlotLabel") or ""),
            "scheduleTime": str(row.get("scheduleTime") or ""),
            "players": players,
            "finalScore": row.get("finalScore"),
            "brMatches": br_matches,
            "csResult": cs_result,
            "lastMatchScore": row.get("lastMatchScore"),
            "csRoundDiff": row.get("csRoundDiff"),
            "scoreUpdatedAt": row.get("scoreUpdatedAt"),
        })
    return sorted(public_rows, key=lambda item: (item["date"], item["teamName"].casefold(), item["entryKey"]))


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

    def is_private_static_path(self, path):
        decoded = unquote(str(path or "")).lstrip("/")
        candidate = os.path.realpath(os.path.join(ROOT, decoded))
        protected_state_paths = {
            os.path.realpath(DATA_FILE),
            os.path.realpath(os.path.join(ROOT, "server-data.json")),
        }
        state_file = False
        for state_path in protected_state_paths:
            same_directory = os.path.dirname(candidate) == os.path.dirname(state_path)
            state_name = os.path.basename(state_path)
            if candidate == state_path or (same_directory and os.path.basename(candidate).startswith(state_name + ".")):
                state_file = True
                break
        server_source = os.path.realpath(os.path.join(ROOT, "server.py"))
        return candidate == server_source or state_file

    def do_HEAD(self):
        path = urlparse(self.path).path
        if self.is_private_static_path(path):
            self.send_error(404, "Not found")
            return
        super().do_HEAD()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            self.send_json(public_state(load_state()))
            return
        if self.is_private_static_path(path):
            self.send_json({"ok": False, "error": "Not found"}, 404)
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
            schedule_key = f"slot{room_slot_index(reg.get('roomId'))}"
            window = next((item for item in schedule_windows(state.get("scheduleSettings"))[mode] if item["id"] == schedule_key), None)
            if not window:
                self.send_json({"ok": False, "error": "Could not determine match time from the selected lobby."}, 400)
                return
            reg["mode"] = mode
            reg["scheduleSlot"] = schedule_key
            reg["scheduleSlotLabel"] = window["label"]
            reg["scheduleTime"] = window["time"] + " IST"
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
                "message": f"Registration received. Your reserved slot is {slot}/{capacity}; approval is pending until organizer review.",
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
            capacity = room_capacity(room_id)
            if not room_id or not 1 <= slot_number <= capacity:
                self.send_json({"ok": False, "error": f"Choose a lobby and enter a slot number from 1 to {capacity}."}, 400)
                return
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
            if status not in ("Pending", "Approved", "Rejected"):
                self.send_json({"ok": False, "error": "Invalid status"}, 400)
                return
            found = False
            updated_reg = None
            for reg in state.get("registrations", []):
                if str(reg.get("id")) != reg_id:
                    continue
                try:
                    existing_slot = int(reg.get("slotNumber") or 0)
                except (TypeError, ValueError):
                    existing_slot = 0
                conflicting_slot = existing_slot in used_slots(state.get("registrations", []), reg.get("roomId"), exclude_id=reg_id)
                previous_status = str(reg.get("status") or "Pending").lower()
                if status in ("Approved", "Pending") and (existing_slot < 1 or existing_slot > room_capacity(reg.get("roomId")) or (previous_status == "rejected" and conflicting_slot)):
                    slot, capacity = next_available_slot(state.get("registrations", []), reg.get("roomId"), exclude_id=reg_id)
                    if slot is None:
                        self.send_json({"ok": False, "error": "No slot left in this room/lobby."}, 409)
                        return
                    reg["slotNumber"] = slot
                    reg["slotCapacity"] = capacity
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

        if path == "/api/admin/edit-registration":
            if not self.require_pin(payload):
                return
            reg_id = str(payload.get("registrationId") or "").strip()
            reg = next((item for item in state.get("registrations", []) if str(item.get("id")) == reg_id), None)
            if not reg:
                self.send_json({"ok": False, "error": "Registration not found"}, 404)
                return
            team_name = normalize_name(payload.get("teamName"))
            if not team_name:
                self.send_json({"ok": False, "error": "Team/entry name cannot be blank."}, 400)
                return
            player_edits = payload.get("players")
            if not isinstance(player_edits, list) or not player_edits:
                self.send_json({"ok": False, "error": "At least one roster player is required."}, 400)
                return
            updated_players = []
            for index, item in enumerate(player_edits[:4]):
                if not isinstance(item, dict):
                    continue
                if item.get("remove"):
                    if index == 0:
                        self.send_json({"ok": False, "error": "The IGL/player 1 cannot be removed; edit the name instead."}, 400)
                        return
                    continue
                original = reg.get("players", [])[index] if index < len(reg.get("players", [])) else {}
                uid = str(item.get("uid") or (original.get("uid") if isinstance(original, dict) else "") or "")
                ign = normalize_name(item.get("ign"), 80)
                if not ign:
                    self.send_json({"ok": False, "error": "Player names cannot be blank. Use Remove player for a teammate you want to omit."}, 400)
                    return
                updated_players.append({"ign": ign, "uid": uid})
            if not updated_players:
                self.send_json({"ok": False, "error": "At least one roster player is required."}, 400)
                return
            reg["teamName"] = team_name
            reg["players"] = updated_players
            reg["playersPerEntry"] = len(updated_players)
            reg["iglName"] = normalize_name(payload.get("iglName") or updated_players[0]["ign"])
            reg["captainName"] = reg["iglName"]
            reg["iglUid"] = updated_players[0].get("uid", "")
            reg["registrationEditedAt"] = now_iso()
            save_state(state)
            self.send_json({"ok": True, "message": "Registration names and roster updated.", **admin_summary(state), "state": public_state(state)})
            return

        if path == "/api/admin/delete-registration":
            if not self.require_pin(payload):
                return
            reg_id = str(payload.get("registrationId") or "").strip()
            before = len(state.get("registrations", []))
            state["registrations"] = [item for item in state.get("registrations", []) if str(item.get("id")) != reg_id]
            if len(state["registrations"]) == before:
                self.send_json({"ok": False, "error": "Registration not found"}, 404)
                return
            save_state(state)
            self.send_json({"ok": True, "message": "Registration removed.", "state": public_state(state), **admin_summary(state)})
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
            try:
                count = int(payload.get("count") or 0)
            except (TypeError, ValueError):
                count = -1
            if not room_id or count < 0 or count > room_capacity(room_id):
                self.send_json({"ok": False, "error": "Enter a valid room and count within its capacity."}, 400)
                return
            state.setdefault("roomOverrides", {})[room_id] = count
            save_state(state)
            self.send_json({"ok": True, "state": public_state(state)})
            return

        if path == "/api/admin/schedule-settings":
            if not self.require_pin(payload):
                return
            proposed = payload.get("settings")
            if not isinstance(proposed, dict):
                self.send_json({"ok": False, "error": "Schedule settings are required."}, 400)
                return
            for mode in ("br", "cs"):
                entry = proposed.get(mode)
                if not isinstance(entry, dict):
                    self.send_json({"ok": False, "error": f"Missing {mode.upper()} schedule."}, 400)
                    return
                if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", str(entry.get("startTime") or "")):
                    self.send_json({"ok": False, "error": "Choose a valid start time."}, 400)
                    return
                try:
                    duration_value = int(entry.get("durationHours") or 0)
                    gap_value = int(entry.get("gapHours") if entry.get("gapHours") is not None else -1)
                except (TypeError, ValueError):
                    duration_value, gap_value = 0, -1
                if duration_value not in (1, 2) or gap_value not in (0, 1, 2):
                    self.send_json({"ok": False, "error": "Duration must be 1 or 2 hours and gap must be 0, 1, or 2 hours."}, 400)
                    return
            state["scheduleSettings"] = normalize_schedule_settings(proposed)
            windows = schedule_windows(state["scheduleSettings"])
            for reg in state.get("registrations", []):
                mode = room_mode(reg.get("roomId"), reg.get("mode"))
                slot_key = f"slot{room_slot_index(reg.get('roomId'))}"
                window = next(item for item in windows[mode] if item["id"] == slot_key)
                reg["scheduleSlot"] = slot_key
                reg["scheduleSlotLabel"] = window["label"]
                reg["scheduleTime"] = window["time"] + " IST"
            save_state(state)
            self.send_json({"ok": True, "scheduleWindows": windows, "state": public_state(state), **admin_summary(state)})
            return

        if path == "/api/admin/payment-settings":
            if not self.require_pin(payload):
                return
            settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
            qr = settings.get("qrDataUrl", "")
            if not valid_image_data_url(qr):
                self.send_json({"ok": False, "error": "Upload a PNG, JPG, or WebP QR image up to about 1 MB."}, 400)
                return
            state["paymentSettings"] = {
                "payeeName": normalize_name(settings.get("payeeName"), 100),
                "upiId": str(settings.get("upiId") or "").strip()[:120],
                "note": str(settings.get("note") or "").strip()[:500],
                "qrDataUrl": qr or "",
                "updatedAt": now_iso(),
            }
            save_state(state)
            self.send_json({"ok": True, "state": public_state(state), **admin_summary(state)})
            return

        if path == "/api/admin/leaderboard-settings":
            if not self.require_pin(payload):
                return
            settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
            default_view = str(settings.get("defaultView") or "").strip().lower()
            if default_view not in ("latest", "all"):
                self.send_json({"ok": False, "error": "Choose Latest match date or All-time cumulative."}, 400)
                return
            state["leaderboardSettings"] = {"defaultView": default_view}
            save_state(state)
            self.send_json({"ok": True, "message": "Leaderboard display preference saved.", "state": public_state(state), **admin_summary(state)})
            return

        if path == "/api/admin/match-results":
            if not self.require_pin(payload):
                return
            match_date = str(payload.get("matchDate") or date.today().isoformat()).strip()
            if not valid_match_date(match_date):
                self.send_json({"ok": False, "error": "Choose a valid match date in YYYY-MM-DD format."}, 400)
                return
            rows = payload.get("results")
            if not isinstance(rows, list):
                self.send_json({"ok": False, "error": "Match results must be a list."}, 400)
                return
            registrations = {str(reg.get("id")): reg for reg in state.get("registrations", [])}
            validated = []
            seen_ids = set()
            for row in rows:
                if not isinstance(row, dict):
                    self.send_json({"ok": False, "error": "Invalid result row."}, 400)
                    return
                reg_id = str(row.get("registrationId") or "")
                if reg_id in seen_ids:
                    self.send_json({"ok": False, "error": "Each registration can appear only once per results submission."}, 400)
                    return
                seen_ids.add(reg_id)
                reg = registrations.get(reg_id)
                if not reg or not is_approved(reg):
                    self.send_json({"ok": False, "error": "Only approved entries can receive match results."}, 400)
                    return
                mode = room_mode(reg.get("roomId"), reg.get("mode"))
                if mode == "br":
                    raw_matches = row.get("matches")
                    if not isinstance(raw_matches, list) or len(raw_matches) != 3:
                        self.send_json({"ok": False, "error": "Enter one kills/position pair for each of the 3 BR matches."}, 400)
                        return
                    matches = []
                    any_played = False
                    for match in raw_matches:
                        if not isinstance(match, dict):
                            self.send_json({"ok": False, "error": "Invalid BR match row."}, 400)
                            return
                        kills_raw = match.get("kills")
                        position_raw = match.get("position")
                        if kills_raw in (None, "") and position_raw in (None, ""):
                            matches.append({"kills": None, "position": None, "score": None})
                            continue
                        try:
                            kills = int(kills_raw)
                            position = int(position_raw)
                        except (TypeError, ValueError):
                            self.send_json({"ok": False, "error": "For each played BR match, enter both kills and placement position."}, 400)
                            return
                        if not 0 <= kills <= 99 or position not in BR_PLACEMENT_POINTS:
                            self.send_json({"ok": False, "error": "Kills must be 0–99 and placement must be 1–12."}, 400)
                            return
                        any_played = True
                        matches.append({"kills": kills, "position": position, "score": score_match_result(kills, position)})
                    if not any_played:
                        continue
                    final_score = sum(match["score"] or 0 for match in matches)
                    validated.append((reg, {"mode": "br", "matches": matches, "finalScore": final_score, "csResult": None}))
                else:
                    cs_result = row.get("csResult") if isinstance(row.get("csResult"), dict) else {}
                    outcome = str(cs_result.get("outcome") or "").strip().title()
                    if outcome not in ("", "Win", "Loss"):
                        self.send_json({"ok": False, "error": "Clash Squad result must be Win or Loss."}, 400)
                        return
                    if not outcome:
                        continue
                    try:
                        round_diff = int(cs_result.get("roundDiff") or 0)
                    except (TypeError, ValueError):
                        self.send_json({"ok": False, "error": "Round difference must be a whole number."}, 400)
                        return
                    if not -99 <= round_diff <= 99:
                        self.send_json({"ok": False, "error": "Round difference must be between -99 and 99."}, 400)
                        return
                    score = 3 if outcome == "Win" else 0
                    validated.append((reg, {"mode": "cs", "matches": None, "finalScore": score, "csResult": {"outcome": outcome, "roundDiff": round_diff}}))
            if not validated:
                self.send_json({"ok": False, "error": "Enter at least one played match result before saving."}, 400)
                return
            stamp = now_iso()
            history = state.setdefault("matchHistory", [])
            for reg, result in validated:
                registration_id = str(reg.get("id") or "")
                br_matches = result["matches"] or []
                last_match_score = next((item.get("score") for item in reversed(br_matches) if item.get("score") is not None), None)
                cs_result = result["csResult"]
                record = {
                    "registrationId": registration_id,
                    "entryKey": hashlib.sha256(registration_id.encode("utf-8")).hexdigest()[:16],
                    "date": match_date,
                    "mode": result["mode"],
                    "teamName": reg.get("teamName"),
                    "modeLabel": reg.get("modeLabel"),
                    "format": reg.get("format"),
                    "formatLabel": reg.get("formatLabel"),
                    "variant": reg.get("variant"),
                    "roomId": reg.get("roomId"),
                    "roomTitle": reg.get("roomTitle"),
                    "slotNumber": reg.get("slotNumber"),
                    "slotCapacity": room_capacity(reg.get("roomId")),
                    "scheduleSlotLabel": reg.get("scheduleSlotLabel"),
                    "scheduleTime": reg.get("scheduleTime"),
                    "players": [str(player.get("ign") or "").strip() for player in reg.get("players", []) if isinstance(player, dict) and str(player.get("ign") or "").strip()],
                    "brMatches": br_matches,
                    "csResult": cs_result,
                    "finalScore": result["finalScore"],
                    "lastMatchScore": last_match_score,
                    "csRoundDiff": cs_result.get("roundDiff") if isinstance(cs_result, dict) else None,
                    "scoreUpdatedAt": stamp,
                }
                old_index = next((index for index, item in enumerate(history) if str(item.get("registrationId") or "") == registration_id and item.get("date") == match_date), None)
                if old_index is None:
                    history.append(record)
                else:
                    history[old_index] = record
                prior_dates = [item.get("date") for item in history if str(item.get("registrationId") or "") == registration_id and valid_match_date(item.get("date"))]
                newest_date = max(prior_dates) if prior_dates else match_date
                if match_date >= newest_date:
                    if result["mode"] == "br":
                        reg["brMatches"] = br_matches
                        reg.pop("csResult", None)
                    else:
                        reg["csResult"] = cs_result
                        reg.pop("brMatches", None)
                    reg["finalScore"] = result["finalScore"]
                    reg["scoreUpdatedAt"] = stamp
            history.sort(key=lambda item: (str(item.get("date") or ""), str(item.get("registrationId") or "")))
            save_state(state)
            self.send_json({"ok": True, "message": f"Results for {match_date} saved to match history.", "state": public_state(state), **admin_summary(state)})
            return

        if path == "/api/admin/room-details":
            if not self.require_pin(payload):
                return
            detail = payload.get("detail") or {}
            room_id = str(detail.get("roomId") or "").strip()
            if not room_id:
                self.send_json({"ok": False, "error": "Missing website room"}, 400)
                return
            qr = detail.get("roomQrDataUrl", "")
            if not valid_image_data_url(qr):
                self.send_json({"ok": False, "error": "Room join QR must be a PNG, JPG, or WebP image up to about 1 MB."}, 400)
                return
            detail["roomQrDataUrl"] = qr or ""
            detail["updatedAt"] = now_iso()
            state.setdefault("roomDetails", {})[room_id] = detail
            save_state(state)
            self.send_json({"ok": True, "state": public_state(state)})
            return

        self.send_json({"ok": False, "error": "Unknown API endpoint"}, 404)


if __name__ == "__main__":
    host = "0.0.0.0"
    port = int(os.environ.get("PORT", "8000"))
    print(f"NIT Hamirpur Free Fire Tournament server running on http://{host}:{port}; state file: {DATA_FILE}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
