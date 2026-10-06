const DATA = window.TOURNAMENT_DATA;
const STATE_KEY = "nithFreeFireTournamentStateV3";
let toastTimer;
let lastSummary = "";
let SERVER_AVAILABLE = false;
let SERVER_STATE = null;
let currentAdminPin = "";
let liveSyncTimer = null;
let ADMIN_REGISTRATIONS = [];

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

function defaultState() {
  return {
    registrations: [],
    roomOverrides: {},
    leaderboard: { br: [], cs: [] },
    notices: [],
    updatedAt: new Date().toISOString()
  };
}

function normalizeState(raw = {}) {
  const base = defaultState();
  return {
    ...base,
    ...raw,
    registrations: Array.isArray(raw.registrations) ? raw.registrations : [],
    registrationCounts: raw.registrationCounts || {},
    roomOverrides: raw.roomOverrides || {},
    roomDetails: raw.roomDetails || {},
    leaderboard: {
      br: Array.isArray(raw.leaderboard?.br) ? raw.leaderboard.br : [],
      cs: Array.isArray(raw.leaderboard?.cs) ? raw.leaderboard.cs : []
    },
    notices: Array.isArray(raw.notices) ? raw.notices : []
  };
}

function loadState() {
  if (SERVER_AVAILABLE && SERVER_STATE) return normalizeState(SERVER_STATE);
  try {
    return normalizeState(JSON.parse(localStorage.getItem(STATE_KEY) || "{}"));
  } catch (error) {
    console.warn("State parse failed", error);
    return defaultState();
  }
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
}

async function refreshStateFromServer() {
  try {
    const response = await fetch(`/api/state?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`State API ${response.status}`);
    SERVER_STATE = await response.json();
    SERVER_AVAILABLE = true;
    return true;
  } catch (error) {
    SERVER_AVAILABLE = false;
    return false;
  }
}

async function apiPost(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}


function published() {
  return DATA.publishedState || { roomOverrides: {}, leaderboard: { br: [], cs: [] }, notices: [] };
}

function getRooms({ mode, fee, variant, format } = {}) {
  return DATA.rooms.filter((room) => {
    if (mode && room.mode !== mode) return false;
    if (fee && Number(room.fee) !== Number(fee)) return false;
    if (variant && room.variant !== variant) return false;
    if (format && room.format !== format) return false;
    return true;
  });
}


function getFeeTiers(mode) {
  if (mode === "cs") return DATA.economics.csFeeTiers || DATA.economics.feeTiers;
  if (mode === "br") return DATA.economics.brFeeTiers || DATA.economics.feeTiers;
  return DATA.economics.feeTiers;
}

function getRoom(roomId) {
  return DATA.rooms.find((room) => room.id === roomId);
}

function localRegistrationsForRoom(roomId) {
  const state = loadState();
  return state.registrations.filter((entry) => entry.roomId === roomId && entry.localSlotHeld !== false);
}

function registrationCountForRoom(roomId) {
  const state = loadState();
  return Number(state.registrationCounts?.[roomId] || 0);
}

function getConfirmedBase(room) {
  const state = loadState();
  const pubOverrides = published().roomOverrides || {};
  const base = typeof pubOverrides[room.id] === "number" ? pubOverrides[room.id] : Number(room.confirmedTeams || 0);
  return typeof state.roomOverrides[room.id] === "number" ? state.roomOverrides[room.id] : base;
}

function getConfirmedTeams(room) {
  const baseConfirmed = getConfirmedBase(room);
  if (SERVER_AVAILABLE) {
    return Math.min(room.capacity, Math.max(0, baseConfirmed, registrationCountForRoom(room.id)));
  }
  const localHeld = localRegistrationsForRoom(room.id).length;
  return Math.min(room.capacity, Math.max(0, baseConfirmed + localHeld));
}

function slotsLeft(room) {
  return Math.max(0, room.capacity - getConfirmedTeams(room));
}

function roomStatus(room) {
  if (room.status === "closed") return { label: "Closed", className: "closed" };
  const left = slotsLeft(room);
  if (left <= 0) return { label: "Full", className: "full" };
  if (left <= Math.ceil(room.capacity / 3)) return { label: "Few left", className: "few" };
  return { label: "Open", className: "open" };
}

function formatFee(fee) {
  return `₹${Number(fee).toLocaleString("en-IN")}`;
}

function brProjectedPrize(fee) {
  return DATA.economics.brFullLobbyPrizeByTier[String(fee)] || Math.round(Number(fee) * 10);
}

function csProjectedPrize(fee) {
  return Math.max(Number(fee) * 2, 0);
}

function battleFormatById(formatId) {
  return (DATA.battleFormats || []).find((format) => format.id === formatId) || (DATA.battleFormats || [])[0];
}

function entryLabel(room, plural = true) {
  if (!room) return plural ? "entries" : "entry";
  if (room.mode === "cs") return plural ? "teams" : "team";
  if (room.playersPerEntry === 1) return plural ? "players" : "player";
  return plural ? "teams" : "team";
}

function feeRuleLabel(roomOrFormat) {
  const playersPerEntry = roomOrFormat?.playersPerEntry || 4;
  return playersPerEntry === 1 ? "per player" : "per team";
}

function populateFormatSelect(select, selectedFormat = "solo") {
  if (!select) return;
  select.innerHTML = (DATA.battleFormats || []).map((format) => `
    <option value="${format.id}" ${format.id === selectedFormat ? "selected" : ""}>${format.label} — ${format.playersPerEntry} player${format.playersPerEntry > 1 ? "s" : ""}</option>
  `).join("");
}

function updateDynamicRoster(form) {
  if (!form) return;
  const room = getRoom(new FormData(form).get("roomId"));
  const requiredPlayers = form.dataset.mode === "br" ? Number(room?.playersPerEntry || 1) : 4;
  const rosterHelp = form.querySelector("[data-roster-help]");
  if (rosterHelp) {
    if (form.dataset.mode === "br") {
      const formatLabel = room?.formatLabel || battleFormatById(room?.format)?.label || "selected format";
      rosterHelp.textContent = `${formatLabel} registration needs ${requiredPlayers} player${requiredPlayers > 1 ? "s" : ""}. Extra player rows are disabled automatically.`;
    } else {
      rosterHelp.textContent = "Clash Squad registration needs exactly 4 players.";
    }
  }
  $$("[data-player-row]", form).forEach((row) => {
    const index = Number(row.dataset.playerRow || 0);
    const active = index <= requiredPlayers;
    row.classList.toggle("hidden", !active);
    $$('input', row).forEach((input) => {
      input.disabled = !active;
      if (input.name?.endsWith("Ign") || input.name?.endsWith("Uid") || input.name?.endsWith("Name")) input.required = active;
    });
  });
}

async function pageInit() {
  await refreshStateFromServer();
  setupNavigation();
  renderGlobalEventText();
  renderNotices();
  renderPage();
  setupCommonRegistration();
  setupModal();
  startLiveSync();
}

function startLiveSync() {
  if (liveSyncTimer) clearInterval(liveSyncTimer);
  liveSyncTimer = setInterval(async () => {
    if (!SERVER_AVAILABLE) return;
    const page = document.body.dataset.page;
    const livePages = ["home", "leaderboard", "rooms", "dashboard", "schedule"];
    if (!livePages.includes(page)) return;
    const ok = await refreshStateFromServer();
    if (ok) {
      renderNotices();
      if (page === "dashboard" && currentAdminPin) {
        renderDashboardData().catch(() => {});
      } else {
        renderPage();
      }
    }
  }, 5000);
}

function setupNavigation() {
  const page = document.body.dataset.page;
  $$("[data-nav]").forEach((link) => {
    if (link.dataset.nav === page) link.classList.add("active");
  });
  const toggle = $(".menu-toggle");
  const nav = $(".main-nav");
  if (toggle && nav) {
    toggle.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
  }
}

function renderGlobalEventText() {
  $$('[data-event="name"]').forEach((el) => { el.textContent = DATA.event.name; });
  $$('[data-event="shortName"]').forEach((el) => { el.textContent = DATA.event.shortName; });
  $$('[data-event="dateText"]').forEach((el) => { el.textContent = DATA.event.dateText; });
  $$('[data-event="supportChannel"]').forEach((el) => { el.textContent = DATA.event.supportChannel; });
  $$('[data-event="disclaimer"]').forEach((el) => { el.textContent = DATA.event.disclaimer; });
}

function renderNotices() {
  const container = $("#notice-strip");
  if (!container) return;
  const state = loadState();
  const notices = [...(published().notices || []), ...(state.notices || [])];
  container.innerHTML = notices.map((notice) => `<span>${escapeHtml(notice)}</span>`).join("");
  container.innerHTML += container.innerHTML;
}

function renderPage() {
  const page = document.body.dataset.page;
  if (page === "home") renderHome();
  if (page === "clash") renderClashPage();
  if (page === "battle") renderBattlePage();
  if (page === "leaderboard") renderLeaderboardPage();
  if (page === "rooms") renderRoomDetailsPage();
  if (page === "schedule") renderSchedulePage();
  if (page === "admin") setupAdminPage();
  if (page === "dashboard") setupDashboardPage();
}

function renderHome() {
  const allFeeTiers = Array.from(new Set([...getFeeTiers("br"), ...getFeeTiers("cs")])).sort((a, b) => a - b);
  const totals = allFeeTiers.map((fee) => {
    const brRooms = getRooms({ mode: "br", fee });
    const csRooms = getRooms({ mode: "cs", fee });
    const brSlots = brRooms.reduce((sum, room) => sum + slotsLeft(room), 0);
    const csSlots = csRooms.reduce((sum, room) => sum + slotsLeft(room), 0);
    return { fee, brSlots, csSlots, brRooms: brRooms.length, csRooms: csRooms.length };
  });

  const summary = $("#home-slot-summary");
  if (summary) {
    const totalBr = totals.reduce((sum, row) => sum + row.brSlots, 0);
    const totalCs = totals.reduce((sum, row) => sum + row.csSlots, 0);
    summary.innerHTML = `
      <article><strong>${totalBr}</strong><span>Battle Royale player/team slots left</span></article>
      <article><strong>${totalCs}</strong><span>Clash Squad team slots left</span></article>
      <article><strong>${DATA.economics.roomsPerTier}</strong><span>Custom rooms per fee tier</span></article>
      <article><strong>Solo–Squad</strong><span>Battle Royale formats available</span></article>
    `;
  }

  const formatGrid = $("#home-format-grid");
  if (formatGrid) {
    formatGrid.innerHTML = (DATA.battleFormats || []).map((format) => {
      const rooms = getRooms({ mode: "br", format: format.id });
      const left = rooms.reduce((sum, room) => sum + slotsLeft(room), 0);
      return `
        <article class="format-card">
          <span>${format.label}</span>
          <h3>${format.playersPerEntry} player${format.playersPerEntry > 1 ? "s" : ""}</h3>
          <p>${escapeHtml(format.description)}</p>
          <strong>${left} slots left</strong>
          <a class="mini-link" href="battle-royale.html?format=${format.id}">Open ${format.label}</a>
        </article>
      `;
    }).join("");
  }

  const feeGrid = $("#home-fee-grid");
  if (feeGrid) {
    feeGrid.innerHTML = totals.map((row) => `
      <article class="fee-card">
        <div class="fee-card-top">
          <strong>${formatFee(row.fee)}</strong>
          <span>per entry/team</span>
        </div>
        <p>${row.brSlots > 0 ? `Battle Royale target reward pool: <b>${formatFee(brProjectedPrize(row.fee))}</b> when lobby conditions are met.` : `Clash Squad tier available from <b>${formatFee(row.fee)}</b>.`} Solo fee is per player; Duo/Trio/Squad and Clash Squad fee is per team.</p>
        <div class="mini-bars">
          <span>BR slots <b>${row.brSlots}</b></span>
          <span>CS slots <b>${row.csSlots}</b></span>
        </div>
        <div class="fee-actions">
          ${row.brSlots > 0 ? `<a href="battle-royale.html?fee=${row.fee}" class="mini-link">Battle Royale</a>` : `<span class="mini-link muted-link">No BR tier</span>`}
          ${row.csSlots > 0 ? `<a href="clash-squad.html?fee=${row.fee}" class="mini-link">Clash Squad</a>` : `<span class="mini-link muted-link">CS starts ₹50</span>`}
        </div>
      </article>
    `).join("");
  }
}


function renderClashPage() {
  const params = new URLSearchParams(location.search);
  const defaultFee = Number(params.get("fee")) || getFeeTiers("cs")[0];
  const tierFilter = $("#cs-tier-filter");
  const variantFilter = $("#cs-variant-filter");
  if (tierFilter) populateFeeSelect(tierFilter, defaultFee, "cs");
  if (variantFilter && !variantFilter.value) variantFilter.value = "Normal";

  const formVariant = $("#cs-form-variant");

  const rerender = () => {
    const fee = Number(tierFilter?.value || defaultFee);
    const variant = variantFilter?.value || formVariant?.value || "Normal";
    if (formVariant) formVariant.value = variant;
    renderRoomCards("#cs-room-grid", getRooms({ mode: "cs", fee, variant }));
    populateRoomSelect("#cs-room-select", getRooms({ mode: "cs", fee, variant }));
    renderModeStats("#cs-stats", getRooms({ mode: "cs", fee, variant }));
    const prize = $("#cs-prize-note");
    if (prize) prize.textContent = `${variant} Clash Squad ${formatFee(fee)} room: ${DATA.economics.csPrizeNote} Current full-room entry pool is ${formatFee(csProjectedPrize(fee))}.`;
  };

  tierFilter?.addEventListener("change", rerender);
  variantFilter?.addEventListener("change", rerender);
  formVariant?.addEventListener("change", () => {
    if (variantFilter) variantFilter.value = formVariant.value;
    rerender();
  });
  rerender();
}

function renderBattlePage() {
  const params = new URLSearchParams(location.search);
  const defaultFee = Number(params.get("fee")) || getFeeTiers("br")[0];
  const defaultFormat = params.get("format") || "solo";
  const tierFilter = $("#br-tier-filter");
  const formatFilter = $("#br-format-filter");
  const formFormat = $("#br-form-format");
  if (tierFilter) populateFeeSelect(tierFilter, defaultFee, "br");
  populateFormatSelect(formatFilter, defaultFormat);
  populateFormatSelect(formFormat, defaultFormat);

  const rerender = () => {
    const fee = Number(tierFilter?.value || defaultFee);
    const format = formatFilter?.value || formFormat?.value || defaultFormat;
    if (formFormat) formFormat.value = format;
    const rooms = getRooms({ mode: "br", fee, format });
    const formatInfo = battleFormatById(format);
    renderRoomCards("#br-room-grid", rooms);
    populateRoomSelect("#br-room-select", rooms);
    renderModeStats("#br-stats", rooms);
    renderFormatCards(format);
    const prize = $("#br-prize-note");
    if (prize) prize.textContent = `${formatInfo.label} Battle Royale ${formatFee(fee)} ${feeRuleLabel(formatInfo)}: target full-lobby reward pool ${formatFee(brProjectedPrize(fee))}. Final prize may vary according to confirmed entries/teams and payments.`;
    const roomSelect = $("#br-room-select");
    const brForm = $('[data-registration-form][data-mode="br"]');
    if (roomSelect) roomSelect.onchange = () => updateDynamicRoster(brForm);
    updateDynamicRoster(brForm);
  };

  tierFilter?.addEventListener("change", rerender);
  formatFilter?.addEventListener("change", rerender);
  formFormat?.addEventListener("change", () => {
    if (formatFilter) formatFilter.value = formFormat.value;
    rerender();
  });
  rerender();
}

function renderFormatCards(activeFormat) {
  const container = $("#br-format-cards");
  if (!container) return;
  container.innerHTML = (DATA.battleFormats || []).map((format) => {
    const rooms = getRooms({ mode: "br", format: format.id });
    const left = rooms.reduce((sum, room) => sum + slotsLeft(room), 0);
    return `
      <button class="format-card ${format.id === activeFormat ? "active" : ""}" type="button" data-format-choice="${format.id}">
        <span>${format.label}</span>
        <h3>${format.playersPerEntry} player${format.playersPerEntry > 1 ? "s" : ""}</h3>
        <p>${escapeHtml(format.description)}</p>
        <strong>${left} slots left</strong>
      </button>
    `;
  }).join("");
  $$('[data-format-choice]', container).forEach((button) => {
    button.addEventListener("click", () => {
      const selected = button.dataset.formatChoice;
      const filter = $("#br-format-filter");
      const formSelect = $("#br-form-format");
      if (filter) filter.value = selected;
      if (formSelect) formSelect.value = selected;
      filter?.dispatchEvent(new Event("change"));
    });
  });
}


function renderModeStats(selector, rooms) {
  const el = $(selector);
  if (!el) return;
  const totalCapacity = rooms.reduce((sum, room) => sum + room.capacity, 0);
  const totalConfirmed = rooms.reduce((sum, room) => sum + getConfirmedTeams(room), 0);
  const totalLeft = Math.max(0, totalCapacity - totalConfirmed);
  const sample = rooms[0];
  const label = sample ? entryLabel(sample) : "slots";
  el.innerHTML = `
    <article><strong>${rooms.length}</strong><span>Custom rooms</span></article>
    <article><strong>${totalCapacity}</strong><span>Total ${label}</span></article>
    <article><strong>${totalLeft}</strong><span>${label[0].toUpperCase() + label.slice(1)} left</span></article>
  `;
}


function populateFeeSelect(select, selectedFee, mode = "br") {
  if (!select) return;
  select.innerHTML = getFeeTiers(mode).map((fee) => `<option value="${fee}" ${Number(selectedFee) === fee ? "selected" : ""}>${formatFee(fee)}</option>`).join("");
}


function populateRoomSelect(selector, rooms) {
  const select = $(selector);
  if (!select) return;
  select.innerHTML = rooms.map((room) => {
    const left = slotsLeft(room);
    const status = roomStatus(room);
    const label = entryLabel(room);
    return `<option value="${room.id}" ${left <= 0 ? "disabled" : ""}>${room.title} — ${left}/${room.capacity} ${label} left (${status.label})</option>`;
  }).join("");
}

function renderRoomCards(selector, rooms) {
  const container = $(selector);
  if (!container) return;
  container.innerHTML = rooms.map((room) => {
    const confirmed = getConfirmedTeams(room);
    const left = slotsLeft(room);
    const status = roomStatus(room);
    const percent = Math.round((confirmed / room.capacity) * 100);
    const modeLabel = room.mode === "br" ? `${room.formatLabel || "Battle Royale"} Battle Royale` : `${room.variant} Clash Squad`;
    const prizeText = room.mode === "br" ? `Target reward ${formatFee(brProjectedPrize(room.fee))}` : `Entry pool ${formatFee(csProjectedPrize(room.fee))}+`;
    const label = entryLabel(room);
    return `
      <article class="room-card ${status.className}">
        <div class="room-card-head">
          <span class="status-pill ${status.className}">${status.label}</span>
          <b>${formatFee(room.fee)} ${feeRuleLabel(room)}</b>
        </div>
        <h3>${escapeHtml(room.title)}</h3>
        <p>${modeLabel} · ${room.matchCount} ${room.matchCount > 1 ? "matches" : "match"} · ${escapeHtml(room.rewardRule)}</p>
        <div class="slot-line"><span>${confirmed}/${room.capacity} ${label} confirmed/held</span><strong>${left} left</strong></div>
        <div class="progress"><i style="width:${percent}%"></i></div>
        <div class="room-meta">
          <span>${prizeText}</span>
          <span>ID: ${escapeHtml(room.id)}</span>
        </div>
      </article>
    `;
  }).join("");
}


function setupCommonRegistration() {
  $$("[data-registration-form]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const mode = form.dataset.mode;
      const data = readRegistrationForm(form, mode);
      const error = validateRegistration(data);
      if (error) {
        toast(error, true);
        return;
      }
      const result = await submitRegistration(data);
      lastSummary = buildRegistrationSummary(data);
      showSuccess(lastSummary, data);
      form.reset();
      await refreshStateFromServer();
      renderPage();
      updateDynamicRoster(form);
      toast(result.message || "Registration saved. Final slot needs admin confirmation.");
    });
  });
}

async function submitRegistration(data) {
  if (SERVER_AVAILABLE) {
    const result = await apiPost("/api/register", data);
    return { message: result.message || "Registration saved on live server." };
  }
  const state = loadState();
  state.registrations.unshift(data);
  saveState(state);
  return { message: "Registration saved on this device. Final slot needs admin confirmation." };
}

function readRegistrationForm(form, mode) {
  const fd = new FormData(form);
  const roomId = clean(fd.get("roomId"));
  const room = getRoom(roomId);
  const now = new Date();
  const requiredPlayers = mode === "br" ? Number(room?.playersPerEntry || 1) : 4;
  const iglName = clean(fd.get("iglName")) || clean(fd.get("p1Ign"));
  const iglUid = clean(fd.get("iglUid")) || clean(fd.get("p1Uid"));
  const players = [{ ign: iglName, uid: iglUid }];
  for (let index = 2; index <= requiredPlayers; index += 1) {
    players.push({
      ign: clean(fd.get(`p${index}Name`)) || clean(fd.get(`p${index}Ign`)),
      uid: clean(fd.get(`p${index}Uid`)),
      roll: ""
    });
  }
  const typedTeamName = clean(fd.get("teamName"));
  const fallbackTeamName = requiredPlayers === 1 ? iglName : (iglName ? `${iglName}'s Team` : "");
  return {
    id: generateRegistrationId(mode),
    mode,
    modeLabel: mode === "br" ? "Battle Royale" : "Clash Squad",
    format: room?.format || clean(fd.get("format")),
    formatLabel: room?.formatLabel || battleFormatById(room?.format || clean(fd.get("format")))?.label || "",
    playersPerEntry: requiredPlayers,
    roomId,
    roomTitle: room?.title || roomId,
    fee: Number(room?.fee || fd.get("feeTier") || 0),
    feeRule: feeRuleLabel(room || battleFormatById(clean(fd.get("format")))),
    variant: room?.variant || clean(fd.get("variant")),
    teamName: typedTeamName || fallbackTeamName,
    captainName: iglName,
    iglName,
    iglUid,
    whatsapp: clean(fd.get("whatsapp")),
    paymentRef: clean(fd.get("paymentRef")),
    players,
    acceptedRules: Boolean(fd.get("acceptedRules")),
    localSlotHeld: true,
    status: "Pending",
    submittedAt: now.toISOString(),
    submittedAtDisplay: now.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
  };
}


function validateRegistration(data) {
  if (!data.iglName || !data.iglUid || !data.whatsapp) return "Please enter IGL/player name, Free Fire ID, and WhatsApp number.";
  const digits = data.whatsapp.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 13) return "Enter a valid WhatsApp number.";
  const room = getRoom(data.roomId);
  if (!room) return "Please select an available room.";
  if (slotsLeft(room) <= 0) return "Selected room is full. Please choose another room.";
  const uidPattern = /^\d{6,15}$/;
  for (let i = 0; i < data.players.length; i += 1) {
    const player = data.players[i];
    if (!player.ign || !uidPattern.test(player.uid)) return `Enter valid IGN and numeric UID for Player ${i + 1}.`;
  }
  if (!data.paymentRef) return "Enter payment UTR/reference, or write 'Pay after confirmation'.";
  if (!data.acceptedRules) return "Please accept the rules before submitting.";
  return "";
}

function generateRegistrationId(mode) {
  const prefix = mode === "br" ? "BR" : "CS";
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(2, 12);
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${stamp}-${random}`;
}

function buildRegistrationSummary(data) {
  const players = data.players.map((player, index) => `${index + 1}. ${player.ign} | UID: ${player.uid}${player.roll ? ` | Roll: ${player.roll}` : ""}`).join("\n");
  const modeExtra = data.mode === "br" ? ` (${data.formatLabel || data.format || "Format"})` : (data.variant ? ` (${data.variant})` : "");
  return [
    DATA.event.name,
    `Registration ID: ${data.id}`,
    `Status: ${data.status}`,
    `Mode: ${data.modeLabel}${modeExtra}`,
    `Room: ${data.roomTitle} (${data.roomId})`,
    `Team/Entry Name: ${data.teamName}`,
    `IGL/Player: ${data.iglName || data.captainName} | ID: ${data.iglUid || "N/A"}`,
    `WhatsApp: ${data.whatsapp}`,
    `Entry Fee: ${formatFee(data.fee)} ${data.feeRule || "per entry/team"}`,
    `Payment Ref: ${data.paymentRef}`,
    "",
    `Players:\n${players}`,
    "",
    `Submitted: ${data.submittedAtDisplay}`,
    "Note: Final slot is confirmed only after organizer verification."
  ].join("\n");
}


function setupModal() {
  const modal = $("#success-modal");
  if (!modal) return;
  $("#modal-close")?.addEventListener("click", () => modal.close());
  $("#copy-summary")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(lastSummary);
      toast("Summary copied.");
    } catch {
      toast("Copy failed. Select and copy manually.", true);
    }
  });
}

function showSuccess(summary, data) {
  const modal = $("#success-modal");
  const text = $("#success-text");
  const box = $("#summary-box");
  const whatsapp = $("#whatsapp-link");
  if (text) text.textContent = `Registration ${data.id} was saved locally. Send this summary to the organizer if required.`;
  if (box) box.textContent = summary;
  if (whatsapp) {
    if (DATA.event.whatsappNumber) {
      whatsapp.href = `https://wa.me/${DATA.event.whatsappNumber}?text=${encodeURIComponent(summary)}`;
      whatsapp.classList.remove("hidden");
    } else {
      whatsapp.classList.add("hidden");
    }
  }
  if (modal && typeof modal.showModal === "function") modal.showModal();
  else alert(summary);
}

function renderLeaderboardPage() {
  renderLeaderboards("#br-leaderboard", "br");
  renderLeaderboards("#cs-leaderboard", "cs");
}

function getLeaderboard(mode) {
  const state = loadState();
  const pub = published().leaderboard?.[mode] || [];
  const local = state.leaderboard?.[mode] || [];
  return [...pub, ...local];
}

function brTotal(row) {
  return Number(row.placementPoints || 0) + Number(row.kills || 0) * DATA.scoring.br.killPoint - Number(row.penalty || 0);
}

function csTotal(row) {
  return Number(row.wins || 0) * DATA.scoring.cs.winPoint + Number(row.draws || 0) - Number(row.penalty || 0);
}

function renderLeaderboards(selector, mode) {
  const container = $(selector);
  if (!container) return;
  const rows = getLeaderboard(mode).sort((a, b) => {
    if (mode === "br") return brTotal(b) - brTotal(a) || Number(b.kills || 0) - Number(a.kills || 0);
    return csTotal(b) - csTotal(a) || Number(b.roundDiff || 0) - Number(a.roundDiff || 0);
  });

  if (!rows.length) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>No ${mode === "br" ? "Battle Royale" : "Clash Squad"} results yet</h3>
        <p>The leaderboard will update after teams are confirmed and match results are verified by admins.</p>
      </div>
    `;
    return;
  }

  const tableRows = rows.map((row, index) => {
    if (mode === "br") {
      return `<tr class="${index < 3 ? "top-row" : ""}">
        <td>#${index + 1}</td><td>${escapeHtml(row.teamName)}</td><td>${escapeHtml(row.formatLabel || row.format || "Squad")}</td><td>${formatFee(row.fee || row.tier || 0)}</td><td>${escapeHtml(row.roomId || "-")}</td><td>${Number(row.matchesPlayed || 0)}</td><td>${Number(row.booyah || 0)}</td><td>${Number(row.placementPoints || 0)}</td><td>${Number(row.kills || 0)}</td><td>${Number(row.penalty || 0)}</td><td><b>${brTotal(row)}</b></td>
      </tr>`;
    }
    return `<tr class="${index === 0 ? "top-row" : ""}">
      <td>#${index + 1}</td><td>${escapeHtml(row.teamName)}</td><td>${escapeHtml(row.variant || "Normal")}</td><td>${formatFee(row.fee || row.tier || 0)}</td><td>${escapeHtml(row.roomId || "-")}</td><td>${Number(row.wins || 0)}-${Number(row.losses || 0)}</td><td>${Number(row.roundDiff || 0)}</td><td>${Number(row.penalty || 0)}</td><td><b>${csTotal(row)}</b></td>
    </tr>`;
  }).join("");

  if (mode === "br") {
    container.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Rank</th><th>Entry/Team</th><th>Format</th><th>Fee</th><th>Lobby</th><th>Matches</th><th>Booyah</th><th>Placement</th><th>Kills</th><th>Penalty</th><th>Total</th></tr></thead><tbody>${tableRows}</tbody></table></div>`;
  } else {
    container.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Rank</th><th>Team</th><th>Type</th><th>Fee</th><th>Room</th><th>W-L</th><th>Round Diff</th><th>Penalty</th><th>Total</th></tr></thead><tbody>${tableRows}</tbody></table></div>`;
  }
}


function renderRoomDetailsPage() {
  const container = $("#room-details-grid");
  if (!container) return;
  const state = loadState();
  const details = state.roomDetails || {};
  const publishedRooms = Object.values(details).filter((detail) => detail && detail.published);
  if (!publishedRooms.length) {
    container.innerHTML = `<div class="empty-state"><h3>No room details released yet</h3><p>Room ID and password will appear here after the admin releases them. Refresh is automatic every few seconds in live server mode.</p></div>`;
    return;
  }
  container.innerHTML = publishedRooms.map((detail) => {
    const room = getRoom(detail.roomId);
    const complete = room ? slotsLeft(room) <= 0 : false;
    const canShow = detail.forcePublish || complete;
    return `
      <article class="room-card ${canShow ? "open" : "few"}">
        <div class="room-card-head"><span class="status-pill ${canShow ? "open" : "few"}">${canShow ? "Released" : "Waiting for full room"}</span><b>${escapeHtml(detail.roomId)}</b></div>
        <h3>${escapeHtml(room?.title || detail.roomId)}</h3>
        <p>${canShow ? "Use these details to join the custom room." : "Admin has prepared the room details. They will be visible once the room/lobby is complete or admin forces release."}</p>
        ${canShow ? `<div class="note-box"><p><b>Room ID:</b> ${escapeHtml(detail.customRoomId)}</p><p><b>Password:</b> ${escapeHtml(detail.password)}</p><p>${escapeHtml(detail.message || "Join on time and do not share details outside registered players.")}</p></div>` : ""}
        <div class="room-meta"><span>${room ? `${getConfirmedTeams(room)}/${room.capacity} ${entryLabel(room)} confirmed` : "Room status unavailable"}</span><span>Updated ${new Date(detail.updatedAt || Date.now()).toLocaleString("en-IN")}</span></div>
      </article>
    `;
  }).join("");
}

function setupDashboardPage() {
  const unlock = $("#dashboard-unlock");
  const pin = $("#dashboard-pin");
  const panel = $("#dashboard-panel");
  if (!unlock || !panel) return;
  unlock.addEventListener("click", async () => {
    currentAdminPin = pin.value.trim();
    try {
      await renderDashboardData();
      panel.classList.remove("hidden");
      toast("Dashboard unlocked.");
    } catch (error) {
      toast("Wrong admin PIN or server unavailable.", true);
    }
  });
}

async function renderDashboardData() {
  if (!SERVER_AVAILABLE) throw new Error("Live server unavailable");
  const summary = await apiPost("/api/admin/summary", { pin: currentAdminPin });
  renderAdminSummaryCards(summary);
  const table = $("#dashboard-registrations");
  if (table) {
    const regs = summary.registrations || [];
    table.innerHTML = regs.length ? `<div class="table-wrap"><table><thead><tr><th>Status</th><th>ID</th><th>Mode</th><th>Format</th><th>Room</th><th>Entry/Team</th><th>IGL/Player</th><th>Player details</th><th>WhatsApp</th><th>Fee</th><th>Payment</th></tr></thead><tbody>${regs.map((r) => `<tr><td>${registrationStatusBadge(r.status)}</td><td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.modeLabel)}</td><td>${escapeHtml(r.formatLabel || r.variant || "-")}</td><td>${escapeHtml(r.roomId)}</td><td>${escapeHtml(r.teamName)}</td><td>${escapeHtml(r.iglName || r.captainName)}</td><td>${playerListHtml(r)}</td><td>${escapeHtml(r.whatsapp)}</td><td>${formatFee(r.fee)}</td><td>${escapeHtml(r.paymentRef || "-")}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><h3>No registrations yet</h3><p>Registrations will appear live here.</p></div>`;
  }
}

function renderSchedulePage() {
  const container = $("#schedule-list");
  if (!container) return;
  container.innerHTML = DATA.schedule.map((item, index) => `
    <article class="timeline-card">
      <span>${String(index + 1).padStart(2, "0")}</span>
      <div><b>${escapeHtml(item.time)}</b><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.detail)}</p></div>
    </article>
  `).join("");
}

function setupAdminPage() {
  const unlock = $("#admin-unlock");
  const pin = $("#admin-pin");
  const panel = $("#admin-panel");
  if (!unlock || !panel) return;

  unlock.addEventListener("click", async () => {
    const enteredPin = pin.value.trim();
    if (SERVER_AVAILABLE) {
      try {
        await apiPost("/api/admin/summary", { pin: enteredPin });
        currentAdminPin = enteredPin;
        panel.classList.remove("hidden");
        renderAdminPanel();
        toast("Admin controls unlocked. Live server mode is active.");
        return;
      } catch (error) {
        toast("Wrong admin PIN.", true);
        return;
      }
    }
    if (enteredPin !== DATA.event.adminPin) {
      toast("Wrong admin PIN.", true);
      return;
    }
    currentAdminPin = enteredPin;
    panel.classList.remove("hidden");
    renderAdminPanel();
    toast("Admin controls unlocked on this device.");
  });

  setupAdminListeners();
}


function setupAdminListeners() {
  $("#admin-mode")?.addEventListener("change", () => { const mode = $("#admin-mode")?.value || "br"; populateFeeSelect($("#admin-fee"), getFeeTiers(mode)[0], mode); updateAdminRoomChoices(); });
  $("#admin-fee")?.addEventListener("change", updateAdminRoomChoices);
  $("#admin-format")?.addEventListener("change", updateAdminRoomChoices);
  $("#admin-variant")?.addEventListener("change", updateAdminRoomChoices);
  $("#save-room-count")?.addEventListener("click", saveAdminRoomCount);
  $("#save-leaderboard")?.addEventListener("click", saveAdminLeaderboardEntry);
  $("#admin-lb-mode")?.addEventListener("change", updateLeaderboardFormMode);
  $("#admin-lb-registration")?.addEventListener("change", (event) => applyApprovedRegistrationToLeaderboard(event.target.value));
  $("#export-registrations")?.addEventListener("click", exportRegistrationsCsv);
  $("#clear-registrations")?.addEventListener("click", clearRegistrations);
  $("#export-state")?.addEventListener("click", exportStateJson);
  $("#import-state")?.addEventListener("click", importStateJson);
  $("#reset-admin-state")?.addEventListener("click", resetAdminState);
  $("#room-share-mode")?.addEventListener("change", updateRoomShareChoices);
  $("#room-share-fee")?.addEventListener("change", updateRoomShareChoices);
  $("#room-share-format")?.addEventListener("change", updateRoomShareChoices);
  $("#room-share-variant")?.addEventListener("change", updateRoomShareChoices);
  $("#save-room-details")?.addEventListener("click", saveRoomDetails);
}

function renderAdminPanel() {
  populateFeeSelect($("#admin-fee"), getFeeTiers("br")[0], "br");
  populateFormatSelect($("#admin-format"), "solo");
  updateAdminRoomChoices();
  updateRoomShareChoices();
  updateLeaderboardFormMode();
  renderAdminTables();
}

function updateAdminRoomChoices() {
  const mode = $("#admin-mode")?.value || "br";
  const fee = Number($("#admin-fee")?.value || getFeeTiers(mode)[0]);
  const variantWrap = $("#admin-variant-wrap");
  const formatWrap = $("#admin-format-wrap");
  const variant = $("#admin-variant")?.value || "Normal";
  const format = $("#admin-format")?.value || "solo";
  if (variantWrap) variantWrap.classList.toggle("hidden", mode !== "cs");
  if (formatWrap) formatWrap.classList.toggle("hidden", mode !== "br");
  const rooms = getRooms({
    mode,
    fee,
    variant: mode === "cs" ? variant : undefined,
    format: mode === "br" ? format : undefined
  });
  const select = $("#admin-room");
  if (!select) return;
  select.innerHTML = rooms.map((room) => `<option value="${room.id}">${room.title} (${getConfirmedBase(room)}/${room.capacity} ${entryLabel(room)} confirmed)</option>`).join("");
  const selectedRoom = getRoom(select.value || rooms[0]?.id);
  const count = $("#admin-confirmed-count");
  if (selectedRoom && count) count.value = getConfirmedBase(selectedRoom);
  select.onchange = () => {
    const room = getRoom(select.value);
    if (room && count) count.value = getConfirmedBase(room);
  };
}


async function saveAdminRoomCount() {
  const roomId = $("#admin-room")?.value;
  const room = getRoom(roomId);
  if (!room) return toast("Select a room first.", true);
  const count = Number($("#admin-confirmed-count")?.value || 0);
  if (count < 0 || count > room.capacity) return toast(`Count must be between 0 and ${room.capacity}.`, true);
  if (SERVER_AVAILABLE && currentAdminPin) {
    await apiPost("/api/admin/room-count", { pin: currentAdminPin, roomId: room.id, count });
    await refreshStateFromServer();
    renderAdminTables();
    renderPage();
    toast("Room count updated live for everyone.");
    return;
  }
  const state = loadState();
  state.roomOverrides[room.id] = count;
  saveState(state);
  renderAdminTables();
  renderPage();
  toast("Room count updated locally. Export/publish state for players to see it globally.");
}

function updateLeaderboardFormMode() {
  const mode = $("#admin-lb-mode")?.value || "br";
  $$("[data-lb-field]").forEach((field) => {
    const showFor = field.dataset.lbField;
    field.classList.toggle("hidden", showFor !== mode && showFor !== "both");
  });
}

async function saveAdminLeaderboardEntry() {
  const mode = $("#admin-lb-mode")?.value || "br";
  const teamName = clean($("#admin-lb-team")?.value);
  if (!teamName) return toast("Enter team name.", true);
  const common = {
    id: `LB-${Date.now()}`,
    teamName,
    fee: Number($("#admin-lb-fee")?.value || 20),
    roomId: clean($("#admin-lb-room")?.value),
    updatedAt: new Date().toISOString()
  };
  let entry;
  if (mode === "br") {
    const format = $("#admin-lb-brformat")?.value || "squad";
    const formatInfo = battleFormatById(format);
    entry = {
      ...common,
      format,
      formatLabel: formatInfo?.label || format,
      matchesPlayed: Number($("#admin-lb-matches")?.value || 0),
      booyah: Number($("#admin-lb-booyah")?.value || 0),
      placementPoints: Number($("#admin-lb-placement")?.value || 0),
      kills: Number($("#admin-lb-kills")?.value || 0),
      penalty: Number($("#admin-lb-penalty")?.value || 0)
    };
  } else {
    entry = {
      ...common,
      variant: $("#admin-lb-variant")?.value || "Normal",
      wins: Number($("#admin-lb-wins")?.value || 0),
      losses: Number($("#admin-lb-losses")?.value || 0),
      roundDiff: Number($("#admin-lb-rounddiff")?.value || 0),
      penalty: Number($("#admin-lb-penalty")?.value || 0)
    };
  }

  if (SERVER_AVAILABLE && currentAdminPin) {
    await apiPost("/api/admin/leaderboard", { pin: currentAdminPin, mode, entry });
    await refreshStateFromServer();
    renderAdminTables();
    renderLeaderboards("#admin-br-preview", "br");
    renderLeaderboards("#admin-cs-preview", "cs");
    toast("Leaderboard entry published live.");
    return;
  }

  const state = loadState();
  state.leaderboard[mode].push(entry);
  saveState(state);
  renderAdminTables();
  renderLeaderboards("#admin-br-preview", "br");
  renderLeaderboards("#admin-cs-preview", "cs");
  toast("Leaderboard entry saved locally.");
}


function updateRoomShareChoices() {
  populateFeeSelect($("#room-share-fee"), Number($("#room-share-fee")?.value || getFeeTiers("br")[0]), $("#room-share-mode")?.value || "br");
  populateFormatSelect($("#room-share-format"), $("#room-share-format")?.value || "solo");
  const mode = $("#room-share-mode")?.value || "br";
  const fee = Number($("#room-share-fee")?.value || getFeeTiers(mode)[0]);
  const formatWrap = $("#room-share-format-wrap");
  const variantWrap = $("#room-share-variant-wrap");
  const format = $("#room-share-format")?.value || "solo";
  const variant = $("#room-share-variant")?.value || "Normal";
  formatWrap?.classList.toggle("hidden", mode !== "br");
  variantWrap?.classList.toggle("hidden", mode !== "cs");
  const rooms = getRooms({ mode, fee, format: mode === "br" ? format : undefined, variant: mode === "cs" ? variant : undefined });
  const select = $("#room-share-room");
  if (!select) return;
  select.innerHTML = rooms.map((room) => `<option value="${room.id}">${room.title} (${getConfirmedTeams(room)}/${room.capacity} ${entryLabel(room)})</option>`).join("");
}

async function saveRoomDetails() {
  const roomId = $("#room-share-room")?.value;
  const customRoomId = clean($("#custom-room-id")?.value);
  const password = clean($("#custom-room-password")?.value);
  const message = clean($("#custom-room-message")?.value);
  const forcePublish = Boolean($("#room-force-publish")?.checked);
  const published = Boolean($("#room-published")?.checked);
  if (!roomId || !customRoomId || !password) return toast("Select room and enter room ID plus password.", true);
  const detail = { roomId, customRoomId, password, message, forcePublish, published, updatedAt: new Date().toISOString() };
  if (SERVER_AVAILABLE && currentAdminPin) {
    await apiPost("/api/admin/room-details", { pin: currentAdminPin, detail });
    await refreshStateFromServer();
    toast("Room ID/password published live according to your release settings.");
    return;
  }
  const state = loadState();
  state.roomDetails[roomId] = detail;
  saveState(state);
  toast("Room details saved locally.");
}

async function renderAdminTables() {
  let state = loadState();
  let summaryForCards = null;
  if (SERVER_AVAILABLE && currentAdminPin) {
    try {
      const summary = await apiPost("/api/admin/summary", { pin: currentAdminPin });
      summaryForCards = summary;
      state = normalizeState({ ...loadState(), registrations: summary.registrations || [] });
      ADMIN_REGISTRATIONS = summary.registrations || [];
      renderAdminSummaryCards(summary);
    } catch (error) {
      toast(error.message || "Could not load admin summary.", true);
    }
  } else {
    ADMIN_REGISTRATIONS = state.registrations || [];
    summaryForCards = {
      totalEntries: ADMIN_REGISTRATIONS.length,
      pendingEntries: ADMIN_REGISTRATIONS.filter((r) => String(r.status || "Pending").toLowerCase() === "pending").length,
      approvedEntries: ADMIN_REGISTRATIONS.filter((r) => String(r.status || "").toLowerCase() === "approved").length,
      approvedPlayers: ADMIN_REGISTRATIONS.filter((r) => String(r.status || "").toLowerCase() === "approved").reduce((sum, r) => sum + Number(r.playersPerEntry || r.players?.length || 0), 0),
      approvedReportedPaidAmount: ADMIN_REGISTRATIONS.filter((r) => String(r.status || "").toLowerCase() === "approved" && r.paymentRef).reduce((sum, r) => sum + Number(r.fee || 0), 0),
      approvedExpectedAmount: ADMIN_REGISTRATIONS.filter((r) => String(r.status || "").toLowerCase() === "approved").reduce((sum, r) => sum + Number(r.fee || 0), 0)
    };
    renderAdminSummaryCards(summaryForCards);
  }

  updateApprovedTeamSelect();

  const regs = $("#admin-registrations");
  if (regs) {
    if (!state.registrations.length) {
      regs.innerHTML = `<div class="empty-state"><h3>No registrations yet</h3><p>Live registrations will appear here after players submit forms.</p></div>`;
    } else {
      regs.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Status</th><th>Actions</th><th>ID</th><th>Mode</th><th>Format/Type</th><th>Room</th><th>Team/Entry</th><th>IGL/Player</th><th>Players</th><th>WhatsApp</th><th>Fee</th><th>Payment Ref</th><th>Time</th></tr></thead><tbody>${state.registrations.map((r) => `
        <tr>
          <td>${registrationStatusBadge(r.status)}</td>
          <td class="admin-row-actions">
            <button class="btn small" type="button" data-reg-action="Approved" data-reg-id="${escapeHtml(r.id)}">Approve</button>
            <button class="btn small ghost danger" type="button" data-reg-action="Rejected" data-reg-id="${escapeHtml(r.id)}">Reject</button>
          </td>
          <td>${escapeHtml(r.id)}</td>
          <td>${escapeHtml(r.modeLabel)}</td>
          <td>${escapeHtml(r.formatLabel || r.variant || "-")}</td>
          <td>${escapeHtml(r.roomId)}</td>
          <td>${escapeHtml(r.teamName)}</td>
          <td>${escapeHtml(r.iglName || r.captainName)}<br><small>${escapeHtml(r.iglUid || r.players?.[0]?.uid || "")}</small></td>
          <td>${playerListHtml(r)}</td>
          <td>${escapeHtml(r.whatsapp)}</td>
          <td>${formatFee(r.fee)}</td>
          <td>${escapeHtml(r.paymentRef || "-")}</td>
          <td>${escapeHtml(r.submittedAtDisplay || "-")}</td>
        </tr>`).join("")}</tbody></table></div>`;
      $$('[data-reg-action]', regs).forEach((button) => {
        button.addEventListener("click", () => updateRegistrationStatus(button.dataset.regId, button.dataset.regAction));
      });
    }
  }
  renderLeaderboards("#admin-br-preview", "br");
  renderLeaderboards("#admin-cs-preview", "cs");
}

function updateApprovedTeamSelect() {
  const select = $("#admin-lb-registration");
  if (!select) return;
  const approved = ADMIN_REGISTRATIONS.filter((r) => String(r.status || "").toLowerCase() === "approved");
  select.innerHTML = `<option value="">Select approved team/player</option>` + approved.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.teamName)} — ${escapeHtml(r.formatLabel || r.variant || r.modeLabel)} — ${escapeHtml(r.roomId)}</option>`).join("");
}

async function updateRegistrationStatus(registrationId, status) {
  if (!registrationId) return;
  if (SERVER_AVAILABLE && currentAdminPin) {
    await apiPost("/api/admin/registration-status", { pin: currentAdminPin, registrationId, status });
    await refreshStateFromServer();
    await renderAdminTables();
    renderPage();
    toast(`Registration marked ${status}. Public slots updated live.`);
    return;
  }
  const state = loadState();
  const reg = state.registrations.find((r) => r.id === registrationId);
  if (reg) reg.status = status;
  saveState(state);
  await renderAdminTables();
  renderPage();
  toast(`Registration marked ${status} locally.`);
}

function applyApprovedRegistrationToLeaderboard(registrationId) {
  const reg = ADMIN_REGISTRATIONS.find((r) => r.id === registrationId);
  if (!reg) return;
  const mode = reg.mode || (reg.modeLabel === "Battle Royale" ? "br" : "cs");
  const modeSelect = $("#admin-lb-mode");
  if (modeSelect) modeSelect.value = mode;
  updateLeaderboardFormMode();
  if ($("#admin-lb-team")) $("#admin-lb-team").value = reg.teamName || "";
  if ($("#admin-lb-fee")) $("#admin-lb-fee").value = reg.fee || 0;
  if ($("#admin-lb-room")) $("#admin-lb-room").value = reg.roomId || "";
  if (mode === "br" && $("#admin-lb-brformat")) $("#admin-lb-brformat").value = reg.format || "squad";
  if (mode === "cs" && $("#admin-lb-variant")) $("#admin-lb-variant").value = reg.variant || "Normal";
  toast("Approved registration loaded into leaderboard form. Now enter score/kills/wins and save.");
}


function renderAdminSummaryCards(summary) {
  const box = $("#admin-live-summary");
  if (!box || !summary) return;
  box.innerHTML = `
    <article><strong>${summary.totalEntries || 0}</strong><span>Total registrations</span></article>
    <article><strong>${summary.pendingEntries || 0}</strong><span>Pending approval</span></article>
    <article><strong>${summary.approvedEntries || 0}</strong><span>Approved entries/teams</span></article>
    <article><strong>${summary.approvedPlayers || 0}</strong><span>Approved players</span></article>
    <article><strong>${formatFee(summary.approvedReportedPaidAmount || 0)}</strong><span>Reported paid by approved entries</span></article>
    <article><strong>${formatFee(summary.approvedExpectedAmount || 0)}</strong><span>Expected from approved entries</span></article>
  `;
}

function registrationStatusBadge(status) {
  const value = String(status || "Pending");
  const key = value.toLowerCase();
  const cls = key === "approved" ? "open" : key === "rejected" ? "closed" : "few";
  return `<span class="status-pill ${cls}">${escapeHtml(value)}</span>`;
}

function playerListHtml(reg) {
  const players = Array.isArray(reg.players) ? reg.players : [];
  if (!players.length) return "-";
  return players.map((player, index) => `${index + 1}. ${escapeHtml(player.ign || "-")} / ${escapeHtml(player.uid || "-")}`).join("<br>");
}


async function exportRegistrationsCsv() {
  let state = loadState();
  if (SERVER_AVAILABLE && currentAdminPin) {
    const summary = await apiPost("/api/admin/summary", { pin: currentAdminPin });
    state = normalizeState({ ...state, registrations: summary.registrations || [] });
  }
  if (!state.registrations.length) return toast("No registrations to export.", true);
  const headers = ["id", "mode", "formatOrType", "playersPerEntry", "roomId", "fee", "feeRule", "teamName", "iglName", "iglUid", "whatsapp", "paymentRef", "submittedAt", "p1Name", "p1Uid", "p2Name", "p2Uid", "p3Name", "p3Uid", "p4Name", "p4Uid"];
  const rows = state.registrations.map((r) => {
    const flat = {
      id: r.id, mode: r.modeLabel, formatOrType: r.formatLabel || r.variant || "", playersPerEntry: r.playersPerEntry || "", roomId: r.roomId, fee: r.fee, feeRule: r.feeRule || "", teamName: r.teamName, iglName: r.iglName || r.captainName, iglUid: r.iglUid || r.players?.[0]?.uid, whatsapp: r.whatsapp, paymentRef: r.paymentRef, submittedAt: r.submittedAt,
      p1Name: r.players?.[0]?.ign, p1Uid: r.players?.[0]?.uid, p2Name: r.players?.[1]?.ign, p2Uid: r.players?.[1]?.uid, p3Name: r.players?.[2]?.ign, p3Uid: r.players?.[2]?.uid, p4Name: r.players?.[3]?.ign, p4Uid: r.players?.[3]?.uid
    };
    return headers.map((h) => csvEscape(flat[h])).join(",");
  });
  downloadFile(`nith-free-fire-registrations-${new Date().toISOString().slice(0, 10)}.csv`, [headers.join(","), ...rows].join("\n"), "text/csv");
}

async function clearRegistrations() {
  if (!confirm("Clear registrations? This cannot be undone.")) return;
  if (SERVER_AVAILABLE && currentAdminPin) {
    await apiPost("/api/admin/clear-registrations", { pin: currentAdminPin });
    await refreshStateFromServer();
    renderAdminTables();
    renderPage();
    toast("Live registrations cleared.");
    return;
  }
  const state = loadState();
  state.registrations = [];
  saveState(state);
  renderAdminTables();
  renderPage();
  toast("Local registrations cleared.");
}


function exportStateJson() {
  const state = loadState();
  const exportable = {
    roomOverrides: state.roomOverrides,
    registrationCounts: state.registrationCounts,
    roomDetails: state.roomDetails,
    leaderboard: state.leaderboard,
    notices: state.notices,
    exportedAt: new Date().toISOString()
  };
  const text = JSON.stringify(exportable, null, 2);
  const box = $("#state-json-box");
  if (box) box.value = text;
  downloadFile(`nith-free-fire-admin-state-${new Date().toISOString().slice(0, 10)}.json`, text, "application/json");
}

function importStateJson() {
  const box = $("#state-json-box");
  if (!box?.value.trim()) return toast("Paste JSON first.", true);
  try {
    const incoming = JSON.parse(box.value);
    const state = loadState();
    state.roomOverrides = incoming.roomOverrides || state.roomOverrides;
    state.registrationCounts = incoming.registrationCounts || state.registrationCounts;
    state.roomDetails = incoming.roomDetails || state.roomDetails;
    state.leaderboard = incoming.leaderboard || state.leaderboard;
    state.notices = incoming.notices || state.notices;
    saveState(state);
    renderAdminTables();
    renderPage();
    toast("State imported locally.");
  } catch (error) {
    toast("Invalid JSON.", true);
  }
}

function resetAdminState() {
  if (!confirm("Reset local room overrides and leaderboard? Registrations will stay.")) return;
  const state = loadState();
  state.roomOverrides = {};
  state.leaderboard = { br: [], cs: [] };
  state.notices = [];
  saveState(state);
  renderAdminTables();
  renderPage();
  toast("Admin state reset locally.");
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function clean(value) {
  return String(value || "").trim();
}

function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function toast(message, isError = false) {
  let el = $(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle("error", isError);
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

document.addEventListener("DOMContentLoaded", pageInit);
