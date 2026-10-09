#!/usr/bin/env python3
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import threading
import time
import unicodedata
from collections import defaultdict, deque
from datetime import date, datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("TOURNAMENT_DATA_DIR", "").strip() or ROOT
DATA_FILE = os.environ.get("TOURNAMENT_DATA_FILE", "").strip() or os.path.join(DATA_DIR, "server-data.json")
STATE_LOCK = threading.RLock()
ADMIN_PASSWORD_HASH = os.environ.get("TOURNAMENT_ADMIN_PASSWORD_HASH", "").strip()
PBKDF2_ITERATIONS = 600_000
SESSION_TTL_SECONDS = 8 * 60 * 60
SESSION_COOKIE_SECURE_NAME = "__Host-nith_admin"
SESSION_COOKIE_DEV_NAME = "nith_admin_dev"
ADMIN_SESSIONS = {}
ADMIN_SESSIONS_LOCK = threading.RLock()
RATE_LIMITS = {
    "admin-login": (5, 15 * 60),
    "admin-login-global": (30, 15 * 60),
    "admin-api": (120, 60),
    "register": (30, 10 * 60),
    "check-status": (120, 5 * 60),
    "public-state": (180, 60),
    "admin-session": (60, 60),
    "other-api": (120, 60),
}
_RATE_BUCKETS = defaultdict(deque)
_RATE_LOCK = threading.Lock()
PUBLIC_STATIC_FILES = frozenset({
    "index.html", "admin.html", "admin-dashboard.html", "battle-royale.html",
    "clash-squad.html", "leaderboard.html", "room-details.html", "rules.html",
    "schedule-results.html", "status-check.html", "data.js", "site.js", "styles.css",
})
DEFAULT_SCHEDULE_SETTINGS = {
    "br": {"startTime": "21:00", "durationHours": 1, "gapHours": 0},
    "cs": {"startTime": "21:00", "durationHours": 1, "gapHours": 0},
}
BR_PLACEMENT_POINTS = {1: 12, 2: 9, 3: 8, 4: 7, 5: 6, 6: 5, 7: 4, 8: 3, 9: 2, 10: 1, 11: 0, 12: 0}
IMAGE_DATA_URL_RE = re.compile(r"^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$")
MAX_QR_DATA_URL_CHARS = 1_500_000


def create_password_hash(password, salt=None, iterations=PBKDF2_ITERATIONS):
    """Create a PBKDF2-SHA256 verifier for a strong admin passphrase."""
    if not isinstance(password, str) or len(password) < 16:
        raise ValueError("Admin password must be at least 16 characters long.")
    if not isinstance(iterations, int) or iterations < PBKDF2_ITERATIONS:
        raise ValueError("PBKDF2 iteration count is below the configured security minimum.")
    salt_bytes = salt if isinstance(salt, bytes) else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt_bytes, iterations)
    salt_text = base64.urlsafe_b64encode(salt_bytes).decode("ascii").rstrip("=")
    digest_text = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return f"pbkdf2_sha256${iterations}${salt_text}${digest_text}"


def verify_password_hash(password, encoded_hash):
    if not isinstance(password, str) or not isinstance(encoded_hash, str):
        return False
    try:
        algorithm, rounds_text, salt_text, digest_text = encoded_hash.split("$", 3)
        rounds = int(rounds_text)
        if algorithm != "pbkdf2_sha256" or not PBKDF2_ITERATIONS <= rounds <= 2_000_000:
            return False
        padding = "=" * (-len(salt_text) % 4)
        salt = base64.urlsafe_b64decode(salt_text + padding)
        padding = "=" * (-len(digest_text) % 4)
        expected = base64.urlsafe_b64decode(digest_text + padding)
        if len(salt) < 16 or len(salt) > 64 or len(expected) != 32:
            return False
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError, UnicodeError, base64.binascii.Error):
        return False


def allow_rate_limit(key, limit, window_seconds, now=None):
    now = time.monotonic() if now is None else now
    with _RATE_LOCK:
        bucket = _RATE_BUCKETS[key]
        cutoff = now - window_seconds
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= limit:
            return False
        bucket.append(now)
        if len(_RATE_BUCKETS) > 20_000:
            for stale_key in list(_RATE_BUCKETS)[:5_000]:
                stale_bucket = _RATE_BUCKETS[stale_key]
                if not stale_bucket or stale_bucket[-1] <= now - 3600:
                    _RATE_BUCKETS.pop(stale_key, None)
        return True


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
    for reg in base["registrations"]:
        if room_mode(reg.get("roomId"), reg.get("mode")) != "cs":
            continue
        cs_format = cs_format_from_room_id(reg.get("roomId"))
        if reg.get("format") != cs_format.lower():
            reg["format"] = cs_format.lower()
            changed = True
        if reg.get("formatLabel") not in CS_FORMAT_LABELS.values():
            reg["formatLabel"] = CS_FORMAT_LABELS[cs_format]
            changed = True
        if not reg.get("playersPerEntry"):
            players = reg.get("players") if isinstance(reg.get("players"), list) else []
            reg["playersPerEntry"] = len(players) or CS_FORMAT_PLAYERS[cs_format]
            changed = True
        if reg.get("feeRule") != "per registered side":
            reg["feeRule"] = "per registered side"
            changed = True
    for row in base["matchHistory"]:
        if row.get("mode") != "cs" and not str(row.get("roomId") or "").upper().startswith("CS-"):
            continue
        cs_format = cs_format_from_room_id(row.get("roomId"))
        if row.get("format") != cs_format.lower():
            row["format"] = cs_format.lower()
            changed = True
        if row.get("formatLabel") not in CS_FORMAT_LABELS.values():
            row["formatLabel"] = CS_FORMAT_LABELS[cs_format]
            changed = True
    known_history = {(str(row.get("registrationId") or ""), row.get("date")) for row in base["matchHistory"]}
    registrations_with_history = {registration_id for registration_id, _ in known_history if registration_id}
    for reg in base["registrations"]:
        registration_id = str(reg.get("id") or "")
        match_date = match_date_from_timestamp(reg.get("scoreUpdatedAt"))
        # Legacy latest scores should be migrated only when this registration has no dated history.
        if not registration_id or not match_date or registration_id in registrations_with_history or (registration_id, match_date) in known_history or reg.get("finalScore") is None:
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
        os.makedirs(directory, mode=0o700, exist_ok=True)
        if os.path.exists(DATA_FILE):
            try:
                with open(DATA_FILE, "r", encoding="utf-8") as current:
                    json.load(current)
                backup_tmp = DATA_FILE + ".bak.tmp"
                shutil.copy2(DATA_FILE, backup_tmp)
                os.chmod(backup_tmp, 0o600)
                os.replace(backup_tmp, DATA_FILE + ".bak")
                os.chmod(DATA_FILE + ".bak", 0o600)
            except Exception:
                pass
        tmp = DATA_FILE + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, DATA_FILE)
        os.chmod(DATA_FILE, 0o600)


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
    # New size-specific rooms use CS-NM-SOLO-50-1; existing CS-NM-50-1 IDs remain 4v4.
    if len(parts) >= 5 and parts[0] == "CS" and parts[2] in CS_FORMAT_PLAYERS:
        return parts[2]
    return "SQUAD"


def room_capacity(room_id):
    return 2 if str(room_id or "").upper().startswith("CS-") else 12


def room_metadata(room_id):
    room_id = str(room_id or "").strip().upper()
    br_match = re.fullmatch(r"BR-(SOLO|DUO|TRIO|SQUAD)-(20|40|60|80|100)-([1-3])", room_id)
    if br_match:
        format_id, fee_text, slot_text = br_match.groups()
        labels = {"SOLO": "Solo", "DUO": "Duo", "TRIO": "Trio", "SQUAD": "Squad"}
        players = {"SOLO": 1, "DUO": 2, "TRIO": 3, "SQUAD": 4}
        label = labels[format_id]
        slot = int(slot_text)
        return {
            "id": room_id, "mode": "br", "modeLabel": "Battle Royale",
            "format": format_id.lower(), "formatLabel": label,
            "playersPerEntry": players[format_id], "fee": int(fee_text),
            "feeRule": "per player" if format_id == "SOLO" else "per team",
            "variant": "", "slot": slot, "capacity": 12,
            "title": f"{label} Battle Royale Lobby {slot}",
        }
    cs_match = re.fullmatch(r"CS-(NM|OT)(?:-(SOLO|DUO|TRIO))?-(50|70|90|110)-([1-3])", room_id)
    if cs_match:
        variant_code, format_code, fee_text, slot_text = cs_match.groups()
        format_id = format_code or "SQUAD"
        labels = {"SOLO": "Solo · 1v1", "DUO": "Duo · 2v2", "TRIO": "Trio · 3v3", "SQUAD": "Squad · 4v4"}
        players = {"SOLO": 1, "DUO": 2, "TRIO": 3, "SQUAD": 4}
        variant = "One Tap" if variant_code == "OT" else "Normal"
        slot = int(slot_text)
        return {
            "id": room_id, "mode": "cs", "modeLabel": "Clash Squad",
            "format": format_id.lower(), "formatLabel": labels[format_id],
            "playersPerEntry": players[format_id], "fee": int(fee_text),
            "feeRule": "per registered side", "variant": variant,
            "slot": slot, "capacity": 2,
            "title": f"{variant} {labels[format_id]} Clash Squad Room {slot}",
        }
    return None


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


def normalize_user_text(value, limit=500, preserve_lines=False):
    if not isinstance(value, str):
        return ""
    filtered = []
    for char in value:
        if char in "\r\n":
            filtered.append("\n" if preserve_lines else " ")
        elif char == "\t":
            filtered.append(" ")
        elif unicodedata.category(char) == "Cc":
            continue
        else:
            # Preserve Unicode format/combining characters used in emoji and player names.
            filtered.append(char)
    printable = "".join(filtered)
    if preserve_lines:
        cleaned = "\n".join(" ".join(line.split()) for line in printable.splitlines()).strip()
    else:
        cleaned = " ".join(printable.split())
    return cleaned[:limit]



def normalize_name(value, limit=80):
    return normalize_user_text(value, limit)


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
    server_version = "TournamentWeb"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def setup(self):
        # Bound slow/incomplete client requests so each cannot hold a worker forever.
        self.request.settimeout(15)
        super().setup()

    def log_message(self, fmt, *args):
        # Keep ordinary access logging, but never log request bodies or credentials.
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def is_secure_request(self):
        forwarded = str(self.headers.get("X-Forwarded-Proto") or "").split(",", 1)[0].strip().lower()
        return forwarded == "https" or bool(getattr(self.connection, "is_https", False))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        csp = (
            "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; "
            "form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'none'"
        )
        if self.is_secure_request():
            csp += "; upgrade-insecure-requests"
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        self.send_header("Content-Security-Policy", csp)
        super().end_headers()

    def send_json(self, payload, status=200, headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or []):
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def is_same_origin(self):
        origin = str(self.headers.get("Origin") or "").strip()
        host = str(self.headers.get("Host") or "").strip()
        forwarded = str(self.headers.get("X-Forwarded-Proto") or "").split(",", 1)[0].strip().lower()
        scheme = forwarded if forwarded in ("http", "https") else ("https" if self.is_secure_request() else "http")
        try:
            parsed = urlparse(origin)
            return (
                parsed.scheme.lower() == scheme
                and parsed.netloc.casefold() == host.casefold()
                and parsed.path in ("", "/")
                and not parsed.params
                and not parsed.query
                and not parsed.fragment
                and parsed.username is None
                and parsed.password is None
            )
        except Exception:
            return False

    def client_ip(self):
        # Render's proxy appends the connecting client address at the end of X-Forwarded-For.
        forwarded = str(self.headers.get("X-Forwarded-For") or "")
        if forwarded:
            candidate = forwarded.split(",")[-1].strip()
            try:
                return str(ipaddress.ip_address(candidate))
            except ValueError:
                pass
        try:
            return str(ipaddress.ip_address(self.client_address[0]))
        except (ValueError, TypeError, IndexError):
            return "unknown"

    def rate_limit_bucket(self, path):
        ip = self.client_ip()
        if path == "/api/admin/login":
            per_ip_limit, per_ip_window = RATE_LIMITS["admin-login"]
            global_limit, global_window = RATE_LIMITS["admin-login-global"]
            return (
                allow_rate_limit(("admin-login", ip), per_ip_limit, per_ip_window)
                and allow_rate_limit(("admin-login-global",), global_limit, global_window)
            )
        if path == "/api/admin/session":
            name = "admin-session"
        elif path == "/api/register":
            name = "register"
        elif path == "/api/check-status":
            name = "check-status"
        elif path == "/api/state":
            name = "public-state"
        elif path.startswith("/api/admin/"):
            name = "admin-api"
        else:
            name = "other-api"
        limit, window = RATE_LIMITS[name]
        return allow_rate_limit((name, ip), limit, window)

    def cookie_name(self):
        return SESSION_COOKIE_SECURE_NAME if self.is_secure_request() else SESSION_COOKIE_DEV_NAME

    def make_session_cookie(self, name, value, max_age):
        cookie = SimpleCookie()
        cookie[name] = value
        morsel = cookie[name]
        morsel["path"] = "/"
        morsel["max-age"] = str(int(max_age))
        morsel["httponly"] = True
        morsel["samesite"] = "Strict"
        if name == SESSION_COOKIE_SECURE_NAME or self.is_secure_request():
            morsel["secure"] = True
        return morsel.OutputString()

    def clear_session_cookies(self):
        return [
            ("Set-Cookie", self.make_session_cookie(SESSION_COOKIE_SECURE_NAME, "", 0)),
            ("Set-Cookie", self.make_session_cookie(SESSION_COOKIE_DEV_NAME, "", 0)),
        ]

    def raw_session_token(self):
        cookie_header = str(self.headers.get("Cookie") or "")
        if not cookie_header:
            return ""
        jar = SimpleCookie()
        try:
            jar.load(cookie_header)
        except Exception:
            return ""
        for name in (self.cookie_name(), SESSION_COOKIE_SECURE_NAME, SESSION_COOKIE_DEV_NAME):
            if name in jar:
                return str(jar[name].value or "")
        return ""

    def get_admin_session(self):
        token = self.raw_session_token()
        if not token:
            return None, None
        key = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now = time.monotonic()
        with ADMIN_SESSIONS_LOCK:
            session = ADMIN_SESSIONS.get(key)
            if not session:
                return None, None
            if session["expires"] <= now:
                ADMIN_SESSIONS.pop(key, None)
                return None, None
            return key, session

    def start_admin_session(self):
        token = secrets.token_urlsafe(32)
        csrf_token = secrets.token_urlsafe(32)
        key = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now = time.monotonic()
        with ADMIN_SESSIONS_LOCK:
            for expired_key in [k for k, value in ADMIN_SESSIONS.items() if value["expires"] <= now]:
                ADMIN_SESSIONS.pop(expired_key, None)
            while len(ADMIN_SESSIONS) >= 2_000:
                ADMIN_SESSIONS.pop(next(iter(ADMIN_SESSIONS)))
            ADMIN_SESSIONS[key] = {"csrf": csrf_token, "expires": now + SESSION_TTL_SECONDS}
        cookie_name = self.cookie_name()
        headers = [("Set-Cookie", self.make_session_cookie(cookie_name, token, SESSION_TTL_SECONDS))]
        self.send_json({"ok": True, "csrfToken": csrf_token, "expiresIn": SESSION_TTL_SECONDS}, headers=headers)

    def require_admin(self):
        _key, session = self.get_admin_session()
        if not session:
            self.send_json({"ok": False, "error": "Admin sign-in required."}, 401)
            return False
        csrf = str(self.headers.get("X-CSRF-Token") or "")
        if not csrf or not hmac.compare_digest(csrf, session["csrf"]):
            self.send_json({"ok": False, "error": "Security token expired. Sign in again."}, 403)
            return False
        return True

    def read_json(self):
        content_type = str(self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise ValueError("Content-Type must be application/json")
        raw_length = self.headers.get("Content-Length", "0")
        try:
            length = int(raw_length or "0")
        except (TypeError, ValueError):
            raise ValueError("Invalid Content-Length")
        if length <= 0:
            return {}
        if length > 2_000_000:
            raise ValueError("Request is too large")
        raw = self.rfile.read(length)
        parsed = json.loads(raw.decode("utf-8") or "{}")
        if not isinstance(parsed, dict):
            raise ValueError("JSON body must be an object")
        return parsed

    def is_public_static_path(self, path):
        decoded = unquote(str(path or ""))
        if decoded == "/":
            decoded = "/index.html"
        if not decoded.startswith("/") or decoded.startswith("//") or "\\" in decoded:
            return False
        relative = decoded.lstrip("/")
        if not relative or "/" in relative or relative not in PUBLIC_STATIC_FILES:
            return False
        root = os.path.realpath(ROOT)
        candidate = os.path.realpath(os.path.join(root, relative))
        try:
            return os.path.commonpath((root, candidate)) == root and os.path.isfile(candidate)
        except (OSError, ValueError):
            return False

    def do_HEAD(self):
        path = urlparse(self.path).path
        if not self.is_public_static_path(path):
            self.send_error(404, "Not found")
            return
        if path == "/":
            self.path = "/index.html"
        super().do_HEAD()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            if not self.rate_limit_bucket(path):
                self.send_json({"ok": False, "error": "Too many requests. Please try again shortly."}, 429, [("Retry-After", "60")])
                return
            self.send_json(public_state(load_state()))
            return
        if path == "/api/admin/session":
            if not self.rate_limit_bucket(path):
                self.send_json({"ok": False, "error": "Too many requests. Please try again shortly."}, 429, [("Retry-After", "60")])
                return
            _key, session = self.get_admin_session()
            if not session:
                self.send_json({"ok": False, "error": "Admin sign-in required."}, 401)
                return
            self.send_json({"ok": True, "csrfToken": session["csrf"], "expiresIn": max(0, int(session["expires"] - time.monotonic()))})
            return
        if path.startswith("/api/"):
            self.send_json({"ok": False, "error": "Not found"}, 404)
            return
        if not self.is_public_static_path(path):
            self.send_error(404, "Not found")
            return
        if path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_OPTIONS(self):
        self.send_response(405)
        self.send_header("Allow", "GET, HEAD, POST")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        path = urlparse(self.path).path
        if path in ("/api/admin/login", "/api/admin/logout"):
            return self._do_post_locked()
        with STATE_LOCK:
            return self._do_post_locked()

    def _do_post_locked(self):
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            self.send_json({"ok": False, "error": "Not found"}, 404)
            return
        if not self.is_same_origin():
            self.send_json({"ok": False, "error": "Cross-origin requests are not allowed."}, 403)
            return
        if not self.rate_limit_bucket(path):
            self.send_json({"ok": False, "error": "Too many requests. Please try again shortly."}, 429, [("Retry-After", "60")])
            return
        try:
            payload = self.read_json()
        except Exception:
            self.send_json({"ok": False, "error": "Invalid JSON, content type, or oversized request."}, 400)
            return

        if path == "/api/admin/login":
            if not ADMIN_PASSWORD_HASH:
                self.send_json({"ok": False, "error": "Admin sign-in is not configured. Set TOURNAMENT_ADMIN_PASSWORD_HASH in the host environment."}, 503)
                return
            password = payload.get("password")
            if not isinstance(password, str) or len(password) > 1024 or not verify_password_hash(password, ADMIN_PASSWORD_HASH):
                self.send_json({"ok": False, "error": "Sign-in failed."}, 401)
                return
            self.start_admin_session()
            return

        if path == "/api/admin/logout":
            if not self.require_admin():
                return
            token = self.raw_session_token()
            if token:
                key = hashlib.sha256(token.encode("utf-8")).hexdigest()
                with ADMIN_SESSIONS_LOCK:
                    ADMIN_SESSIONS.pop(key, None)
            self.send_json({"ok": True, "message": "Signed out."}, headers=self.clear_session_cookies())
            return

        if path.startswith("/api/admin/") and not self.require_admin():
            return
        state = load_state()
        if path == "/api/register":
            room_id = str(payload.get("roomId") or "").strip().upper()
            room = room_metadata(room_id)
            if not room:
                self.send_json({"ok": False, "error": "Choose a valid tournament room."}, 400)
                return
            registration_id = str(payload.get("id") or "").strip()
            if not re.fullmatch(r"(?:BR|CS)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+){0,3}", registration_id):
                self.send_json({"ok": False, "error": "Registration ID is invalid. Refresh the form and try again."}, 400)
                return
            if any(str(existing.get("id")) == registration_id for existing in state.get("registrations", [])):
                self.send_json({"ok": False, "error": "This registration was already submitted."}, 409)
                return
            if payload.get("acceptedRules") is not True:
                self.send_json({"ok": False, "error": "Accept the tournament rules before submitting."}, 400)
                return
            players = payload.get("players")
            if not isinstance(players, list) or len(players) != room["playersPerEntry"]:
                self.send_json({"ok": False, "error": f"This room requires exactly {room['playersPerEntry']} player{'s' if room['playersPerEntry'] != 1 else ''}."}, 400)
                return
            normalized_players = []
            for index, player in enumerate(players, start=1):
                if not isinstance(player, dict):
                    self.send_json({"ok": False, "error": f"Enter valid player details for Player {index}."}, 400)
                    return
                ign = normalize_name(player.get("ign"), 80)
                uid = str(player.get("uid") or "").strip() if isinstance(player.get("uid"), (str, int)) else ""
                if not ign or not re.fullmatch(r"\d{6,15}", uid):
                    self.send_json({"ok": False, "error": f"Enter a valid IGN and numeric Free Fire ID for Player {index}."}, 400)
                    return
                normalized_players.append({"ign": ign, "uid": uid})
            try:
                submitted_player_count = int(payload.get("playersPerEntry") or 0)
            except (TypeError, ValueError):
                submitted_player_count = 0
            if submitted_player_count != room["playersPerEntry"]:
                self.send_json({"ok": False, "error": "Player count does not match the selected room."}, 400)
                return
            team_name = normalize_name(payload.get("teamName"), 80) or normalized_players[0]["ign"]
            whatsapp = normalize_user_text(payload.get("whatsapp"), 24)
            whatsapp_digits = re.sub(r"\D", "", whatsapp)
            if not re.fullmatch(r"[+0-9() .-]{10,24}", whatsapp) or not 10 <= len(whatsapp_digits) <= 13:
                self.send_json({"ok": False, "error": "Enter a valid WhatsApp number."}, 400)
                return
            payment_ref = normalize_user_text(payload.get("paymentRef"), 120)
            if not payment_ref:
                self.send_json({"ok": False, "error": "Enter the payment reference or write 'Pay after confirmation'."}, 400)
                return
            schedule_key = f"slot{room['slot']}"
            window = next((item for item in schedule_windows(state.get("scheduleSettings"))[room["mode"]] if item["id"] == schedule_key), None)
            if not window:
                self.send_json({"ok": False, "error": "Could not determine match time from the selected lobby."}, 400)
                return
            slot, capacity = next_available_slot(state.get("registrations", []), room_id)
            if slot is None:
                self.send_json({"ok": False, "error": f"This lobby has no slots left (maximum {capacity}). Choose another time slot/lobby."}, 409)
                return
            server_stamp = now_iso()
            ist = timezone(timedelta(hours=5, minutes=30))
            submitted_at_display = datetime.now(timezone.utc).astimezone(ist).strftime("%d %b %Y, %I:%M %p")
            reg = {
                "id": registration_id,
                "mode": room["mode"],
                "modeLabel": room["modeLabel"],
                "format": room["format"],
                "formatLabel": room["formatLabel"],
                "playersPerEntry": room["playersPerEntry"],
                "roomId": room_id,
                "roomTitle": room["title"],
                "scheduleSlot": schedule_key,
                "scheduleSlotLabel": window["label"],
                "scheduleTime": window["time"] + " IST",
                "fee": room["fee"],
                "feeRule": room["feeRule"],
                "variant": room["variant"],
                "teamName": team_name,
                "captainName": normalized_players[0]["ign"],
                "iglName": normalized_players[0]["ign"],
                "iglUid": normalized_players[0]["uid"],
                "whatsapp": whatsapp,
                "paymentRef": payment_ref,
                "players": normalized_players,
                "acceptedRules": True,
                "localSlotHeld": True,
                "status": "Pending",
                "submittedAt": server_stamp,
                "submittedAtDisplay": submitted_at_display,
            }
            reg["slotNumber"] = slot
            reg["slotCapacity"] = capacity
            reg["serverReceivedAt"] = server_stamp
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
            room_id = str(payload.get("roomId") or "").strip().upper()
            room = room_metadata(room_id)
            try:
                slot_number = int(payload.get("slotNumber") or 0)
            except (TypeError, ValueError):
                slot_number = 0
            if not room:
                self.send_json({"ok": False, "error": "Choose a valid lobby."}, 400)
                return
            capacity = room["capacity"]
            if not 1 <= slot_number <= capacity:
                self.send_json({"ok": False, "error": f"Enter a slot number from 1 to {capacity}."}, 400)
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
            self.send_json({"ok": True, **admin_summary(state)})
            return

        if path == "/api/admin/registration-status":
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
            state["registrations"] = []
            save_state(state)
            self.send_json({"ok": True, "state": public_state(state)})
            return

        if path == "/api/admin/room-count":
            room_id = str(payload.get("roomId") or "").strip().upper()
            room = room_metadata(room_id)
            try:
                count = int(payload.get("count") or 0)
            except (TypeError, ValueError):
                count = -1
            if not room or count < 0 or count > room["capacity"]:
                self.send_json({"ok": False, "error": "Enter a valid room and count within its capacity."}, 400)
                return
            state.setdefault("roomOverrides", {})[room_id] = count
            save_state(state)
            self.send_json({"ok": True, "state": public_state(state)})
            return

        if path == "/api/admin/schedule-settings":
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
            settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
            qr = settings.get("qrDataUrl", "")
            if not valid_image_data_url(qr):
                self.send_json({"ok": False, "error": "Upload a PNG, JPG, or WebP QR image up to about 1 MB."}, 400)
                return
            state["paymentSettings"] = {
                "payeeName": normalize_name(settings.get("payeeName"), 100),
                "upiId": normalize_user_text(settings.get("upiId"), 120),
                "note": normalize_user_text(settings.get("note"), 500, preserve_lines=True),
                "qrDataUrl": qr or "",
                "updatedAt": now_iso(),
            }
            save_state(state)
            self.send_json({"ok": True, "state": public_state(state), **admin_summary(state)})
            return

        if path == "/api/admin/leaderboard-settings":
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
            source = payload.get("detail")
            detail = source if isinstance(source, dict) else {}
            room_id = str(detail.get("roomId") or "").strip().upper()
            if not room_metadata(room_id):
                self.send_json({"ok": False, "error": "Choose a valid website room."}, 400)
                return
            qr = detail.get("roomQrDataUrl", "")
            if not valid_image_data_url(qr):
                self.send_json({"ok": False, "error": "Room join QR must be a PNG, JPG, or WebP image up to about 1 MB."}, 400)
                return
            custom_room_id = normalize_user_text(detail.get("customRoomId"), 40)
            room_password = normalize_user_text(detail.get("password"), 80)
            if not custom_room_id or not room_password:
                self.send_json({"ok": False, "error": "Enter both the custom room ID and password."}, 400)
                return
            safe_detail = {
                "roomId": room_id,
                "customRoomId": custom_room_id,
                "password": room_password,
                "message": normalize_user_text(detail.get("message"), 500, preserve_lines=True),
                "roomQrDataUrl": qr or "",
                "published": detail.get("published") is True,
                "forcePublish": detail.get("forcePublish") is True,
                "updatedAt": now_iso(),
            }
            state.setdefault("roomDetails", {})[room_id] = safe_detail
            save_state(state)
            self.send_json({"ok": True, "state": public_state(state), **admin_summary(state)})
            return

        if path == "/api/admin/delete-room-details":
            room_id = str(payload.get("roomId") or "").strip().upper()
            room_details = state.setdefault("roomDetails", {})
            if not room_metadata(room_id):
                self.send_json({"ok": False, "error": "Select a valid website room."}, 400)
                return
            if room_id not in room_details:
                self.send_json({"ok": False, "error": "No saved room details exist for this lobby."}, 404)
                return
            del room_details[room_id]
            save_state(state)
            self.send_json({"ok": True, "message": "Saved room details removed.", "state": public_state(state), **admin_summary(state)})
            return

        self.send_json({"ok": False, "error": "Unknown API endpoint"}, 404)


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64
    max_concurrent_requests = 64

    def __init__(self, *args, **kwargs):
        self._request_slots = threading.BoundedSemaphore(self.max_concurrent_requests)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self._request_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            worker = threading.Thread(
                target=self.process_request_thread,
                args=(request, client_address),
                daemon=self.daemon_threads,
            )
            worker.start()
        except Exception:
            self._request_slots.release()
            self.handle_error(request, client_address)
            self.shutdown_request(request)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()


if __name__ == "__main__":
    host = "0.0.0.0"
    port = int(os.environ.get("PORT", "8000"))
    if not ADMIN_PASSWORD_HASH:
        print("WARNING: TOURNAMENT_ADMIN_PASSWORD_HASH is not configured; admin sign-in is disabled.")
    print(f"NIT Hamirpur Free Fire Tournament server running on http://{host}:{port}; state file: {DATA_FILE}")
    BoundedThreadingHTTPServer((host, port), Handler).serve_forever()
