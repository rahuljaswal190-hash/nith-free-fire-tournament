import base64
import json
from contextlib import ExitStack
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import http.cookiejar
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server  # noqa: E402


PNG_DATA_URL = "data:image/png;base64," + base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000b49444154789c636000020000050001a5f645400000000049454e44ae426082"
)).decode("ascii")


class FakeMongoCollection:
    def __init__(self, document=None, fail=False):
        self.document = document
        self.fail = fail
        self.replacements = 0

    def find_one(self, query):
        if self.fail:
            raise RuntimeError("fake Mongo read failure")
        return json.loads(json.dumps(self.document)) if self.document is not None else None

    def replace_one(self, query, document, upsert=False):
        if self.fail:
            raise RuntimeError("fake Mongo write failure")
        self.document = json.loads(json.dumps(document))
        self.replacements += 1


class TournamentApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.old_data_file = server.DATA_FILE
        cls.old_admin_pin = server.ADMIN_PIN
        cls.old_mongodb_uri = server.MONGODB_URI
        cls.old_mongo_client = server._MONGO_CLIENT
        cls.old_mongo_collection = server._MONGO_COLLECTION
        server.MONGODB_URI = ""
        server._MONGO_CLIENT = None
        server._MONGO_COLLECTION = None
        server.DATA_FILE = str(Path(cls.tempdir.name) / "server-data.json")
        cls.test_pin = "81263749"
        server.ADMIN_PIN = cls.test_pin
        cls.httpd = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.thread.join(timeout=3)
        cls.httpd.server_close()
        server.DATA_FILE = cls.old_data_file
        server.ADMIN_PIN = cls.old_admin_pin
        server.MONGODB_URI = cls.old_mongodb_uri
        server._MONGO_CLIENT = cls.old_mongo_client
        server._MONGO_COLLECTION = cls.old_mongo_collection
        cls.tempdir.cleanup()

    def setUp(self):
        server.save_state(server.default_state())
        with server._RATE_LOCK:
            server._RATE_BUCKETS.clear()
        with server.ADMIN_SESSIONS_LOCK:
            server.ADMIN_SESSIONS.clear()
        self.csrf = None
        self.cookie_jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookie_jar))

    def post(self, path, payload, expected=200, headers=None, content_type="application/json"):
        request_headers = {"Content-Type": content_type, "Origin": self.base}
        request_headers.update(headers or {})
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=request_headers,
            method="POST",
        )
        try:
            with self.opener.open(req, timeout=5) as response:
                code = response.status
                body = response.read()
        except urllib.error.HTTPError as error:
            code = error.code
            body = error.read()
        self.assertEqual(code, expected, body.decode("utf-8", errors="replace"))
        return json.loads(body.decode("utf-8"))

    def get_state(self):
        with urllib.request.urlopen(self.base + "/api/state", timeout=5) as response:
            self.assertEqual(response.status, 200)
            return json.loads(response.read().decode("utf-8"))

    def login(self, pin=None, expected=200):
        result = self.post("/api/admin/login", {"pin": pin or self.test_pin}, expected)
        if expected == 200:
            self.csrf = result["csrfToken"]
        return result

    def admin(self, path, payload, expected=200):
        if not self.csrf:
            self.login()
        return self.post(path, payload, expected, headers={"X-CSRF-Token": self.csrf})

    def register_br(self, registration_id="BR-TEST-1", room_id="BR-SOLO-20-1", payment_ref="UTR-TEST-1"):
        return self.post("/api/register", {
            "id": registration_id,
            "mode": "br",
            "modeLabel": "Battle Royale",
            "format": "solo",
            "formatLabel": "Solo",
            "playersPerEntry": 1,
            "roomId": room_id,
            "roomTitle": "Solo Battle Royale lobby",
            "teamName": "Test entry",
            "iglName": "Player One",
            "iglUid": "12345678",
            "players": [{"ign": "Player One", "uid": "12345678"}],
            "fee": 20,
            "paymentRef": payment_ref,
            "whatsapp": "+91 9876543210",
            "acceptedRules": True,
        })

    def test_schedule_is_separate_and_room_slot_maps_to_time(self):
        schedule = {
            "br": {"startTime": "18:30", "durationHours": 1, "gapHours": 1},
            "cs": {"startTime": "20:00", "durationHours": 2, "gapHours": 0},
        }
        saved = self.admin("/api/admin/schedule-settings", {"settings": schedule})
        self.assertEqual(len(saved["scheduleWindows"]["br"]), 3)
        self.assertEqual(len(saved["scheduleWindows"]["cs"]), 3)
        self.assertEqual(saved["scheduleWindows"]["br"][1]["time"], "8:30 PM–9:30 PM")
        self.assertEqual(saved["scheduleWindows"]["cs"][0]["time"], "8:00 PM–10:00 PM")
        registration = self.register_br(room_id="BR-SOLO-20-3")["registration"]
        self.assertEqual(registration["scheduleSlotLabel"], "Slot 3")
        self.assertIn("10:30 PM", registration["scheduleTime"])

    def test_payment_qr_is_public_but_payment_stays_pending_until_manual_approval(self):
        settings = {"payeeName": "Organizer", "upiId": "organizer@bank", "note": "Retain UTR", "qrDataUrl": PNG_DATA_URL}
        self.admin("/api/admin/payment-settings", {"settings": settings})
        registration = self.register_br()["registration"]
        self.assertEqual(registration["status"], "Pending")
        state = self.get_state()
        self.assertEqual(state["paymentSettings"]["upiId"], "organizer@bank")
        self.assertEqual(state["paymentSettings"]["qrDataUrl"], PNG_DATA_URL)
        self.assertEqual(state["approvedTeams"], [])
        self.admin("/api/admin/payment-settings", {"settings": {"qrDataUrl": "data:image/svg+xml;base64,AAAA"}}, 400)

    def test_br_match_scores_calculate_and_publish_last_and_cumulative(self):
        self.register_br()
        self.admin("/api/admin/registration-status", {"registrationId": "BR-TEST-1", "status": "Approved"})
        response = self.admin("/api/admin/match-results", {"results": [{
            "registrationId": "BR-TEST-1",
            "matches": [
                {"kills": 2, "position": 1},
                {"kills": 1, "position": 5},
                {"kills": 0, "position": 12},
            ],
        }]})
        row = response["approvedTeams"][0]
        self.assertEqual([match["score"] for match in row["brMatches"]], [14, 7, 0])
        self.assertEqual(row["lastMatchScore"], 0)
        self.assertEqual(row["finalScore"], 21)
        self.admin("/api/admin/match-results", {"results": [{
            "registrationId": "BR-TEST-1",
            "matches": [{"kills": 1, "position": None}, {}, {}],
        }]}, 400)

    def test_cs_win_and_round_difference_are_published(self):
        response = self.post("/api/register", {
            "id": "CS-TEST-1", "mode": "cs", "modeLabel": "Clash Squad",
            "variant": "Normal", "playersPerEntry": 4, "roomId": "CS-NM-50-2",
            "roomTitle": "Normal Clash Squad Slot 2", "teamName": "CS Crew",
            "iglName": "CS Captain", "players": [
                {"ign": "CS Captain", "uid": "12345678"},
                {"ign": "CS Player 2", "uid": "12345679"},
                {"ign": "CS Player 3", "uid": "12345680"},
                {"ign": "CS Player 4", "uid": "12345681"},
            ],
            "fee": 50, "paymentRef": "UTR-CS-1", "whatsapp": "+91 9876543210", "acceptedRules": True,
        })
        self.assertEqual(response["registration"]["scheduleSlotLabel"], "Slot 2")
        self.admin("/api/admin/registration-status", {"registrationId": "CS-TEST-1", "status": "Approved"})
        saved = self.admin("/api/admin/match-results", {"results": [{
            "registrationId": "CS-TEST-1", "csResult": {"outcome": "Win", "roundDiff": 4}
        }]})
        row = saved["approvedTeams"][0]
        self.assertEqual(row["finalScore"], 3)
        self.assertEqual(row["csResult"]["outcome"], "Win")
        self.assertEqual(row["csRoundDiff"], 4)

    def test_dated_results_archive_history_and_backfill_keeps_latest_entry_score(self):
        self.register_br()
        self.admin("/api/admin/registration-status", {"registrationId": "BR-TEST-1", "status": "Approved"})
        def submit(match_date, first_kills):
            return self.admin("/api/admin/match-results", {"matchDate": match_date, "results": [{
                "registrationId": "BR-TEST-1",
                "matches": [
                    {"kills": first_kills, "position": 1},
                    {"kills": 0, "position": 12},
                    {"kills": 0, "position": 12},
                ],
            }]})
        submit("2026-10-07", 1)
        latest = submit("2026-10-08", 2)
        self.assertEqual(latest["approvedTeams"][0]["finalScore"], 14)
        backfill = submit("2026-10-07", 5)
        self.assertEqual(backfill["approvedTeams"][0]["finalScore"], 14)
        state = self.get_state()
        self.assertEqual([row["date"] for row in state["matchHistory"]], ["2026-10-07", "2026-10-08"])
        self.assertEqual(state["matchHistory"][0]["finalScore"], 17)
        self.assertNotIn("registrationId", state["matchHistory"][0])
        self.assertNotIn("whatsapp", state["matchHistory"][0])

    def test_legacy_json_and_backup_files_are_not_served_as_static_files(self):
        old_root = server.ROOT
        old_data_file = server.DATA_FILE
        try:
            site_root = Path(self.tempdir.name) / "private-site"
            site_root.mkdir(exist_ok=True)
            (site_root / "server-data.json").write_text("{}", encoding="utf-8")
            (site_root / "server-data.json.bak").write_text("{\"private\":true}", encoding="utf-8")
            server.ROOT = str(site_root)
            server.DATA_FILE = str(Path(self.tempdir.name) / "mounted" / "state.json")
            for path in ("/server-data.json", "/server-data.json.bak"):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(self.base + path, timeout=5)
                self.assertEqual(caught.exception.code, 404)
        finally:
            server.ROOT = old_root
            server.DATA_FILE = old_data_file

    def test_existing_latest_score_is_migrated_into_a_dated_archive(self):
        state = server.default_state()
        state["registrations"] = [{
            "id": "BR-LEGACY-1", "status": "Approved", "mode": "br", "roomId": "BR-SOLO-20-1",
            "teamName": "Legacy entry", "players": [{"ign": "Player One", "uid": "private"}],
            "finalScore": 13, "brMatches": [{"kills": 1, "position": 1, "score": 13}],
            "scoreUpdatedAt": "2026-10-07T20:00:00+00:00", "slotNumber": 1,
        }]
        server.save_state(state)
        migrated = server.load_state()
        self.assertEqual(len(migrated["matchHistory"]), 1)
        self.assertEqual(migrated["matchHistory"][0]["date"], "2026-10-08")
        self.assertEqual(server.public_state(migrated)["matchHistory"][0]["finalScore"], 13)

    def test_public_leaderboard_default_can_be_changed_and_is_persisted(self):
        saved = self.admin("/api/admin/leaderboard-settings", {"settings": {"defaultView": "all"}})
        self.assertEqual(saved["leaderboardSettings"]["defaultView"], "all")
        self.assertEqual(self.get_state()["leaderboardSettings"]["defaultView"], "all")
        self.admin("/api/admin/leaderboard-settings", {"settings": {"defaultView": "date"}}, 400)

    def test_storage_backup_can_restore_payment_settings_after_corruption(self):
        state = server.default_state()
        state["paymentSettings"]["upiId"] = "persist@bank"
        state["paymentSettings"]["qrDataUrl"] = PNG_DATA_URL
        server.save_state(state)
        updated = server.load_state()
        updated["paymentSettings"]["note"] = "Do not clear until changed"
        server.save_state(updated)
        with open(server.DATA_FILE, "w", encoding="utf-8") as damaged:
            damaged.write("not json")
        restored = server.load_state()
        self.assertEqual(restored["paymentSettings"]["upiId"], "persist@bank")
        self.assertEqual(restored["paymentSettings"]["qrDataUrl"], PNG_DATA_URL)
        self.assertEqual(restored["paymentSettings"]["note"], "")

    def test_persistent_data_directory_migrates_legacy_json_once(self):
        old_root = server.ROOT
        old_data_file = server.DATA_FILE
        try:
            legacy_dir = Path(self.tempdir.name) / "legacy"
            durable_dir = Path(self.tempdir.name) / "mounted-data"
            legacy_dir.mkdir(exist_ok=True)
            durable_dir.mkdir(exist_ok=True)
            legacy_state = server.default_state()
            legacy_state["paymentSettings"]["upiId"] = "legacy@bank"
            (legacy_dir / "server-data.json").write_text(json.dumps(legacy_state), encoding="utf-8")
            server.ROOT = str(legacy_dir)
            server.DATA_FILE = str(durable_dir / "server-data.json")
            migrated = server.load_state()
            self.assertEqual(migrated["paymentSettings"]["upiId"], "legacy@bank")
            self.assertTrue(Path(server.DATA_FILE).exists())
        finally:
            server.ROOT = old_root
            server.DATA_FILE = old_data_file

    def test_mongodb_backend_reads_and_writes_state_document(self):
        registration = {
            "id": "BR-MONGO-1", "status": "Pending", "mode": "br", "roomId": "BR-SOLO-20-1",
            "teamName": "Mongo entry", "players": [{"ign": "Mongo Player", "uid": "12345678"}],
            "playersPerEntry": 1, "fee": 20, "slotNumber": 1,
        }
        fake = FakeMongoCollection({"_id": "state", "registrations": [registration]})
        local_file_before = Path(server.DATA_FILE).read_text(encoding="utf-8")
        with patch.object(server, "MONGODB_URI", "mongodb://unit-test.invalid"), patch.object(server, "_MONGO_COLLECTION", fake), patch.object(server, "_MONGO_CLIENT", object()):
            state = server.load_state()
            self.assertEqual(state["registrations"][0]["id"], "BR-MONGO-1")
            summary = self.admin("/api/admin/summary", {})
            self.assertEqual(summary["registrations"][0]["teamName"], "Mongo entry")
            self.assertEqual(summary["storageInfo"]["backend"], "mongodb")
            self.assertTrue(summary["storageInfo"]["connected"])
            self.assertFalse(summary["storageInfo"]["mounted"])
            state["paymentSettings"]["payeeName"] = "Updated Organizer"
            server.save_state(state)
            self.assertEqual(fake.document["paymentSettings"]["payeeName"], "Updated Organizer")
            self.assertEqual(Path(server.DATA_FILE).read_text(encoding="utf-8"), local_file_before)

    def test_empty_mongodb_collection_migrates_existing_json_once(self):
        local_state = server.default_state()
        local_state["registrations"] = [{
            "id": "BR-LOCAL-MIGRATION", "status": "Pending", "mode": "br", "roomId": "BR-SOLO-20-1",
            "teamName": "Local entry", "players": [{"ign": "Player", "uid": "12345678"}],
            "playersPerEntry": 1, "fee": 20, "slotNumber": 1,
        }]
        Path(server.DATA_FILE).write_text(json.dumps(local_state), encoding="utf-8")
        fake = FakeMongoCollection()
        with patch.object(server, "MONGODB_URI", "mongodb://unit-test.invalid"), patch.object(server, "_MONGO_COLLECTION", fake), patch.object(server, "_MONGO_CLIENT", object()):
            loaded = server.load_state()
            self.assertEqual(loaded["registrations"][0]["id"], "BR-LOCAL-MIGRATION")
            self.assertEqual(fake.document["_id"], "state")
            self.assertEqual(fake.document["registrations"][0]["id"], "BR-LOCAL-MIGRATION")
            self.assertGreaterEqual(fake.replacements, 1)

    def test_mongodb_outage_returns_503_without_local_fallback(self):
        fake = FakeMongoCollection(fail=True)
        local_file_before = Path(server.DATA_FILE).read_text(encoding="utf-8")
        with patch.object(server, "MONGODB_URI", "mongodb://unit-test.invalid"), patch.object(server, "_MONGO_COLLECTION", fake), patch.object(server, "_MONGO_CLIENT", object()):
            req = urllib.request.Request(self.base + "/api/state")
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(req, timeout=5)
            self.assertEqual(caught.exception.code, 503)
            body = caught.exception.read().decode("utf-8")
            self.assertIn("no local fallback", body.lower())
            self.assertNotIn("unit-test.invalid", body)
            self.post("/api/register", {"id": "BR-OUTAGE", "roomId": "BR-SOLO-20-1"}, 503)
            self.assertEqual(Path(server.DATA_FILE).read_text(encoding="utf-8"), local_file_before)

    def test_room_qr_and_credentials_are_hidden_until_full_or_forced(self):
        self.register_br()
        self.admin("/api/admin/room-details", {"detail": {
            "roomId": "BR-SOLO-20-1", "customRoomId": "998877", "password": "secret",
            "roomQrDataUrl": PNG_DATA_URL, "published": True, "forcePublish": False,
        }})
        before = self.get_state()["roomDetails"]["BR-SOLO-20-1"]
        self.assertNotIn("customRoomId", before)
        self.assertNotIn("roomQrDataUrl", before)
        self.admin("/api/admin/room-count", {"roomId": "BR-SOLO-20-1", "count": 12})
        after = self.get_state()["roomDetails"]["BR-SOLO-20-1"]
        self.assertEqual(after["customRoomId"], "998877")
        self.assertEqual(after["roomQrDataUrl"], PNG_DATA_URL)

    def test_emoji_name_edits_and_registration_deletion(self):
        self.assertEqual(server.normalize_name("Team 👩‍🚀"), "Team 👩‍🚀")
        self.register_br()
        edited = self.admin("/api/admin/edit-registration", {
            "registrationId": "BR-TEST-1", "teamName": "⭐ <Team> 🏆",
            "iglName": "✨ Player One", "players": [{"ign": "✨ Player One", "uid": "12345678"}],
        })
        self.assertEqual(edited["registrations"][0]["teamName"], "⭐ <Team> 🏆")
        self.admin("/api/admin/delete-registration", {"registrationId": "BR-TEST-1"})
        result = self.post("/api/check-status", {"roomId": "BR-SOLO-20-1", "slotNumber": 1})
        self.assertFalse(result["found"])

    def test_cs_capacity_and_admin_session_is_enforced(self):
        roster = [
            {"ign": f"Player {index}", "uid": f"1234567{index}"}
            for index in range(1, 5)
        ]
        first = {"id": "CS-A", "mode": "cs", "playersPerEntry": 4, "players": roster, "roomId": "CS-NM-50-1", "teamName": "A", "whatsapp": "+91 9876543210", "paymentRef": "UTR-A", "acceptedRules": True}
        second = {"id": "CS-B", "mode": "cs", "playersPerEntry": 4, "players": roster, "roomId": "CS-NM-50-1", "teamName": "B", "whatsapp": "+91 9876543211", "paymentRef": "UTR-B", "acceptedRules": True}
        third = {"id": "CS-C", "mode": "cs", "playersPerEntry": 4, "players": roster, "roomId": "CS-NM-50-1", "teamName": "C", "whatsapp": "+91 9876543212", "paymentRef": "UTR-C", "acceptedRules": True}
        self.post("/api/register", first)
        self.post("/api/register", second)
        self.post("/api/register", third, 409)
        self.post("/api/check-status", {"roomId": "CS-NM-50-1", "slotNumber": 3}, 400)
        self.post("/api/admin/summary", {}, 401)

    def test_legacy_cs_metadata_and_historical_leaderboard_map_to_squad(self):
        state = server.default_state()
        state["registrations"] = [{
            "id": "CS-OLD", "mode": "cs", "modeLabel": "Clash Squad",
            "roomId": "CS-NM-50-1", "format": "solo", "formatLabel": "Solo",
            "playersPerEntry": 4, "players": [{"ign": f"Player {index}", "uid": "12345678"} for index in range(4)],
            "slotNumber": 1, "slotCapacity": 2, "status": "Approved", "teamName": "Legacy side",
            "feeRule": "per team", "fee": 50,
        }]
        state["matchHistory"] = [{
            "registrationId": "CS-OLD", "entryKey": "old-entry", "date": "2026-10-07",
            "mode": "cs", "roomId": "CS-NM-50-1", "format": "solo", "formatLabel": "Solo",
            "teamName": "Legacy side", "finalScore": 3,
        }]
        server.save_state(state)
        loaded = server.load_state()
        reg = loaded["registrations"][0]
        history = loaded["matchHistory"][0]
        self.assertEqual(reg["format"], "squad")
        self.assertEqual(reg["formatLabel"], "Squad · 4v4")
        self.assertEqual(reg["playersPerEntry"], 4)
        self.assertEqual(reg["feeRule"], "per registered side")
        self.assertEqual(history["formatLabel"], "Squad · 4v4")
        self.assertEqual(server.room_capacity(reg["roomId"]), 2)

    def test_size_specific_cs_rosters_and_legacy_squad_rooms(self):
        wrong_size = {
            "id": "CS-SOLO-BAD", "mode": "cs", "playersPerEntry": 2,
            "roomId": "CS-NM-SOLO-50-1", "teamName": "Too Many",
            "players": [
                {"ign": "Solo One", "uid": "12345678"},
                {"ign": "Solo Two", "uid": "12345679"},
            ], "whatsapp": "+91 9876543210", "paymentRef": "UTR-WRONG", "acceptedRules": True,
        }
        self.post("/api/register", wrong_size, 400)
        solo = {
            "id": "CS-SOLO-OK", "mode": "cs", "playersPerEntry": 1,
            "roomId": "CS-NM-SOLO-50-1", "teamName": "Solo One",
            "players": [{"ign": "Solo One", "uid": "12345678"}],
            "fee": 50, "whatsapp": "+91 9876543210", "paymentRef": "UTR-SOLO", "acceptedRules": True,
        }
        saved = self.post("/api/register", solo)["registration"]
        self.assertEqual(saved["slotCapacity"], 2)
        self.assertEqual(saved["format"], "solo")
        self.assertEqual(saved["formatLabel"], "Solo · 1v1")
        self.assertEqual(saved["playersPerEntry"], 1)
        self.assertEqual(saved["feeRule"], "per registered side")
        second = {**solo, "id": "CS-SOLO-SECOND", "teamName": "Solo Two", "players": [{"ign": "Solo Two", "uid": "12345679"}]}
        self.assertEqual(self.post("/api/register", second)["registration"]["slotNumber"], 2)
        third = {**solo, "id": "CS-SOLO-THIRD", "teamName": "Solo Three", "players": [{"ign": "Solo Three", "uid": "12345680"}]}
        self.post("/api/register", third, 409)

        legacy_squad = {
            "id": "CS-LEGACY-SQUAD", "mode": "cs", "playersPerEntry": 4,
            "roomId": "CS-NM-50-2", "teamName": "Legacy Squad", "players": [
                {"ign": f"Legacy {index}", "uid": f"2234567{index}"} for index in range(1, 5)
            ], "whatsapp": "+91 9876543211", "paymentRef": "UTR-LEGACY", "acceptedRules": True,
        }
        legacy = self.post("/api/register", legacy_squad)["registration"]
        self.assertEqual(legacy["format"], "squad")
        self.assertEqual(legacy["playersPerEntry"], 4)

    def test_admin_can_remove_saved_room_details(self):
        room_id = "BR-SOLO-20-1"
        self.admin("/api/admin/room-details", {"detail": {
            "roomId": room_id, "customRoomId": "998877", "password": "secret",
            "published": True, "forcePublish": True,
        }})
        removed = self.admin("/api/admin/delete-room-details", {"roomId": room_id})
        self.assertNotIn(room_id, removed["roomDetails"])
        self.assertNotIn(room_id, self.get_state()["roomDetails"])
        self.admin("/api/admin/delete-room-details", {"roomId": room_id}, 404)


    def test_admin_can_set_lobby_fee_from_free_to_110_and_apply_it_to_new_entries(self):
        self.register_br(registration_id="BR-FEE-OLD")
        self.assertEqual(server.load_state()["registrations"][0]["fee"], 20)
        saved = self.admin("/api/admin/lobby-fee", {"roomId": "BR-SOLO-20-1", "fee": 0})
        self.assertEqual(saved["roomFees"]["BR-SOLO-20-1"], 0)
        self.assertEqual(self.get_state()["roomFees"]["BR-SOLO-20-1"], 0)
        self.register_br(registration_id="BR-FEE-FREE", payment_ref="")
        saved_regs = server.load_state()["registrations"]
        self.assertEqual(saved_regs[0]["fee"], 0)
        self.assertEqual(saved_regs[0]["paymentRef"], "Free entry")
        self.assertEqual(saved_regs[1]["fee"], 20)
        self.assertFalse(server.payment_is_reported("Free entry"))

        cs_saved = self.admin("/api/admin/lobby-fee", {"roomId": "CS-NM-50-1", "fee": 110})
        self.assertEqual(cs_saved["roomFees"]["CS-NM-50-1"], 110)
        self.assertEqual(server.room_metadata("CS-NM-50-1", server.load_state()["roomFees"])["fee"], 110)

    def test_lobby_fee_rejects_values_outside_10_rupee_steps_and_unknown_rooms(self):
        self.assertTrue(all(server.valid_lobby_fee(fee) for fee in range(0, 111, 10)))
        for fee in (-10, 15, 120, True, "₹20"):
            with self.subTest(fee=fee):
                self.admin("/api/admin/lobby-fee", {"roomId": "BR-SOLO-20-1", "fee": fee}, 400)
        self.admin("/api/admin/lobby-fee", {"roomId": "BR-ADMIN-999-1", "fee": 20}, 400)
        self.assertEqual(server.load_state()["roomFees"], {})

    def test_admin_pin_comparison_and_input_bounds(self):
        self.assertTrue(server.verify_admin_pin("81263749", "81263749"))
        self.assertFalse(server.verify_admin_pin("81263748", "81263749"))
        self.assertFalse(server.verify_admin_pin("", "81263749"))
        self.assertFalse(server.verify_admin_pin("81263749", ""))
        self.assertFalse(server.verify_admin_pin(None, "81263749"))
        self.assertFalse(server.verify_admin_pin("x" * 257, "x" * 257))

    def test_render_config_declares_environment_pin_and_hash_generator_is_removed(self):
        config = (ROOT / "render.yaml").read_text(encoding="utf-8")
        self.assertIn("key: TOURNAMENT_ADMIN_PIN", config)
        self.assertNotIn("PASSWORD_HASH", config)
        self.assertFalse((ROOT / "generate_admin_hash.py").exists())

    def test_admin_login_issues_httponly_strict_cookie_and_csrf_is_required(self):
        result = self.login()
        self.assertTrue(result["csrfToken"])
        cookies = {cookie.name: cookie for cookie in self.cookie_jar}
        self.assertIn(server.SESSION_COOKIE_DEV_NAME, cookies)
        self.assertTrue(cookies[server.SESSION_COOKIE_DEV_NAME].has_nonstandard_attr("HttpOnly"))
        self.assertEqual(cookies[server.SESSION_COOKIE_DEV_NAME].get_nonstandard_attr("SameSite"), "Strict")
        self.post("/api/admin/summary", {}, 403)
        summary = self.admin("/api/admin/summary", {})
        self.assertIn("registrations", summary)
        self.admin("/api/admin/logout", {})
        self.csrf = None
        self.post("/api/admin/summary", {}, 401)

    def test_wrong_admin_pin_and_unconfigured_pin_fail_closed(self):
        self.post("/api/admin/login", {"pin": "incorrect-pin"}, 401)
        self.post("/api/admin/login", {"password": self.test_pin}, 401)
        old_pin = server.ADMIN_PIN
        try:
            server.ADMIN_PIN = ""
            self.post("/api/admin/login", {"pin": self.test_pin}, 503)
        finally:
            server.ADMIN_PIN = old_pin

    def test_cross_origin_writes_and_non_json_payloads_are_rejected(self):
        self.post("/api/check-status", {"roomId": "BR-SOLO-20-1", "slotNumber": 1}, 403,
                  headers={"Origin": "https://attacker.invalid"})
        self.post("/api/check-status", {"roomId": "BR-SOLO-20-1", "slotNumber": 1}, 400,
                  content_type="application/x-www-form-urlencoded")
        self.post("/api/check-status", [], 400)

    def test_admin_login_is_rate_limited(self):
        for _ in range(5):
            self.post("/api/admin/login", {"pin": "wrong"}, 401)
        self.post("/api/admin/login", {"pin": "wrong"}, 429)

    def test_server_thread_capacity_is_bounded(self):
        self.assertEqual(server.BoundedThreadingHTTPServer.max_concurrent_requests, 64)
        self.assertEqual(server.BoundedThreadingHTTPServer.request_queue_size, 64)
        self.assertTrue(server.BoundedThreadingHTTPServer.daemon_threads)
        self.assertTrue(hasattr(self.httpd, "_request_slots"))

    def test_cors_is_not_enabled_and_security_headers_are_present(self):
        with urllib.request.urlopen(self.base + "/", timeout=5) as response:
            self.assertEqual(response.status, 200)
            headers = response.headers
            self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
            self.assertEqual(headers.get("X-Frame-Options"), "DENY")
            self.assertIn("frame-ancestors 'none'", headers.get("Content-Security-Policy", ""))
            self.assertIn("script-src 'self'", headers.get("Content-Security-Policy", ""))
            self.assertEqual(headers.get("Referrer-Policy"), "strict-origin-when-cross-origin")
            self.assertEqual(headers.get("Cross-Origin-Resource-Policy"), "same-origin")
            self.assertIsNone(headers.get("Access-Control-Allow-Origin"))
        request = urllib.request.Request(self.base + "/api/state", method="OPTIONS", headers={"Origin": "https://attacker.invalid"})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(caught.exception.code, 405)
        self.assertIsNone(caught.exception.headers.get("Access-Control-Allow-Origin"))

    def test_admin_state_transfer_omits_room_credentials_and_is_documented_as_partial(self):
        source = (ROOT / "public" / "site.js").read_text(encoding="utf-8")
        export_section = source.split("function exportStateJson()", 1)[1].split("function importStateJson()", 1)[0]
        import_section = source.split("function importStateJson()", 1)[1].split("function resetAdminState()", 1)[0]
        self.assertNotIn("roomDetails", export_section)
        self.assertNotIn("roomFees", export_section)
        self.assertNotIn("incoming.roomDetails", import_section)
        self.assertNotIn("incoming.roomFees", import_section)
        admin_html = (ROOT / "public" / "admin.html").read_text(encoding="utf-8")
        self.assertIn("not a full backup", admin_html)
        self.assertIn("payment settings are excluded", admin_html)
        self.assertIn("lobby fee overrides are not included", admin_html)

    def test_admin_pages_have_refresh_controls_for_registration_retrieval(self):
        admin_html = (ROOT / "public" / "admin.html").read_text(encoding="utf-8")
        dashboard_html = (ROOT / "public" / "admin-dashboard.html").read_text(encoding="utf-8")
        source = (ROOT / "public" / "site.js").read_text(encoding="utf-8")
        self.assertIn('id="refresh-registrations"', admin_html)
        self.assertIn('id="dashboard-refresh"', dashboard_html)
        self.assertIn("refreshAdminRegistrations", source)
        self.assertIn("refreshDashboardRegistrations", source)
        self.assertIn('apiPost("/api/admin/summary", {})', source)

    def test_static_file_allowlist_hides_source_config_docs_and_runtime_state(self):
        for path in ("/README.md", "/render.yaml", "/requirements.txt", "/server.py", "/vercel.json", "/.vercelignore", "/.gitignore", "/.env", "/api/dispatch.py", "/tests/test_server_api.py", "/server-data.json", "/server-data.json.bak", "/%2e%2e/README.md"):
            with self.subTest(path=path), self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(self.base + path, timeout=5)
            self.assertEqual(caught.exception.code, 404)
        self.assertTrue((Path(server.DATA_FILE).parent / "server-data.json").exists())
        self.assertEqual(Path(server.DATA_FILE).stat().st_mode & 0o077, 0)

    def test_public_registration_uses_allowlisted_server_derived_fields(self):
        payload = {
            "id": "BR-SAFE-1", "roomId": "BR-SOLO-20-1", "playersPerEntry": 1,
            "players": [{"ign": "<img src=x onerror=alert(1)>", "uid": "12345678"}],
            "teamName": "<script>alert(1)</script>", "whatsapp": "+91 9876543210",
            "paymentRef": "UTR-SAFE", "acceptedRules": True,
            "status": "Approved", "fee": 999999, "finalScore": 9999,
            "brMatches": [{"kills": 99, "position": 1}], "roomDetails": {"secret": "do-not-store"},
        }
        response = self.post("/api/register", payload)
        self.assertEqual(response["registration"]["status"], "Pending")
        saved = server.load_state()["registrations"][0]
        self.assertEqual(saved["fee"], 20)
        self.assertNotIn("finalScore", saved)
        self.assertNotIn("brMatches", saved)
        self.assertNotIn("roomDetails", saved)
        self.assertEqual(saved["teamName"], "<script>alert(1)</script>")
        self.assertNotIn("whatsapp", response["state"].get("approvedTeams", [{}])[0] if response["state"].get("approvedTeams") else {})

    def test_invalid_rooms_and_missing_rule_acceptance_are_rejected(self):
        payload = {
            "id": "BR-BAD-1", "roomId": "BR-ADMIN-999-99", "playersPerEntry": 1,
            "players": [{"ign": "Player", "uid": "12345678"}],
            "teamName": "Player", "whatsapp": "+91 9876543210",
            "paymentRef": "UTR-1", "acceptedRules": True,
        }
        self.post("/api/register", payload, 400)
        payload["roomId"] = "BR-SOLO-20-1"
        payload.pop("acceptedRules")
        self.post("/api/register", payload, 400)


class VercelCompatibilityTests(unittest.TestCase):
    def test_vercel_rewrite_dispatch_preserves_query_and_rejects_unknown_routes(self):
        from api.dispatch import dispatch_target

        target = dispatch_target("/api/dispatch?__nith_vercel_path=%2Fapi%2Fadmin%2Flobby-fee&x=one&x=two")
        self.assertEqual(target, "/api/admin/lobby-fee?x=one&x=two")
        self.assertIsNone(dispatch_target("/api/dispatch"))
        self.assertIsNone(dispatch_target("/api/dispatch?__nith_vercel_path=%2FREADME.md"))
        self.assertIsNone(dispatch_target("/api/dispatch?__nith_vercel_path=%2Fapi%2Fstate&__nith_vercel_path=%2Fapi%2Fregister"))

    def test_vercel_dispatch_handler_reaches_existing_state_endpoint(self):
        from api.dispatch import handler

        with server._RATE_LOCK:
            server._RATE_BUCKETS.clear()
        httpd = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{httpd.server_address[1]}/api/dispatch?__nith_vercel_path=%2Fapi%2Fstate"
            with urllib.request.urlopen(url, timeout=5) as response:
                self.assertEqual(response.status, 200)
                state = json.loads(response.read().decode("utf-8"))
            self.assertIn("roomFees", state)
        finally:
            httpd.shutdown()
            thread.join(timeout=3)
            httpd.server_close()

    def test_vercel_requires_mongodb_and_never_uses_local_json(self):
        with patch.object(server, "VERCEL_RUNTIME", True), patch.object(server, "MONGODB_URI", ""):
            with self.assertRaises(server.StateStoreUnavailable):
                server.load_state()
            with self.assertRaises(server.StateStoreUnavailable):
                server.save_state(server.default_state())
            status = server.state_storage_info()
            self.assertEqual(status["backend"], "unconfigured")
            self.assertFalse(status["connected"])

    def test_vercel_stateless_cookie_restores_session_without_process_memory(self):
        from api.dispatch import handler

        secret = "s" * 48
        csrf = "csrf-token-that-is-long-enough-123456"
        with ExitStack() as patches:
            patches.enter_context(patch.object(server, "VERCEL_RUNTIME", True))
            patches.enter_context(patch.object(server, "MONGODB_URI", "mongodb://configured.example/state"))
            patches.enter_context(patch.object(server, "TOURNAMENT_SESSION_SECRET", secret))
            token = server.create_stateless_admin_session(csrf)
            httpd = server.BoundedThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{httpd.server_address[1]}/api/dispatch?__nith_vercel_path=%2Fapi%2Fadmin%2Fsession"
                request = urllib.request.Request(url, headers={
                    "Cookie": f"__Host-nith_admin={token}",
                    "X-Forwarded-Proto": "https",
                })
                with urllib.request.urlopen(request, timeout=5) as response:
                    body = json.loads(response.read().decode("utf-8"))
                self.assertTrue(body["ok"])
                self.assertEqual(body["csrfToken"], csrf)
            finally:
                httpd.shutdown()
                thread.join(timeout=3)
                httpd.server_close()

    def test_stateless_vercel_admin_session_is_signed_and_expires(self):
        secret = "v" * 48
        csrf = "csrf-token-that-is-long-enough-123456"
        token = server.create_stateless_admin_session(csrf, now=1_800_000_000, secret=secret)
        decoded = server.decode_stateless_admin_session(token, now=1_800_000_100, secret=secret)
        self.assertEqual(decoded["csrf"], csrf)
        self.assertTrue(decoded["stateless"])
        self.assertIsNone(server.decode_stateless_admin_session(token + "x", now=1_800_000_100, secret=secret))
        self.assertIsNone(server.decode_stateless_admin_session(token, now=1_800_000_000 + server.SESSION_TTL_SECONDS + 1, secret=secret))
        self.assertFalse(server.session_secret_is_valid("short"))

    def test_vercel_config_uses_public_output_and_one_api_function(self):
        config = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
        self.assertEqual(config["outputDirectory"], "public")
        self.assertEqual(len(config["rewrites"]), 1)
        self.assertEqual(config["rewrites"][0]["source"], "/api/:path*")
        self.assertEqual(config["rewrites"][0]["destination"], "/api/dispatch?__nith_vercel_path=/api/:path*")
        self.assertTrue((ROOT / "public" / "index.html").is_file())
        self.assertTrue((ROOT / "api" / "dispatch.py").is_file())
        self.assertIn("Content-Security-Policy", str(config["headers"]))


if __name__ == "__main__":
    unittest.main()
