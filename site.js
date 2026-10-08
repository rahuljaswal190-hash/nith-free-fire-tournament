const DATA = window.TOURNAMENT_DATA;
const STATE_KEY = "nithFreeFireTournamentStateV3";
let toastTimer;
let lastSummary = "";
let SERVER_AVAILABLE = false;
let SERVER_STATE = null;
let currentAdminPin = "";
let liveSyncTimer = null;
let ADMIN_REGISTRATIONS = [];
let ADMIN_SUMMARY = null;
let PAYMENT_QR_DATA = "";
let ROOM_QR_DATA = "";
let EDITING_REGISTRATION_ID = "";
let lastStatusSearch = null;
let ADMIN_CALENDAR_SELECTED_DATE = "";

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

function defaultState() {
  return {
    registrations: [],
    roomOverrides: {},
    approvedSlots: [],
    approvedTeams: [],
    leaderboard: { br: [], cs: [] },
    matchHistory: [],
    leaderboardSettings: { defaultView: "latest" },
    notices: [],
    paymentSettings: { payeeName: "", upiId: "", note: "", qrDataUrl: "" },
    scheduleWindows: DATA.matchWindows || { br: [], cs: [] },
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
    approvedSlots: Array.isArray(raw.approvedSlots) ? raw.approvedSlots : [],
    approvedTeams: Array.isArray(raw.approvedTeams) ? raw.approvedTeams : [],
    leaderboard: {
      br: Array.isArray(raw.leaderboard?.br) ? raw.leaderboard.br : [],
      cs: Array.isArray(raw.leaderboard?.cs) ? raw.leaderboard.cs : []
    },
    matchHistory: Array.isArray(raw.matchHistory) ? raw.matchHistory : [],
    leaderboardSettings: { defaultView: raw.leaderboardSettings?.defaultView === "all" ? "all" : "latest" },
    notices: Array.isArray(raw.notices) ? raw.notices : [],
    paymentSettings: raw.paymentSettings && typeof raw.paymentSettings === "object" ? raw.paymentSettings : { payeeName: "", upiId: "", note: "", qrDataUrl: "" },
    scheduleWindows: raw.scheduleWindows && typeof raw.scheduleWindows === "object" ? raw.scheduleWindows : (DATA.matchWindows || { br: [], cs: [] })
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

function getScheduleWindows(mode) {
  const state = loadState();
  const windows = state.scheduleWindows || DATA.matchWindows || {};
  return Array.isArray(windows[mode]) ? windows[mode] : [];
}

function getScheduleWindow(mode, slotId) {
  const slots = getScheduleWindows(mode);
  return slots.find((slot) => slot.id === slotId) || slots[0] || { id: "slot1", label: "Slot 1", time: "To be announced", matches: mode === "br" ? 3 : 1 };
}

function roomScheduleWindow(room) {
  if (!room) return null;
  return getScheduleWindow(room.mode, room.scheduleSlot || "slot1");
}

function localRegistrationsForRoom(roomId) {
  const state = loadState();
  return state.registrations.filter((entry) => entry.roomId === roomId && entry.localSlotHeld !== false && String(entry.status || "Pending").toLowerCase() !== "rejected");
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

function csFormatById(formatId) {
  return (DATA.csFormats || []).find((format) => format.id === formatId) || (DATA.csFormats || []).find((format) => format.id === "squad");
}

function registrationFormatLabel(entry) {
  if (!entry) return "";
  const isCs = entry.mode === "cs" || entry.modeLabel === "Clash Squad" || String(entry.roomId || "").toUpperCase().startsWith("CS-");
  if (isCs) {
    const roomLabel = getRoom(entry.roomId)?.formatLabel;
    const savedLabel = String(entry.formatLabel || "");
    const validCsLabel = (DATA.csFormats || []).some((format) => format.label === savedLabel);
    return roomLabel || (validCsLabel ? savedLabel : "Squad · 4v4");
  }
  return entry.formatLabel || battleFormatById(entry.format)?.label || entry.format || "";
}

function entryLabel(room, plural = true) {
  if (!room) return plural ? "entries" : "entry";
  if (room.mode === "cs") return plural ? "teams" : "team";
  if (room.playersPerEntry === 1) return plural ? "players" : "player";
  return plural ? "teams" : "team";
}

function feeRuleLabel(roomOrFormat) {
  if (roomOrFormat?.mode === "cs") return "per registered side";
  const playersPerEntry = Number(roomOrFormat?.playersPerEntry || 4);
  return playersPerEntry === 1 ? "per player" : "per team";
}

function populateCSFormatSelect(select, selectedFormat = "squad") {
  if (!select) return;
  const formats = DATA.csFormats || [];
  select.innerHTML = formats.map((format) => `<option value="${format.id}" ${format.id === selectedFormat ? "selected" : ""}>${escapeHtml(format.label)} · ${format.playersPerEntry} player${format.playersPerEntry === 1 ? "" : "s"} per side</option>`).join("");
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
  const requiredPlayers = Number(room?.playersPerEntry || (form.dataset.mode === "cs" ? 4 : 1));
  const rosterHelp = form.querySelector("[data-roster-help]");
  if (rosterHelp) {
    if (form.dataset.mode === "br") {
      const formatLabel = room?.formatLabel || battleFormatById(room?.format)?.label || "selected format";
      rosterHelp.textContent = `${formatLabel} registration needs ${requiredPlayers} player${requiredPlayers === 1 ? "" : "s"}. Extra player rows are disabled automatically.`;
    } else {
      const formatLabel = room?.formatLabel || csFormatById(room?.format)?.label || "selected Clash Squad format";
      const feeText = room ? `${formatFee(room.fee)} per side/team` : "the selected entry fee per side/team";
      rosterHelp.textContent = `${formatLabel} needs ${requiredPlayers} player${requiredPlayers === 1 ? "" : "s"} per side. The ${feeText} is the same for every team size. Extra player rows are disabled automatically.`;
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
    const livePages = ["home", "leaderboard", "rooms", "dashboard", "schedule", "status"];
    if (!livePages.includes(page)) return;
    const ok = await refreshStateFromServer();
    if (ok) {
      renderNotices();
      if (page === "dashboard" && currentAdminPin) {
        renderDashboardData().catch(() => {});
      } else if (page === "status" && lastStatusSearch) {
        apiPost("/api/check-status", lastStatusSearch).then(renderStatusResult).catch(() => {});
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
  if (page === "status") setupStatusPage();
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
      <article><strong>${DATA.economics.roomsPerTier}</strong><span>Schedule slots per format</span></article>
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
        <p>${row.brSlots > 0 ? `Battle Royale target reward pool: <b>${formatFee(brProjectedPrize(row.fee))}</b> when lobby conditions are met.` : `Clash Squad tier available from <b>${formatFee(row.fee)}</b>.`} BR Solo is per player; BR team formats are per team. CS is per side/team, regardless of team size.</p>
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
  const defaultFormat = (DATA.csFormats || []).some((format) => format.id === params.get("format")) ? params.get("format") : "squad";
  const tierFilter = $("#cs-tier-filter");
  const variantFilter = $("#cs-variant-filter");
  const formatFilter = $("#cs-format-filter");
  if (tierFilter) populateFeeSelect(tierFilter, defaultFee, "cs");
  if (variantFilter && !variantFilter.value) variantFilter.value = "Normal";
  populateCSFormatSelect(formatFilter, defaultFormat);

  const formVariant = $("#cs-form-variant");
  const formFormat = $("#cs-form-format");
  populateCSFormatSelect(formFormat, defaultFormat);
  const csForm = $('[data-registration-form][data-mode="cs"]');

  const rerender = () => {
    const fee = Number(tierFilter?.value || defaultFee);
    const variant = variantFilter?.value || formVariant?.value || "Normal";
    const format = formatFilter?.value || formFormat?.value || defaultFormat;
    if (formVariant) formVariant.value = variant;
    if (formFormat) formFormat.value = format;
    const rooms = getRooms({ mode: "cs", fee, variant, format });
    renderRoomCards("#cs-room-grid", rooms);
    populateRoomSelect("#cs-room-select", rooms);
    renderModeStats("#cs-stats", rooms);
    syncRegistrationSchedule(csForm, "room");
    updateDynamicRoster(csForm);
    const prize = $("#cs-prize-note");
    const formatInfo = csFormatById(format);
    if (prize) prize.textContent = `${variant} Clash Squad ${formatInfo?.label || ""} · ${formatFee(fee)} per registered side/team. ${DATA.economics.csPrizeNote}`;
  };

  tierFilter?.addEventListener("change", rerender);
  variantFilter?.addEventListener("change", rerender);
  formatFilter?.addEventListener("change", rerender);
  formVariant?.addEventListener("change", () => {
    if (variantFilter) variantFilter.value = formVariant.value;
    rerender();
  });
  formFormat?.addEventListener("change", () => {
    if (formatFilter) formatFilter.value = formFormat.value;
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
    syncRegistrationSchedule(brForm, "room");
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
  const previous = select.value;
  select.innerHTML = rooms.map((room) => {
    const left = slotsLeft(room);
    const status = roomStatus(room);
    const label = entryLabel(room);
    const window = roomScheduleWindow(room);
    return `<option value="${escapeHtml(room.id)}" ${left <= 0 ? "disabled" : ""}>${escapeHtml(room.title)} · ${escapeHtml(window?.label || "Slot")} ${escapeHtml(window?.time || "")} IST — ${left}/${room.capacity} ${label} left (${status.label})</option>`;
  }).join("");
  const preferred = rooms.find((room) => room.id === previous && slotsLeft(room) > 0) || rooms.find((room) => slotsLeft(room) > 0) || rooms[0];
  if (preferred) select.value = preferred.id;
}

function renderRoomCards(selector, rooms) {
  const container = $(selector);
  if (!container) return;
  container.innerHTML = rooms.map((room) => {
    const confirmed = getConfirmedTeams(room);
    const left = slotsLeft(room);
    const status = roomStatus(room);
    const percent = Math.round((confirmed / room.capacity) * 100);
    const modeLabel = room.mode === "br" ? `${room.formatLabel || "Battle Royale"} Battle Royale` : `${room.variant} · ${room.formatLabel || "Squad · 4v4"} Clash Squad`;
    const prizeText = room.mode === "br" ? `Target reward ${formatFee(brProjectedPrize(room.fee))}` : `Entry pool ${formatFee(csProjectedPrize(room.fee))}+`;
    const label = entryLabel(room);
    const window = roomScheduleWindow(room);
    return `
      <article class="room-card ${status.className}">
        <div class="room-card-head">
          <span class="status-pill ${status.className}">${status.label}</span>
          <b>${formatFee(room.fee)} ${feeRuleLabel(room)}</b>
        </div>
        <h3>${escapeHtml(room.title)}</h3>
        <p>${escapeHtml(modeLabel)} · ${room.matchCount} ${room.matchCount > 1 ? "matches" : "match"} · ${escapeHtml(room.rewardRule)}</p>
        <p class="disclaimer"><b>${escapeHtml(window?.label || "Time slot")}:</b> ${escapeHtml(window?.time || "To be announced")} IST</p>
        <div class="slot-line"><span>${confirmed}/${room.capacity} ${label} reserved/confirmed</span><strong>${left} left</strong></div>
        <div class="progress"><i style="width:${percent}%"></i></div>
        <div class="room-meta">
          <span>${prizeText}</span>
          <span>ID: ${escapeHtml(room.id)}</span>
        </div>
      </article>
    `;
  }).join("");
}


function renderPaymentInstructions(form) {
  const box = form?.querySelector("[data-payment-instructions]");
  if (!box) return;
  const settings = loadState().paymentSettings || {};
  const room = getRoom(form.elements.roomId?.value || form.querySelector('[name="roomId"]')?.value);
  const fee = Number(room?.fee || 0);
  const upiId = clean(settings.upiId);
  const payee = clean(settings.payeeName);
  const note = clean(settings.note);
  let upiLink = "";
  if (upiId) {
    const params = new URLSearchParams({ pa: upiId, pn: payee || "Tournament Organizer", am: fee.toFixed(2), cu: "INR", tn: "Free Fire Tournament Entry" });
    upiLink = `upi://pay?${params.toString()}`;
  }
  const qr = settings.qrDataUrl ? `<img class="payment-qr" src="${escapeHtml(settings.qrDataUrl)}" alt="Tournament payment QR code" />` : "";
  const payLink = upiLink ? `<a class="btn small" href="${escapeHtml(upiLink)}">Pay ${formatFee(fee)} with UPI</a>` : "";
  const payeeLine = payee ? `<p><b>Payee:</b> ${escapeHtml(payee)}</p>` : "";
  const upiLine = upiId ? `<p><b>UPI ID:</b> <code>${escapeHtml(upiId)}</code></p>` : "";
  const noteLine = note ? `<p>${escapeHtml(note)}</p>` : "";
  const published = qr || upiLine || payeeLine || noteLine;
  box.innerHTML = `<h3>Payment instructions</h3>${published ? `<div class="payment-instructions-layout">${qr}<div>${payeeLine}${upiLine}<p><b>Entry fee:</b> ${formatFee(fee)} · ${escapeHtml(room ? feeRuleLabel(room) : "per entry")}</p>${payLink}${noteLine}</div></div>` : `<p>Payment instructions have not been published yet. Ask the student organizers before paying.</p>`}<p class="disclaimer">Payment is not automatically verified. Enter the UTR/reference below; registration remains pending until the organizer checks it and approves your entry.</p>`;
}

function syncRegistrationSchedule(form, source = "room") {
  if (!form) return;
  const mode = form.dataset.mode === "cs" ? "cs" : "br";
  const roomSelect = form.elements.roomId || form.querySelector('[name="roomId"]');
  const timeSelect = form.querySelector("[data-match-time]");
  if (!roomSelect || !timeSelect) return;
  const slots = getScheduleWindows(mode);
  const currentRoom = getRoom(roomSelect.value);
  const currentSlot = source === "time" ? timeSelect.value : (currentRoom?.scheduleSlot || slots[0]?.id || "slot1");
  const roomOptionForSlot = (slotId) => Array.from(roomSelect.options).find((option) => getRoom(option.value)?.scheduleSlot === slotId);
  timeSelect.innerHTML = slots.map((item) => {
    const roomOption = roomOptionForSlot(item.id);
    const unavailable = !roomOption || roomOption.disabled;
    return `<option value="${escapeHtml(item.id)}" ${unavailable ? "disabled" : ""}>${escapeHtml(item.label)} · ${escapeHtml(item.time)} IST · ${item.matches || (mode === "br" ? 3 : 1)} ${mode === "br" ? "matches" : "match"}${unavailable ? " · Lobby full" : ""}</option>`;
  }).join("");
  const selectedSlot = slots.some((item) => item.id === currentSlot) ? currentSlot : (slots[0]?.id || "slot1");
  timeSelect.value = selectedSlot;
  if (source === "time") {
    const matchingOption = Array.from(roomSelect.options).find((option) => getRoom(option.value)?.scheduleSlot === selectedSlot && !option.disabled);
    if (matchingOption) roomSelect.value = matchingOption.value;
  } else if (!currentRoom || currentRoom.scheduleSlot !== selectedSlot) {
    const matchingOption = Array.from(roomSelect.options).find((option) => getRoom(option.value)?.scheduleSlot === selectedSlot && !option.disabled);
    if (matchingOption) roomSelect.value = matchingOption.value;
  }
  updateDynamicRoster(form);
  renderPaymentInstructions(form);
}

function populateMatchTimeSelects() {
  $$('[data-registration-form]').forEach((form) => {
    const timeSelect = form.querySelector("[data-match-time]");
    const roomSelect = form.elements.roomId || form.querySelector('[name="roomId"]');
    if (timeSelect && timeSelect.dataset.scheduleBound !== "true") {
      timeSelect.addEventListener("change", () => syncRegistrationSchedule(form, "time"));
      timeSelect.dataset.scheduleBound = "true";
    }
    if (roomSelect && roomSelect.dataset.scheduleBound !== "true") {
      roomSelect.addEventListener("change", () => syncRegistrationSchedule(form, "room"));
      roomSelect.dataset.scheduleBound = "true";
    }
    syncRegistrationSchedule(form, "room");
  });
}

function setupCommonRegistration() {
  populateMatchTimeSelects();
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
      try {
        const result = await submitRegistration(data);
        if (result.registration) {
          data.slotNumber = result.registration.slotNumber;
          data.slotCapacity = result.registration.slotCapacity;
          data.status = result.registration.status || "Pending";
          data.scheduleSlotLabel = result.registration.scheduleSlotLabel || data.scheduleSlotLabel;
          data.scheduleTime = result.registration.scheduleTime || data.scheduleTime;
        }
        lastSummary = buildRegistrationSummary(data);
        showSuccess(lastSummary, data);
        form.reset();
        await refreshStateFromServer();
        renderPage();
        updateDynamicRoster(form);
        populateMatchTimeSelects();
        toast(result.message || "Registration received. Check your lobby and slot for approval status.");
      } catch (error) {
        toast(error.message || "Registration could not be submitted.", true);
      }
    });
  });
}

async function submitRegistration(data) {
  if (SERVER_AVAILABLE) {
    const result = await apiPost("/api/register", data);
    return { message: result.message || "Registration received on the live server.", registration: result.registration };
  }
  const state = loadState();
  const room = getRoom(data.roomId);
  const used = new Set((state.registrations || []).filter((entry) => entry.roomId === data.roomId && String(entry.status || "Pending").toLowerCase() !== "rejected").map((entry) => Number(entry.slotNumber || 0)));
  let slot = null;
  for (let candidate = 1; candidate <= Number(room?.capacity || 12); candidate += 1) {
    if (!used.has(candidate)) { slot = candidate; break; }
  }
  if (!slot) throw new Error("This lobby has no slots left. Choose another lobby.");
  data.slotNumber = slot;
  data.slotCapacity = Number(room?.capacity || 12);
  data.status = "Pending";
  state.registrations.unshift(data);
  state.registrationCounts = state.registrationCounts || {};
  state.registrationCounts[data.roomId] = (state.registrationCounts[data.roomId] || 0) + 1;
  saveState(state);
  return { message: `Registration received on this device. Reserved slot ${slot}/${data.slotCapacity}; approval is pending.`, registration: data };
}

function readRegistrationForm(form, mode) {
  const fd = new FormData(form);
  const roomId = clean(fd.get("roomId"));
  const room = getRoom(roomId);
  const now = new Date();
  const requiredPlayers = Number(room?.playersPerEntry || (mode === "cs" ? 4 : 1));
  const scheduleSlot = room?.scheduleSlot || clean(fd.get("scheduleSlot")) || "slot1";
  const scheduleWindow = getScheduleWindow(mode, scheduleSlot);
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
    formatLabel: room?.formatLabel || (mode === "cs" ? csFormatById(clean(fd.get("format")))?.label : battleFormatById(room?.format || clean(fd.get("format")))?.label) || "",
    playersPerEntry: requiredPlayers,
    roomId,
    roomTitle: room?.title || roomId,
    scheduleSlot,
    scheduleSlotLabel: scheduleWindow.label || "Time Slot 1",
    scheduleTime: scheduleWindow.time ? `${scheduleWindow.time} IST` : "",
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
  if (!data.scheduleSlot) return "Please select a match time slot.";
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
  const modeExtra = data.mode === "br" ? ` (${data.formatLabel || data.format || "Format"})` : ` (${data.formatLabel || "Clash Squad"} · ${data.variant || "Normal"})`;
  return [
    DATA.event.name,
    `Registration ID: ${data.id}`,
    `Status: ${data.status}`,
    `Mode: ${data.modeLabel}${modeExtra}`,
    `Room: ${data.roomTitle} (${data.roomId})`,
    `Match Time: ${data.scheduleSlotLabel || "Time Slot 1"} — ${data.scheduleTime || ""}`,
    `Reserved Slot: ${data.slotNumber ? `#${data.slotNumber}/${data.slotCapacity || 12}` : "Pending"}`,
    `Team/Entry Name: ${data.teamName}`,
    `IGL/Player: ${data.iglName || data.captainName} | ID: ${data.iglUid || "N/A"}`,
    `WhatsApp: ${data.whatsapp}`,
    `Entry Fee: ${formatFee(data.fee)} ${data.feeRule || "per entry/team"}`,
    `Payment Ref: ${data.paymentRef}`,
    "",
    `Players:\n${players}`,
    "",
    `Submitted: ${data.submittedAtDisplay}`,
    "Note: The slot number is reserved immediately; approval status is still pending until the organizer reviews the registration."
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

function showAdminConfirmation(title) {
  toast(String(title || "Saved successfully"), false, 2500);
}

function showSuccess(summary, data) {
  const modal = $("#success-modal");
  const text = $("#success-text");
  const box = $("#summary-box");
  const whatsapp = $("#whatsapp-link");
  if (text) text.textContent = `Your registration is ${data.status || "Pending"}. Your reserved slot is ${data.slotNumber ? `${data.slotNumber}/${data.slotCapacity || 12}` : "not assigned"}. Use Check Status with the same lobby and slot number to see approval updates.`;
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

function todayDateIST() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function stableLocalEntryKey(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `local-${(hash >>> 0).toString(16)}`;
}

function formatIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return "—";
  const dateValue = new Date(`${value}T12:00:00+05:30`);
  if (Number.isNaN(dateValue.getTime())) return value;
  return dateValue.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

function leaderboardViewSelection() {
  const control = $("#leaderboard-view");
  if (control) return control.value || "latest";
  return loadState().leaderboardSettings?.defaultView === "all" ? "all" : "latest";
}

function leaderboardDateSelection() {
  return $("#leaderboard-date")?.value || todayDateIST();
}

function renderLeaderboardPage() {
  const state = loadState();
  const viewControl = $("#leaderboard-view");
  const dateControl = $("#leaderboard-date");
  const savedDateControl = $("#leaderboard-saved-date");
  const note = $("#leaderboard-view-note");
  const dates = [...new Set((state.matchHistory || []).map((row) => row.date).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))))].sort().reverse();
  const newestDate = dates[0] || todayDateIST();

  if (viewControl && viewControl.dataset.initialized !== "true") {
    viewControl.value = state.leaderboardSettings?.defaultView === "all" ? "all" : "latest";
    viewControl.dataset.initialized = "true";
  }
  if (dateControl && (!dateControl.value || (viewControl?.value !== "date" && viewControl?.value !== "all"))) dateControl.value = newestDate;
  if (savedDateControl) {
    const previous = savedDateControl.value;
    savedDateControl.innerHTML = dates.length
      ? `<option value="">Choose a saved date…</option>${dates.map((date) => `<option value="${escapeHtml(date)}">${escapeHtml(formatIsoDate(date))}</option>`).join("")}`
      : `<option value="">No saved match dates yet</option>`;
    if (dates.includes(previous)) savedDateControl.value = previous;
    if (viewControl?.value === "date" && dates.includes(dateControl?.value || "")) savedDateControl.value = dateControl.value;
  }
  if (viewControl && viewControl.dataset.bound !== "true") {
    viewControl.dataset.bound = "true";
    viewControl.addEventListener("change", () => renderLeaderboardPage());
    dateControl?.addEventListener("change", () => {
      viewControl.value = "date";
      renderLeaderboardPage();
    });
    savedDateControl?.addEventListener("change", () => {
      if (savedDateControl.value && dateControl) {
        dateControl.value = savedDateControl.value;
        viewControl.value = "date";
        renderLeaderboardPage();
      }
    });
  }
  if (note) {
    const view = leaderboardViewSelection();
    note.textContent = view === "all"
      ? "All-time totals add every saved match date. Match-by-match detail shows the most recent saved session for each entry."
      : view === "date"
        ? `Showing the leaderboard for ${formatIsoDate(leaderboardDateSelection())}. If no verified results were published on that date, the relevant mode will show a clear notice.`
        : "Showing each mode’s latest saved match date. Use the date picker or saved-date list to browse earlier results.";
  }
  renderLeaderboards("#br-leaderboard", "br");
  renderLeaderboards("#cs-leaderboard", "cs");
}

function getApprovedTeamRows(mode) {
  const state = loadState();
  let teams = Array.isArray(state.approvedTeams) ? state.approvedTeams : [];
  if (!teams.length && Array.isArray(state.registrations)) {
    teams = state.registrations.filter((reg) => String(reg.status || "").toLowerCase() === "approved").map((reg) => ({
      teamName: reg.teamName,
      mode: reg.mode,
      modeLabel: reg.modeLabel,
      format: reg.format,
      formatLabel: registrationFormatLabel(reg),
      variant: reg.variant,
      roomId: reg.roomId,
      roomTitle: reg.roomTitle,
      fee: reg.fee,
      slotNumber: reg.slotNumber,
      slotCapacity: reg.slotCapacity,
      scheduleSlotLabel: reg.scheduleSlotLabel,
      scheduleTime: reg.scheduleTime,
      players: (reg.players || []).map((player) => player.ign).filter(Boolean),
      brMatches: reg.brMatches || [],
      csResult: reg.csResult || null,
      lastMatchScore: reg.brMatches?.slice().reverse().find((match) => match && match.score !== null && match.score !== undefined)?.score ?? null,
      csRoundDiff: reg.csResult?.roundDiff ?? null,
      finalScore: reg.finalScore,
      matchDate: reg.scoreUpdatedAt ? String(reg.scoreUpdatedAt).slice(0, 10) : ""
    }));
  }
  return teams.filter((row) => row.mode === mode || (mode === "br" && row.modeLabel === "Battle Royale") || (mode === "cs" && row.modeLabel === "Clash Squad"));
}

function aggregateHistoryRows(historyRows, mode) {
  const groups = new Map();
  historyRows.forEach((row) => {
    const key = row.entryKey || `${row.teamName || ""}|${row.roomId || ""}|${row.slotNumber || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return [...groups.values()].map((group) => {
    group.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const latest = group[group.length - 1];
    const scored = group.filter((row) => row.finalScore !== null && row.finalScore !== undefined && row.finalScore !== "");
    const total = scored.reduce((sum, row) => sum + Number(row.finalScore || 0), 0);
    if (mode === "br") {
      return { ...latest, finalScore: scored.length ? total : null, brMatches: latest.brMatches || [], lastMatchScore: latest.lastMatchScore, matchDate: latest.date, allTimeDays: group.length };
    }
    const wins = group.filter((row) => row.csResult?.outcome === "Win").length;
    const losses = group.filter((row) => row.csResult?.outcome === "Loss").length;
    const totalRoundDiff = group.reduce((sum, row) => sum + Number(row.csRoundDiff ?? row.csResult?.roundDiff ?? 0), 0);
    return {
      ...latest,
      wins,
      losses,
      finalScore: scored.length ? total : null,
      csResult: { ...(latest.csResult || {}), outcome: `${wins}W–${losses}L`, roundDiff: totalRoundDiff },
      csRoundDiff: totalRoundDiff,
      matchDate: latest.date,
      allTimeDays: group.length
    };
  });
}

function getLeaderboardRows(mode) {
  const state = loadState();
  const view = leaderboardViewSelection();
  const history = (state.matchHistory || []).filter((row) => row && row.mode === mode && /^\d{4}-\d{2}-\d{2}$/.test(String(row.date || "")));
  if (view === "date") return history.filter((row) => row.date === leaderboardDateSelection());
  if (history.length) {
    if (view === "all") return aggregateHistoryRows(history, mode);
    const latestDate = history.reduce((latest, row) => row.date > latest ? row.date : latest, "");
    return history.filter((row) => row.date === latestDate);
  }
  return getApprovedTeamRows(mode);
}

function renderLeaderboards(selector, mode) {
  const container = $(selector);
  if (!container) return;
  const view = leaderboardViewSelection();
  const rows = getLeaderboardRows(mode).map((row) => ({
    ...row,
    _score: row.finalScore === null || row.finalScore === undefined || row.finalScore === "" ? null : Number(row.finalScore)
  })).sort((a, b) => {
    if (a._score === null && b._score !== null) return 1;
    if (a._score !== null && b._score === null) return -1;
    if (a._score !== null && b._score !== null && a._score !== b._score) return b._score - a._score;
    if (mode === "cs" && Number(a.csRoundDiff || a.csResult?.roundDiff || 0) !== Number(b.csRoundDiff || b.csResult?.roundDiff || 0)) {
      return Number(b.csRoundDiff || b.csResult?.roundDiff || 0) - Number(a.csRoundDiff || a.csResult?.roundDiff || 0);
    }
    return Number(a.slotNumber || 999) - Number(b.slotNumber || 999) || String(a.teamName || "").localeCompare(String(b.teamName || ""));
  });

  if (!rows.length) {
    const title = view === "date" ? `No ${mode === "br" ? "Battle Royale" : "Clash Squad"} leaderboard available for ${formatIsoDate(leaderboardDateSelection())}` : `No approved ${mode === "br" ? "Battle Royale" : "Clash Squad"} teams yet`;
    const message = view === "date" ? "No verified results have been published for this mode on the selected date. Choose another date or check back after the organizer publishes results." : "Once the organizer approves an entry, its slot and team name will appear here. Verified match results are published after review.";
    container.innerHTML = `<div class="empty-state"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p></div>`;
    return;
  }
  let rank = 0;
  let previousRankKey = null;
  const tableRows = rows.map((row, index) => {
    if (row._score !== null) {
      const roundDiff = Number(row.csRoundDiff || row.csResult?.roundDiff || 0);
      const rankKey = mode === "cs" ? `${row._score}|${roundDiff}` : String(row._score);
      if (previousRankKey !== rankKey) rank = index + 1;
      previousRankKey = rankKey;
    }
    const displayedRank = row._score === null ? "—" : rank;
    const format = mode === "br" ? (registrationFormatLabel(row) || "Battle Royale") : `${registrationFormatLabel(row)} · ${row.variant || "Clash Squad"}`;
    const roster = (row.players || []).filter(Boolean).join(", ") || "Roster submitted";
    const cumulative = row._score === null ? "Awaiting score" : row._score;
    const matchDateLabel = row.allTimeDays ? `All-time · ${row.allTimeDays} date${row.allTimeDays === 1 ? "" : "s"} · latest ${formatIsoDate(row.matchDate || row.date)}` : formatIsoDate(row.matchDate || row.date);
    const common = `<td>${displayedRank}</td>
      <td><b>${row.slotNumber ? `#${escapeHtml(row.slotNumber)}/${escapeHtml(row.slotCapacity || 12)}` : "—"}</b></td>
      <td>${escapeHtml(matchDateLabel)}</td>
      <td><strong>${escapeHtml(row.teamName || "-")}</strong><br><small>${escapeHtml(roster)}</small></td>
      <td>${escapeHtml(format)}</td>
      <td>${row.fee ? formatFee(row.fee) : "—"}</td>
      <td>${escapeHtml(row.scheduleTime || row.scheduleSlotLabel || "—")}</td>
      <td>${escapeHtml(row.roomTitle || "-")}<br><small>${escapeHtml(row.roomId || "")}</small></td>`;
    if (mode === "br") {
      const matchCells = [0, 1, 2].map((matchIndex) => {
        const match = row.brMatches?.[matchIndex];
        if (!match || match.score === null || match.score === undefined) return `<td>—</td>`;
        return `<td><b>${escapeHtml(match.score)}</b><br><small>${escapeHtml(match.kills)} kills · #${escapeHtml(match.position)}</small></td>`;
      }).join("");
      const lastScore = row.lastMatchScore === null || row.lastMatchScore === undefined ? "—" : row.lastMatchScore;
      return `<tr class="${row._score !== null && rank <= 3 ? "top-row" : ""}">${common}${matchCells}<td><b>${escapeHtml(lastScore)}</b></td><td><b>${escapeHtml(cumulative)}</b></td></tr>`;
    }
    const result = row.csResult || {};
    const outcome = result.outcome || (row.wins ? "Win" : row.losses ? "Loss" : "—");
    const roundDiff = row.csRoundDiff ?? result.roundDiff ?? row.roundDiff ?? "—";
    return `<tr class="${row._score !== null && rank <= 3 ? "top-row" : ""}">${common}<td>${escapeHtml(outcome)}</td><td>${escapeHtml(roundDiff)}</td><td><b>${escapeHtml(cumulative)}</b></td></tr>`;
  }).join("");
  const modeTitle = mode === "br" ? "Battle Royale" : "Clash Squad";
  const scoreHeading = view === "all" ? "All-time total" : view === "date" ? "Date total" : "Match-date total";
  const headers = mode === "br"
    ? `<th>Rank</th><th>Slot</th><th>Match date</th><th>Team / Entry & roster</th><th>Format</th><th>Fee</th><th>Match time</th><th>Lobby</th><th>Match 1</th><th>Match 2</th><th>Match 3</th><th>Last match</th><th>${scoreHeading}</th>`
    : `<th>Rank</th><th>Slot</th><th>Match date</th><th>Team & roster</th><th>Type</th><th>Fee</th><th>Match time</th><th>Room</th><th>Result</th><th>Round diff</th><th>${scoreHeading}</th>`;
  const noteText = mode === "br"
    ? "Each BR match score is kills plus the published placement points. The cumulative total follows the selected view; match-by-match cells show the selected session."
    : "Clash Squad points are 3 for a win and 0 for a loss; round difference is used as a tiebreaker. All-time view sums saved results. ";
  const selectedLabel = view === "date" ? `Selected date: ${formatIsoDate(leaderboardDateSelection())}. ` : view === "all" ? "All-time cumulative standings. " : "Latest saved results for this mode. ";
  container.innerHTML = `<div class="table-wrap"><table><thead><tr>${headers}</tr></thead><tbody>${tableRows}</tbody></table></div><p class="disclaimer">${escapeHtml(selectedLabel + modeTitle + " standings. " + noteText)}</p>`;
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
        ${canShow ? `<div class="note-box"><p><b>Room ID:</b> ${escapeHtml(detail.customRoomId)}</p><p><b>Password:</b> ${escapeHtml(detail.password)}</p><p>${escapeHtml(detail.message || "Join on time and do not share details outside registered players.")}</p>${detail.roomQrDataUrl ? `<img class="room-qr" src="${escapeHtml(detail.roomQrDataUrl)}" alt="Optional room join QR code" />` : ""}</div>` : ""}
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
    table.innerHTML = regs.length ? `<div class="table-wrap"><table><thead><tr><th>Status</th><th>Slot</th><th>ID</th><th>Mode</th><th>Format</th><th>Match time</th><th>Room</th><th>Entry/Team</th><th>IGL/Player</th><th>Player details</th><th>WhatsApp</th><th>Fee</th><th>Payment</th></tr></thead><tbody>${regs.map((r) => `<tr><td>${registrationStatusBadge(r.status)}</td><td>${slotLabel(r)}</td><td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.modeLabel)}</td><td>${escapeHtml(registrationFormatLabel(r) || r.variant || "-")}</td><td>${escapeHtml(r.scheduleTime || r.scheduleSlotLabel || "-")}</td><td>${escapeHtml(r.roomId)}</td><td>${escapeHtml(r.teamName)}</td><td>${escapeHtml(r.iglName || r.captainName)}</td><td>${playerListHtml(r)}</td><td>${escapeHtml(r.whatsapp)}</td><td>${formatFee(r.fee)}</td><td>${escapeHtml(r.paymentRef || "-")}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><h3>No registrations yet</h3><p>Registrations will appear live here.</p></div>`;
  }
}

function slotLabel(reg) {
  if (!reg || !reg.slotNumber) return "-";
  const roomCapacity = getRoom(reg.roomId)?.capacity || (String(reg.roomId || "").startsWith("CS-") ? 2 : 12);
  return `#${escapeHtml(reg.slotNumber)}/${escapeHtml(roomCapacity)}`;
}

function setupStatusPage() {
  populateStatusRoomSelect();
  updateStatusSlotLimit();
  const select = $("#status-room");
  if (select && select.dataset.bound !== "true") {
    select.addEventListener("change", updateStatusSlotLimit);
    select.dataset.bound = "true";
  }
  const button = $("#check-slot-status");
  if (button && button.dataset.bound !== "true") {
    button.addEventListener("click", checkStatusBySlot);
    button.dataset.bound = "true";
  }
}

function populateStatusRoomSelect() {
  const select = $("#status-room");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">Select your exact lobby</option>` + DATA.rooms.map((room) => {
    const window = roomScheduleWindow(room);
    return `<option value="${escapeHtml(room.id)}">${escapeHtml(room.title)} · ${escapeHtml(window?.label || "Slot")} ${escapeHtml(window?.time || "")} IST · ${room.matchCount} ${room.matchCount > 1 ? "matches" : "match"}</option>`;
  }).join("");
  if (DATA.rooms.some((room) => room.id === current)) select.value = current;
}

function updateStatusSlotLimit() {
  const room = getRoom($("#status-room")?.value);
  const capacity = Number(room?.capacity || 12);
  const input = $("#status-slot");
  const label = $("#status-slot-label");
  if (input) {
    input.max = String(capacity);
    input.placeholder = `Enter 1–${capacity}`;
    if (Number(input.value) > capacity) input.value = "";
  }
  if (label) label.firstChild.textContent = `Slot number (1–${capacity})`;
}

async function checkStatusBySlot() {
  const roomId = $("#status-room")?.value;
  const slotNumber = Number(clean($("#status-slot")?.value));
  const capacity = Number(getRoom(roomId)?.capacity || 12);
  if (!roomId) return toast("Select the same lobby you chose when registering.", true);
  if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > capacity) return toast(`Enter a slot number from 1 to ${capacity}.`, true);
  try {
    let result;
    lastStatusSearch = { roomId, slotNumber };
    if (SERVER_AVAILABLE) {
      result = await apiPost("/api/check-status", lastStatusSearch);
    } else {
      const state = loadState();
      const reg = (state.registrations || []).find((item) => String(item.roomId) === roomId && Number(item.slotNumber) === slotNumber);
      result = reg ? {
        found: true,
        status: reg.status || "Pending",
        teamName: reg.teamName,
        roomId: reg.roomId,
        roomTitle: reg.roomTitle,
        slotNumber: reg.slotNumber,
        slotCapacity: reg.slotCapacity || getRoom(reg.roomId)?.capacity || 12,
        modeLabel: reg.modeLabel,
        formatLabel: registrationFormatLabel(reg),
        variant: reg.variant,
        scheduleSlotLabel: reg.scheduleSlotLabel,
        scheduleTime: reg.scheduleTime
      } : { found: false, message: "No registration uses that lobby and slot number. Check the selected lobby and try again." };
    }
    renderStatusResult(result);
  } catch (error) {
    toast(error.message || "Could not check slot.", true);
  }
}

function renderStatusResult(result) {
  const box = $("#status-result");
  if (!box) return;
  if (!result?.found) {
    box.innerHTML = `<div class="empty-state"><h3>No record found</h3><p>${escapeHtml(result?.message || "Check the selected lobby and slot number, then try again.")}</p></div>`;
    return;
  }
  const status = String(result.status || "Pending");
  const statusKey = status.toLowerCase();
  const cls = statusKey === "approved" ? "open" : statusKey === "rejected" ? "closed" : "few";
  const slotText = result.slotNumber ? `Slot ${result.slotNumber}/${result.slotCapacity || 12}` : "Slot not assigned";
  const statusMessage = statusKey === "approved" ? "Your entry is approved. Join only through the Room Details page when the organizer releases the room." : statusKey === "rejected" ? "Your entry was not approved. Contact the organizer if you think this is a mistake." : "Your entry is pending. The organizer has not approved it yet.";
  box.innerHTML = `
    <article class="room-card ${cls}">
      <div class="room-card-head"><span class="status-pill ${cls}">${escapeHtml(status)}</span><b>${escapeHtml(slotText)}</b></div>
      <h3>${escapeHtml(result.teamName || "Tournament entry")}</h3>
      <p>${escapeHtml(result.modeLabel || "")} ${registrationFormatLabel(result) || result.variant ? `· ${escapeHtml(registrationFormatLabel(result) || result.variant)}` : ""}</p>
      <div class="note-box"><p><b>Lobby:</b> ${escapeHtml(result.roomTitle || result.roomId || "-")}</p><p><b>Match time:</b> ${escapeHtml(result.scheduleTime || result.scheduleSlotLabel || "To be announced")}</p><p>${escapeHtml(statusMessage)}</p></div>
    </article>
  `;
}


function renderSchedulePage() {
  const windows = $("#match-windows");
  if (windows) {
    windows.innerHTML = ["br", "cs"].map((mode) => {
      const title = mode === "br" ? "Battle Royale" : "Clash Squad";
      const slotWindows = getScheduleWindows(mode);
      const matches = mode === "br" ? 3 : 1;
      return `<section class="schedule-mode-group"><h3>${title} · ${slotWindows.length} available time slots</h3>${slotWindows.map((item, index) => `
        <article class="timeline-card match-window-card">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <div><b>${escapeHtml(item.label)} · ${escapeHtml(item.time)} IST</b>
            <div class="match-window-modes"><p><strong>${matches} match${matches > 1 ? "es" : ""}</strong> in this assigned session.</p></div>
          </div>
        </article>`).join("")}</section>`;
    }).join("");
  }
  const container = $("#schedule-list");
  if (!container) return;
  container.innerHTML = DATA.schedule.map((item, index) => `
    <article class="timeline-card">
      <span>${String(index + 1).padStart(2, "0")}</span>
      <div><b>${escapeHtml(item.time)}</b><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.detail)}</p></div>
    </article>
  `).join("");
}


function formatClockForAdmin(hour, minute) {
  const suffix = hour < 12 ? "AM" : "PM";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function populateAdminTimeSelect(select, selectedValue) {
  if (!select) return;
  if (!select.options.length) {
    const options = [];
    for (let minutes = 0; minutes < 1440; minutes += 30) {
      const hour = Math.floor(minutes / 60);
      const minute = minutes % 60;
      const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      options.push(`<option value="${value}">${formatClockForAdmin(hour, minute)}</option>`);
    }
    select.innerHTML = options.join("");
  }
  if (Array.from(select.options).some((option) => option.value === selectedValue)) select.value = selectedValue;
}

function adminScheduleSettingsFromControls() {
  return {
    br: { startTime: $("#br-start-time")?.value || "21:00", durationHours: Number($("#br-duration")?.value || 1), gapHours: Number($("#br-gap")?.value || 0) },
    cs: { startTime: $("#cs-start-time")?.value || "21:00", durationHours: Number($("#cs-duration")?.value || 1), gapHours: Number($("#cs-gap")?.value || 0) }
  };
}

function previewAdminWindows(mode, settings) {
  const [hour, minute] = (settings[mode].startTime || "21:00").split(":").map(Number);
  const duration = Number(settings[mode].durationHours || 1);
  const gap = Number(settings[mode].gapHours || 0);
  const windows = [];
  for (let index = 0; index < 3; index += 1) {
    const start = hour * 60 + minute + index * (duration + gap) * 60;
    const end = start + duration * 60;
    const format = (value) => {
      const day = Math.floor(value / 1440);
      const minuteOfDay = value % 1440;
      const h = Math.floor(minuteOfDay / 60);
      const m = minuteOfDay % 60;
      return { label: formatClockForAdmin(h, m), day };
    };
    const from = format(start);
    const to = format(end);
    const daySuffix = from.day > 0 ? " (+1 day)" : to.day > from.day ? (end % 1440 === 0 ? " (midnight)" : " (+1 day)") : "";
    windows.push(`Slot ${index + 1}: ${from.label}–${to.label}${daySuffix}`);
  }
  return windows;
}

function updateAdminSchedulePreview() {
  const preview = $("#admin-schedule-preview");
  if (!preview) return;
  const settings = adminScheduleSettingsFromControls();
  preview.innerHTML = `<b>BR:</b> ${previewAdminWindows("br", settings).map(escapeHtml).join(" · ")} <br><b>CS:</b> ${previewAdminWindows("cs", settings).map(escapeHtml).join(" · ")}`;
}

function updateAdminStorageStatus(info) {
  const node = $("#admin-storage-status");
  if (!node) return;
  if (!info) {
    node.className = "storage-status warning";
    node.textContent = "Browser/local-only mode: changes are stored on this device and are not shared or protected from browser-data loss.";
    return;
  }
  const path = info.path ? ` (${info.path})` : "";
  if (info.mounted) {
    node.className = "storage-status good";
    node.textContent = `Mounted volume detected${path}. Confirm this mount is a persistent disk on your host; the app is writing its JSON state there.`;
  } else if (info.configuredDirectory) {
    node.className = "storage-status warning";
    node.textContent = `A custom data path is configured${path}, but no mounted persistent volume was detected. Verify the host volume; otherwise files may disappear on restart/redeploy.`;
  } else {
    node.className = "storage-status warning";
    node.textContent = `No persistent volume detected${path}. This server file may be removed by a host restart/redeploy; configure a persistent disk and TOURNAMENT_DATA_DIR before relying on payment settings or archived results.`;
  }
}

function registrationDateKey(registration) {
  const raw = registration?.serverReceivedAt || registration?.submittedAt || registration?.createdAt;
  if (!raw) return "";
  const dateValue = new Date(raw);
  if (Number.isNaN(dateValue.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(dateValue);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function registrationTimeLabel(registration) {
  const raw = registration?.serverReceivedAt || registration?.submittedAt || registration?.createdAt;
  if (!raw) return "—";
  const dateValue = new Date(raw);
  if (Number.isNaN(dateValue.getTime())) return "—";
  return dateValue.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
}

function renderAdminCalendar(registrations = []) {
  const calendar = $("#registration-calendar");
  const monthInput = $("#registration-calendar-month");
  const summary = $("#registration-calendar-summary");
  const dayDetails = $("#registrations-for-day");
  if (!calendar || !monthInput) return;
  if (!monthInput.value) monthInput.value = todayDateIST().slice(0, 7);
  if (monthInput.dataset.bound !== "true") {
    monthInput.dataset.bound = "true";
    monthInput.addEventListener("change", () => {
      const resultDate = $("#admin-result-date")?.value || "";
      ADMIN_CALENDAR_SELECTED_DATE = resultDate.startsWith(`${monthInput.value}-`) ? resultDate : `${monthInput.value}-01`;
      const resultInput = $("#admin-result-date");
      if (resultInput) resultInput.value = ADMIN_CALENDAR_SELECTED_DATE;
      renderAdminCalendar(ADMIN_REGISTRATIONS);
      renderFinalScoreTable();
    });
  }
  const [year, month] = monthInput.value.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) return;
  const counts = new Map();
  const registrationsByDate = new Map();
  (registrations || []).forEach((reg) => {
    const key = registrationDateKey(reg);
    if (!key) return;
    counts.set(key, Number(counts.get(key) || 0) + 1);
    if (!registrationsByDate.has(key)) registrationsByDate.set(key, []);
    registrationsByDate.get(key).push(reg);
  });
  const resultsByDate = new Map();
  (ADMIN_SUMMARY?.matchHistory || []).forEach((row) => {
    const key = String(row?.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
    if (!resultsByDate.has(key)) resultsByDate.set(key, []);
    resultsByDate.get(key).push(row);
  });
  const monthKey = monthInput.value;
  const daysWithRegistrations = [...counts.keys()].filter((key) => key.startsWith(`${monthKey}-`)).sort();
  if (!ADMIN_CALENDAR_SELECTED_DATE.startsWith(`${monthKey}-`)) {
    const resultDate = $("#admin-result-date")?.value || "";
    ADMIN_CALENDAR_SELECTED_DATE = resultDate.startsWith(`${monthKey}-`) ? resultDate : (daysWithRegistrations[0] || `${monthKey}-01`);
  }
  const totalInMonth = daysWithRegistrations.reduce((sum, key) => sum + counts.get(key), 0);
  const savedResultDates = [...resultsByDate.keys()].filter((key) => key.startsWith(`${monthKey}-`));
  const totalResultsInMonth = savedResultDates.reduce((sum, key) => sum + resultsByDate.get(key).length, 0);
  if (summary) summary.textContent = `${totalInMonth} registration${totalInMonth === 1 ? "" : "s"} across ${daysWithRegistrations.length} active registration date${daysWithRegistrations.length === 1 ? "" : "s"}; ${totalResultsInMonth} saved leaderboard result${totalResultsInMonth === 1 ? "" : "s"}. Select any calendar day. Each day shows registration and saved leaderboard-result counts.`;
  const weekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const firstDayOffset = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month, 0).getDate();
  const blanks = Array.from({ length: firstDayOffset }, () => `<span class="calendar-blank" aria-hidden="true"></span>`).join("");
  const dayButtons = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const key = `${monthKey}-${String(day).padStart(2, "0")}`;
    const count = Number(counts.get(key) || 0);
    const resultCount = (resultsByDate.get(key) || []).length;
    const selected = key === ADMIN_CALENDAR_SELECTED_DATE;
    return `<button type="button" class="calendar-day ${count ? "has-registrations" : ""} ${resultCount ? "has-results" : ""} ${selected ? "selected" : ""}" data-calendar-date="${key}" aria-label="${formatIsoDate(key)}: ${count} registration${count === 1 ? "" : "s"}; ${resultCount} leaderboard result${resultCount === 1 ? "" : "s"}"><span>${day}</span><small>${count} reg · ${resultCount} LB</small></button>`;
  }).join("");
  calendar.innerHTML = `<div class="calendar-weekdays">${weekdayNames.map((name) => `<span>${name}</span>`).join("")}</div><div class="calendar-days">${blanks}${dayButtons}</div>`;
  $$('[data-calendar-date]', calendar).forEach((button) => button.addEventListener("click", () => {
    ADMIN_CALENDAR_SELECTED_DATE = button.dataset.calendarDate || "";
    const resultInput = $("#admin-result-date");
    if (resultInput) resultInput.value = ADMIN_CALENDAR_SELECTED_DATE;
    renderAdminCalendar(ADMIN_REGISTRATIONS);
    renderFinalScoreTable();
  }));
  if (dayDetails) {
    const selectedRows = registrationsByDate.get(ADMIN_CALENDAR_SELECTED_DATE) || [];
    const resultRows = resultsByDate.get(ADMIN_CALENDAR_SELECTED_DATE) || [];
    const dateTitle = formatIsoDate(ADMIN_CALENDAR_SELECTED_DATE);
    const resultBreakdown = { br: resultRows.filter((row) => row.mode === "br").length, cs: resultRows.filter((row) => row.mode === "cs").length };
    const resultsStatus = resultRows.length
      ? `<p class="calendar-result-available"><b>Leaderboard:</b> ${resultRows.length} saved result${resultRows.length === 1 ? "" : "s"} (${resultBreakdown.br} BR, ${resultBreakdown.cs} CS). This date is selected for result entry below.</p>`
      : `<p class="calendar-result-empty"><b>Leaderboard:</b> No results have been published for this date. Enter approved-team scores below to create its leaderboard.</p>`;
    const registrationsStatus = selectedRows.length
      ? `<p><b>Registrations:</b> ${selectedRows.length} submitted on this date.</p>`
      : `<p class="calendar-result-empty"><b>Registrations:</b> No registrations were received on this date.</p>`;
    const table = selectedRows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Status</th><th>Submitted time (IST)</th><th>Slot</th><th>Mode / format</th><th>Entry / team</th><th>Roster</th><th>Room</th><th>Contact</th><th>Payment ref</th></tr></thead><tbody>${selectedRows.map((reg) => `<tr><td>${registrationStatusBadge(reg.status)}</td><td>${escapeHtml(registrationTimeLabel(reg))}</td><td>${slotLabel(reg)}</td><td>${escapeHtml(reg.modeLabel || "-")} · ${escapeHtml(registrationFormatLabel(reg) || reg.variant || "-")}</td><td>${escapeHtml(reg.teamName || "-")}</td><td>${playerListHtml(reg)}</td><td>${escapeHtml(reg.roomId || "-")}</td><td>${escapeHtml(reg.whatsapp || "-")}</td><td>${escapeHtml(reg.paymentRef || "-")}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="empty-state compact-empty"><h3>No registrations for this date</h3><p>Entries submitted on this day will appear here.</p></div>`;
    dayDetails.innerHTML = `<h3>${escapeHtml(dateTitle)}</h3><div class="calendar-date-status" role="status">${registrationsStatus}${resultsStatus}<p class="disclaimer">The match date field below is set to ${escapeHtml(dateTitle)}.</p></div>${table}`;
  }
}
function populateAdminSettingsFromSummary(summary = {}) {
  const settings = summary.scheduleSettings || { br: { startTime: "21:00", durationHours: 1, gapHours: 0 }, cs: { startTime: "21:00", durationHours: 1, gapHours: 0 } };
  ["br", "cs"].forEach((mode) => {
    const conf = settings[mode] || {};
    populateAdminTimeSelect($(mode === "br" ? "#br-start-time" : "#cs-start-time"), conf.startTime || "21:00");
    const duration = $(mode === "br" ? "#br-duration" : "#cs-duration");
    const gap = $(mode === "br" ? "#br-gap" : "#cs-gap");
    if (duration) duration.value = String(conf.durationHours || 1);
    if (gap) gap.value = String(conf.gapHours ?? 0);
  });
  const payment = summary.paymentSettings || {};
  if ($("#payment-payee")) $("#payment-payee").value = payment.payeeName || "";
  if ($("#payment-upi-id")) $("#payment-upi-id").value = payment.upiId || "";
  if ($("#payment-note")) $("#payment-note").value = payment.note || "";
  PAYMENT_QR_DATA = payment.qrDataUrl || "";
  setQrPreview("payment", PAYMENT_QR_DATA);
  const boardView = $("#leaderboard-default-view");
  if (boardView) boardView.value = summary.leaderboardSettings?.defaultView === "all" ? "all" : "latest";
  updateAdminStorageStatus(summary.storageInfo);
  updateAdminSchedulePreview();
  loadRoomDetailAdminFields();
}

function setupAdminPage() {
  const unlock = $("#admin-unlock");
  const pin = $("#admin-pin");
  const panel = $("#admin-panel");
  if (!unlock || !panel || unlock.dataset.bound === "true") return;
  unlock.dataset.bound = "true";

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
  $("#admin-cs-format")?.addEventListener("change", updateAdminRoomChoices);
  $("#admin-variant")?.addEventListener("change", updateAdminRoomChoices);
  $("#save-room-count")?.addEventListener("click", saveAdminRoomCount);
  $("#save-final-scores")?.addEventListener("click", saveFinalScores);
  $("#admin-result-date")?.addEventListener("change", handleAdminResultDateChange);
  $("#save-leaderboard-settings")?.addEventListener("click", saveLeaderboardSettings);
  $("#export-registrations")?.addEventListener("click", exportRegistrationsCsv);
  $("#clear-registrations")?.addEventListener("click", clearRegistrations);
  $("#export-state")?.addEventListener("click", exportStateJson);
  $("#import-state")?.addEventListener("click", importStateJson);
  $("#reset-admin-state")?.addEventListener("click", resetAdminState);
  $("#room-share-mode")?.addEventListener("change", updateRoomShareChoices);
  $("#room-share-fee")?.addEventListener("change", updateRoomShareChoices);
  $("#room-share-format")?.addEventListener("change", updateRoomShareChoices);
  $("#room-share-cs-format")?.addEventListener("change", updateRoomShareChoices);
  $("#room-share-variant")?.addEventListener("change", updateRoomShareChoices);
  $("#save-room-details")?.addEventListener("click", saveRoomDetails);
  $("#delete-room-details")?.addEventListener("click", removeRoomDetails);
  $("#save-schedule-settings")?.addEventListener("click", saveScheduleSettings);
  $("#save-payment-settings")?.addEventListener("click", savePaymentSettings);
  ["#br-start-time", "#br-duration", "#br-gap", "#cs-start-time", "#cs-duration", "#cs-gap"].forEach((selector) => $(selector)?.addEventListener("change", updateAdminSchedulePreview));
  $("#payment-qr-file")?.addEventListener("change", () => handleQrFile("payment"));
  $("#room-qr-file")?.addEventListener("change", () => handleQrFile("room"));
  $("#clear-payment-qr")?.addEventListener("click", () => { PAYMENT_QR_DATA = ""; if ($("#payment-qr-file")) $("#payment-qr-file").value = ""; setQrPreview("payment", ""); });
  $("#clear-room-qr")?.addEventListener("click", () => { ROOM_QR_DATA = ""; if ($("#room-qr-file")) $("#room-qr-file").value = ""; setQrPreview("room", ""); });
  $("#room-share-room")?.addEventListener("change", loadRoomDetailAdminFields);
  $("#edit-registration-form")?.addEventListener("submit", saveRegistrationEdits);
  $("#edit-registration-close")?.addEventListener("click", () => $("#edit-registration-modal")?.close());
  $("#edit-registration-cancel")?.addEventListener("click", () => $("#edit-registration-modal")?.close());
}

function renderAdminPanel() {
  populateFeeSelect($("#admin-fee"), getFeeTiers("br")[0], "br");
  populateFormatSelect($("#admin-format"), "solo");
  populateCSFormatSelect($("#admin-cs-format"), "squad");
  updateAdminRoomChoices();
  updateRoomShareChoices();
  populateAdminSettingsFromSummary(ADMIN_SUMMARY || {});
  renderAdminTables();
}

function updateAdminRoomChoices() {
  const mode = $("#admin-mode")?.value || "br";
  const fee = Number($("#admin-fee")?.value || getFeeTiers(mode)[0]);
  const variantWrap = $("#admin-variant-wrap");
  const formatWrap = $("#admin-format-wrap");
  const csFormatWrap = $("#admin-cs-format-wrap");
  const variant = $("#admin-variant")?.value || "Normal";
  const format = $("#admin-format")?.value || "solo";
  const csFormat = $("#admin-cs-format")?.value || "squad";
  if (variantWrap) variantWrap.classList.toggle("hidden", mode !== "cs");
  if (formatWrap) formatWrap.classList.toggle("hidden", mode !== "br");
  if (csFormatWrap) csFormatWrap.classList.toggle("hidden", mode !== "cs");
  const rooms = getRooms({
    mode,
    fee,
    variant: mode === "cs" ? variant : undefined,
    format: mode === "cs" ? csFormat : format
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
  try {
    if (SERVER_AVAILABLE && currentAdminPin) {
      await apiPost("/api/admin/room-count", { pin: currentAdminPin, roomId: room.id, count });
      await refreshStateFromServer();
      await renderAdminTables();
      renderPage();
      showAdminConfirmation("Room count updated");
      return;
    }
    const state = loadState();
    state.roomOverrides[room.id] = count;
    saveState(state);
    await renderAdminTables();
    renderPage();
    showAdminConfirmation("Room count saved on this device");
  } catch (error) {
    toast(error.message || "Could not save the room count.", true);
  }
}

function updateRoomShareChoices() {
  populateFeeSelect($("#room-share-fee"), Number($("#room-share-fee")?.value || getFeeTiers("br")[0]), $("#room-share-mode")?.value || "br");
  populateFormatSelect($("#room-share-format"), $("#room-share-format")?.value || "solo");
  populateCSFormatSelect($("#room-share-cs-format"), $("#room-share-cs-format")?.value || "squad");
  const mode = $("#room-share-mode")?.value || "br";
  const fee = Number($("#room-share-fee")?.value || getFeeTiers(mode)[0]);
  const formatWrap = $("#room-share-format-wrap");
  const csFormatWrap = $("#room-share-cs-format-wrap");
  const variantWrap = $("#room-share-variant-wrap");
  const format = $("#room-share-format")?.value || "solo";
  const csFormat = $("#room-share-cs-format")?.value || "squad";
  const variant = $("#room-share-variant")?.value || "Normal";
  formatWrap?.classList.toggle("hidden", mode !== "br");
  csFormatWrap?.classList.toggle("hidden", mode !== "cs");
  variantWrap?.classList.toggle("hidden", mode !== "cs");
  const rooms = getRooms({ mode, fee, format: mode === "br" ? format : csFormat, variant: mode === "cs" ? variant : undefined });
  const select = $("#room-share-room");
  if (!select) return;
  const previousRoom = select.value;
  select.innerHTML = rooms.map((room) => `<option value="${escapeHtml(room.id)}">${escapeHtml(room.title)} (${getConfirmedTeams(room)}/${room.capacity} ${entryLabel(room)})</option>`).join("");
  if (rooms.some((room) => room.id === previousRoom)) select.value = previousRoom;
  loadRoomDetailAdminFields();
}

function setQrPreview(kind, dataUrl) {
  const wrap = $(`#${kind}-qr-preview-wrap`);
  const image = $(`#${kind}-qr-preview`);
  if (image) image.src = dataUrl || "";
  if (wrap) wrap.classList.toggle("hidden", !dataUrl);
}

function handleQrFile(kind) {
  const input = $(`#${kind}-qr-file`);
  const file = input?.files?.[0];
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    toast("Choose a PNG, JPG, or WebP QR image.", true);
    input.value = "";
    return;
  }
  if (file.size > 1_000_000) {
    toast("QR image must be 1 MB or smaller.", true);
    input.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const value = String(reader.result || "");
    if (kind === "payment") PAYMENT_QR_DATA = value;
    else ROOM_QR_DATA = value;
    setQrPreview(kind, value);
  };
  reader.onerror = () => toast("Could not read QR image.", true);
  reader.readAsDataURL(file);
}

function loadRoomDetailAdminFields() {
  const roomId = $("#room-share-room")?.value;
  if (!roomId) return;
  const details = ADMIN_SUMMARY?.roomDetails || loadState().roomDetails || {};
  const detail = details[roomId] || {};
  if ($("#custom-room-id")) $("#custom-room-id").value = detail.customRoomId || "";
  if ($("#custom-room-password")) $("#custom-room-password").value = detail.password || "";
  if ($("#custom-room-message")) $("#custom-room-message").value = detail.message || "";
  if ($("#room-published")) $("#room-published").checked = detail.published !== false;
  if ($("#room-force-publish")) $("#room-force-publish").checked = Boolean(detail.forcePublish);
  ROOM_QR_DATA = detail.roomQrDataUrl || "";
  setQrPreview("room", ROOM_QR_DATA);
  if ($("#room-qr-file")) $("#room-qr-file").value = "";
}

async function saveRoomDetails() {
  const roomId = $("#room-share-room")?.value;
  const customRoomId = clean($("#custom-room-id")?.value);
  const password = clean($("#custom-room-password")?.value);
  const message = clean($("#custom-room-message")?.value);
  const forcePublish = Boolean($("#room-force-publish")?.checked);
  const published = Boolean($("#room-published")?.checked);
  if (!roomId || !customRoomId || !password) return toast("Select room and enter room ID plus password.", true);
  const detail = { roomId, customRoomId, password, message, roomQrDataUrl: ROOM_QR_DATA, forcePublish, published, updatedAt: new Date().toISOString() };
  try {
    if (SERVER_AVAILABLE && currentAdminPin) {
      await apiPost("/api/admin/room-details", { pin: currentAdminPin, detail });
      await refreshStateFromServer();
      await renderAdminTables();
      renderPage();
      const roomSaveTitle = !published
        ? "Room details saved (hidden)"
        : forcePublish
          ? "Room details released"
          : "Room details saved; release when full";
      showAdminConfirmation(roomSaveTitle);
      return;
    }
    const state = loadState();
    state.roomDetails[roomId] = detail;
    saveState(state);
    showAdminConfirmation("Room details saved on this device");
    renderRoomDetailsPage();
  } catch (error) {
    toast(error.message || "Could not save room details.", true);
  }
}

async function removeRoomDetails() {
  const roomId = $("#room-share-room")?.value;
  if (!roomId) return toast("Select a website room first.", true);
  const details = ADMIN_SUMMARY?.roomDetails || loadState().roomDetails || {};
  if (!details[roomId]) return toast("No saved room details exist for this lobby.");
  const room = getRoom(roomId);
  if (!confirm(`Remove saved room ID, password, and QR for ${room?.title || roomId}? This will hide them from the public Room Details page. Registrations will not be changed.`)) return;
  try {
    if (SERVER_AVAILABLE && currentAdminPin) {
      await apiPost("/api/admin/delete-room-details", { pin: currentAdminPin, roomId });
      await refreshStateFromServer();
      await renderAdminTables();
      renderPage();
      showAdminConfirmation("Room details removed");
      return;
    }
    const state = loadState();
    delete state.roomDetails[roomId];
    saveState(state);
    ADMIN_SUMMARY = { ...(ADMIN_SUMMARY || {}), roomDetails: state.roomDetails };
    loadRoomDetailAdminFields();
    renderRoomDetailsPage();
    showAdminConfirmation("Room details removed on this device");
  } catch (error) {
    toast(error.message || "Could not remove room details.", true);
  }
}

function buildClientScheduleWindows(settings) {
  const output = { br: [], cs: [] };
  ["br", "cs"].forEach((mode) => {
    const conf = settings[mode];
    const [hour, minute] = conf.startTime.split(":").map(Number);
    for (let index = 0; index < 3; index += 1) {
      const start = hour * 60 + minute + index * (Number(conf.durationHours) + Number(conf.gapHours)) * 60;
      const end = start + Number(conf.durationHours) * 60;
      const format = (total) => {
        const day = Math.floor(total / 1440);
        const minuteOfDay = total % 1440;
        const h = Math.floor(minuteOfDay / 60);
        const m = minuteOfDay % 60;
        return { text: formatClockForAdmin(h, m), day };
      };
      const from = format(start);
      const to = format(end);
      const daySuffix = from.day > 0 ? " (+1 day)" : to.day > from.day ? (end % 1440 === 0 ? " (midnight)" : " (+1 day)") : "";
      output[mode].push({ id: `slot${index + 1}`, label: `Slot ${index + 1}`, time: `${from.text}–${to.text}${daySuffix}`, durationHours: Number(conf.durationHours), matches: mode === "br" ? 3 : 1 });
    }
  });
  return output;
}

async function saveLeaderboardSettings() {
  const defaultView = $("#leaderboard-default-view")?.value || "latest";
  if (!["latest", "all"].includes(defaultView)) return toast("Choose a valid public leaderboard view.", true);
  try {
    if (SERVER_AVAILABLE && currentAdminPin) {
      await apiPost("/api/admin/leaderboard-settings", { pin: currentAdminPin, settings: { defaultView } });
      await refreshStateFromServer();
      await renderAdminTables();
      showAdminConfirmation("Leaderboard default saved");
      return;
    }
    const state = loadState();
    state.leaderboardSettings = { defaultView };
    saveState(state);
    await renderAdminTables();
    showAdminConfirmation("Leaderboard default saved on this device");
  } catch (error) {
    toast(error.message || "Could not save the leaderboard default.", true);
  }
}

async function saveScheduleSettings() {
  const settings = adminScheduleSettingsFromControls();
  try {
    if (SERVER_AVAILABLE && currentAdminPin) {
      await apiPost("/api/admin/schedule-settings", { pin: currentAdminPin, settings });
      await refreshStateFromServer();
      await renderAdminTables();
      renderSchedulePage();
      showAdminConfirmation("Match schedule published");
      return;
    }
    const state = loadState();
    state.scheduleWindows = buildClientScheduleWindows(settings);
    state.scheduleSettings = settings;
    saveState(state);
    SERVER_STATE = state;
    SERVER_AVAILABLE = false;
    renderSchedulePage();
    populateMatchTimeSelects();
    showAdminConfirmation("Timings saved on this device");
  } catch (error) {
    toast(error.message || "Could not save schedule settings.", true);
  }
}

async function savePaymentSettings() {
  const settings = {
    payeeName: clean($("#payment-payee")?.value),
    upiId: clean($("#payment-upi-id")?.value),
    note: clean($("#payment-note")?.value),
    qrDataUrl: PAYMENT_QR_DATA
  };
  try {
    if (SERVER_AVAILABLE && currentAdminPin) {
      await apiPost("/api/admin/payment-settings", { pin: currentAdminPin, settings });
      await refreshStateFromServer();
      await renderAdminTables();
      $$('[data-registration-form]').forEach(renderPaymentInstructions);
      showAdminConfirmation("Payment settings saved");
      return;
    }
    const state = loadState();
    state.paymentSettings = settings;
    saveState(state);
    SERVER_STATE = state;
    $$('[data-registration-form]').forEach(renderPaymentInstructions);
    showAdminConfirmation("Payment details saved on this device");
  } catch (error) {
    toast(error.message || "Could not save payment instructions.", true);
  }
}

async function renderAdminTables() {
  let state = loadState();
  let summaryForCards = null;
  if (SERVER_AVAILABLE && currentAdminPin) {
    try {
      const summary = await apiPost("/api/admin/summary", { pin: currentAdminPin });
      summaryForCards = summary;
      ADMIN_SUMMARY = summary;
      state = normalizeState({ ...loadState(), registrations: summary.registrations || [] });
      ADMIN_REGISTRATIONS = summary.registrations || [];
      renderAdminSummaryCards(summary);
      populateAdminSettingsFromSummary(summary);
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
      approvedExpectedAmount: ADMIN_REGISTRATIONS.filter((r) => String(r.status || "").toLowerCase() === "approved").reduce((sum, r) => sum + Number(r.fee || 0), 0),
      scheduleSettings: loadState().scheduleSettings || { br: { startTime: "21:00", durationHours: 1, gapHours: 0 }, cs: { startTime: "21:00", durationHours: 1, gapHours: 0 } },
      paymentSettings: loadState().paymentSettings || {},
      roomDetails: loadState().roomDetails || {},
      matchHistory: loadState().matchHistory || [],
      leaderboardSettings: loadState().leaderboardSettings || { defaultView: "latest" },
      storageInfo: null
    };
    ADMIN_SUMMARY = summaryForCards;
    renderAdminSummaryCards(summaryForCards);
    populateAdminSettingsFromSummary(summaryForCards);
  }

  renderFinalScoreTable();

  const regs = $("#admin-registrations");
  if (regs) {
    if (!state.registrations.length) {
      regs.innerHTML = `<div class="empty-state"><h3>No registrations yet</h3><p>Live registrations will appear here after players submit forms.</p></div>`;
    } else {
      regs.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Status</th><th>Slot</th><th>Actions</th><th>ID</th><th>Mode</th><th>Format/Type</th><th>Match time</th><th>Room</th><th>Team/Entry</th><th>IGL/Player</th><th>Players</th><th>WhatsApp</th><th>Fee</th><th>Payment Ref</th><th>Time</th></tr></thead><tbody>${state.registrations.map((r) => `
        <tr>
          <td>${registrationStatusBadge(r.status)}</td>
          <td>${slotLabel(r)}</td>
          <td class="admin-row-actions">
            <button class="btn small" type="button" data-reg-action="Approved" data-reg-id="${escapeHtml(r.id)}">Approve</button>
            <button class="btn small ghost danger" type="button" data-reg-action="Rejected" data-reg-id="${escapeHtml(r.id)}">Reject</button>
            <button class="btn small ghost" type="button" data-reg-edit="${escapeHtml(r.id)}">Edit names</button>
            <button class="btn small ghost danger" type="button" data-reg-delete="${escapeHtml(r.id)}">Remove</button>
          </td>
          <td>${escapeHtml(r.id)}</td>
          <td>${escapeHtml(r.modeLabel)}</td>
          <td>${escapeHtml(registrationFormatLabel(r) || r.variant || "-")}</td>
          <td>${escapeHtml(r.scheduleTime || r.scheduleSlotLabel || "-")}</td>
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
      $$('[data-reg-edit]', regs).forEach((button) => button.addEventListener("click", () => openRegistrationEditor(button.dataset.regEdit)));
      $$('[data-reg-delete]', regs).forEach((button) => button.addEventListener("click", () => deleteRegistration(button.dataset.regDelete)));
    }
  }
  renderAdminCalendar(ADMIN_REGISTRATIONS);
  renderLeaderboards("#admin-br-preview", "br");
  renderLeaderboards("#admin-cs-preview", "cs");
}

function openRegistrationEditor(registrationId) {
  const reg = ADMIN_REGISTRATIONS.find((item) => String(item.id) === String(registrationId));
  if (!reg) return toast("Registration not found.", true);
  EDITING_REGISTRATION_ID = String(reg.id);
  const teamField = $("#edit-team-name");
  const list = $("#edit-player-list");
  if (teamField) teamField.value = reg.teamName || "";
  if (list) {
    const players = Array.isArray(reg.players) && reg.players.length ? reg.players : [{ ign: reg.iglName || reg.captainName || "", uid: reg.iglUid || "" }];
    list.innerHTML = players.slice(0, 4).map((player, index) => `
      <div class="edit-player-row" data-edit-player-row="${index}">
        <label>${index === 0 ? "Player 1 / IGL IGN" : `Player ${index + 1} IGN`}
          <input type="text" maxlength="80" data-edit-player-name value="${escapeHtml(player.ign || "")}" ${index === 0 ? "required" : ""} />
        </label>
        <small>Free Fire ID: ${escapeHtml(player.uid || "not provided")}</small>
        ${index > 0 ? `<label class="checkbox-line"><input type="checkbox" data-edit-player-remove /> Remove Player ${index + 1} from this roster</label>` : `<small>Player 1/IGL must remain, but the name can be changed.</small>`}
      </div>`).join("");
  }
  const modal = $("#edit-registration-modal");
  if (modal?.showModal) modal.showModal();
  else modal?.classList.remove("hidden");
}

async function saveRegistrationEdits(event) {
  event.preventDefault();
  const reg = ADMIN_REGISTRATIONS.find((item) => String(item.id) === EDITING_REGISTRATION_ID);
  if (!reg) return toast("Registration not found.", true);
  const teamName = clean($("#edit-team-name")?.value);
  if (!teamName) return toast("Enter an entry/team name.", true);
  const existingPlayers = Array.isArray(reg.players) ? reg.players : [];
  const playerRows = $$("[data-edit-player-row]", $("#edit-player-list"));
  const players = playerRows.map((row, index) => ({
    ign: clean($("[data-edit-player-name]", row)?.value),
    uid: existingPlayers[index]?.uid || (index === 0 ? reg.iglUid || "" : ""),
    remove: Boolean($("[data-edit-player-remove]", row)?.checked)
  }));
  if (!players.length || !players[0].ign) return toast("Player 1/IGL name cannot be blank.", true);
  if (players.some((player, index) => index > 0 && !player.remove && !player.ign)) return toast("Fill a name or choose Remove for each teammate.", true);
  const payload = { registrationId: reg.id, teamName, iglName: players[0].ign, players };
  try {
    if (SERVER_AVAILABLE && currentAdminPin) {
      await apiPost("/api/admin/edit-registration", { pin: currentAdminPin, ...payload });
      await refreshStateFromServer();
    } else {
      const state = loadState();
      const localReg = state.registrations.find((item) => String(item.id) === EDITING_REGISTRATION_ID);
      if (!localReg) throw new Error("Registration not found on this device.");
      localReg.teamName = teamName;
      localReg.iglName = players[0].ign;
      localReg.captainName = players[0].ign;
      localReg.iglUid = players[0].uid;
      localReg.players = players.filter((player, index) => index === 0 || !player.remove).map(({ ign, uid }) => ({ ign, uid }));
      localReg.playersPerEntry = localReg.players.length;
      saveState(state);
    }
    $("#edit-registration-modal")?.close();
    await renderAdminTables();
    renderLeaderboards("#admin-br-preview", "br");
    renderLeaderboards("#admin-cs-preview", "cs");
    showAdminConfirmation("Registration updated");
  } catch (error) {
    toast(error.message || "Could not save registration edits.", true);
  }
}

async function deleteRegistration(registrationId) {
  const reg = ADMIN_REGISTRATIONS.find((item) => String(item.id) === String(registrationId));
  if (!reg) return toast("Registration not found.", true);
  if (!confirm(`Remove ${reg.teamName || "this registration"}? This frees the reserved lobby slot and cannot be undone.`)) return;
  try {
    if (SERVER_AVAILABLE && currentAdminPin) {
      await apiPost("/api/admin/delete-registration", { pin: currentAdminPin, registrationId });
      await refreshStateFromServer();
    } else {
      const state = loadState();
      state.registrations = (state.registrations || []).filter((item) => String(item.id) !== String(registrationId));
      saveState(state);
    }
    await renderAdminTables();
    renderPage();
    showAdminConfirmation("Registration removed");
  } catch (error) {
    toast(error.message || "Could not remove registration.", true);
  }
}

function handleAdminResultDateChange() {
  const value = $("#admin-result-date")?.value || todayDateIST();
  ADMIN_CALENDAR_SELECTED_DATE = value;
  const monthInput = $("#registration-calendar-month");
  if (monthInput && value.length >= 7 && monthInput.value !== value.slice(0, 7)) monthInput.value = value.slice(0, 7);
  renderAdminCalendar(ADMIN_REGISTRATIONS);
  renderFinalScoreTable();
}

function renderFinalScoreTable() {
  const box = $("#final-score-table");
  if (!box) return;
  const dateInput = $("#admin-result-date");
  if (dateInput && !dateInput.value) dateInput.value = todayDateIST();
  const matchDate = dateInput?.value || todayDateIST();
  const history = ADMIN_SUMMARY?.matchHistory || [];
  const approved = ADMIN_REGISTRATIONS.filter((reg) => String(reg.status || "").toLowerCase() === "approved").sort((a, b) => String(a.roomId || "").localeCompare(String(b.roomId || "")) || Number(a.slotNumber || 99) - Number(b.slotNumber || 99));
  if (!approved.length) {
    box.innerHTML = `<div class="empty-state"><h3>No approved teams to score yet</h3><p>Approve registrations above. Each approved entry will appear here with the correct match-result controls.</p></div>`;
    return;
  }
  const rows = approved.map((reg) => {
    const mode = reg.mode || (String(reg.roomId || "").startsWith("CS-") ? "cs" : "br");
    const saved = history.find((item) => String(item.registrationId) === String(reg.id) && item.date === matchDate);
    const legacyCurrent = !saved && String(reg.scoreUpdatedAt || "").slice(0, 10) === matchDate ? reg : null;
    const resultSource = saved || legacyCurrent || {};
    const brMatches = Array.isArray(resultSource.brMatches) ? resultSource.brMatches : [];
    const csResult = resultSource.csResult || {};
    const resultControl = mode === "br" ? `<div class="br-score-editor">${[0, 1, 2].map((index) => {
      const match = brMatches[index] || {};
      const positionOptions = [`<option value="">Place</option>`, ...Array.from({ length: 12 }, (_, posIndex) => {
        const position = posIndex + 1;
        const selected = Number(match.position) === position ? "selected" : "";
        return `<option value="${position}" ${selected}>#${position} · ${DATA.scoring.br.placement[position]} pts</option>`;
      })].join("");
      return `<fieldset class="br-match-input"><legend>Match ${index + 1}</legend><label>Kills<input class="score-input" type="number" min="0" max="99" step="1" inputmode="numeric" data-match-kills="${escapeHtml(reg.id)}" data-match-index="${index}" value="${match.kills ?? ""}" aria-label="Kills in match ${index + 1} for ${escapeHtml(reg.teamName || "team")}" /></label><label>Placement<select data-match-position="${escapeHtml(reg.id)}" data-match-index="${index}" aria-label="Placement in match ${index + 1} for ${escapeHtml(reg.teamName || "team")}">${positionOptions}</select></label></fieldset>`;
    }).join("")}</div>` : `<div class="cs-score-editor"><label>Match result<select data-cs-outcome="${escapeHtml(reg.id)}"><option value="" ${!csResult.outcome ? "selected" : ""}>Not entered</option><option value="Win" ${csResult.outcome === "Win" ? "selected" : ""}>Win · 3 points</option><option value="Loss" ${csResult.outcome === "Loss" ? "selected" : ""}>Loss · 0 points</option></select></label><label>Round difference<input class="score-input" type="number" min="-99" max="99" step="1" data-cs-round-diff="${escapeHtml(reg.id)}" value="${csResult.roundDiff ?? ""}" placeholder="e.g. 3 or -2" /></label></div>`;
    const datePoints = saved || legacyCurrent ? (resultSource.finalScore ?? "—") : "—";
    return `<tr><td><b>${slotLabel(reg)}</b></td><td><strong>${escapeHtml(reg.teamName || "-")}</strong><br><small>${playerListHtml(reg)}</small></td><td>${escapeHtml(reg.modeLabel || "-")} · ${escapeHtml(registrationFormatLabel(reg) || reg.variant || "-")}<br><small>${escapeHtml(reg.scheduleTime || "")}</small></td><td>${resultControl}</td><td><b>${escapeHtml(datePoints)}</b></td></tr>`;
  }).join("");
  box.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Slot</th><th>Entry / roster</th><th>Mode · time</th><th>Verified result inputs · ${escapeHtml(formatIsoDate(matchDate))}</th><th>Date points</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function saveFinalScores() {
  if (!ADMIN_REGISTRATIONS.length) return toast("No registrations loaded.", true);
  const approved = ADMIN_REGISTRATIONS.filter((reg) => String(reg.status || "").toLowerCase() === "approved");
  if (!approved.length) return toast("Approve at least one registration first.", true);
  const matchDate = $("#admin-result-date")?.value || todayDateIST();
  const parsedMatchDate = new Date(`${matchDate}T12:00:00+05:30`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(matchDate) || Number.isNaN(parsedMatchDate.getTime()) || parsedMatchDate.toISOString().slice(0, 10) !== matchDate) return toast("Choose a valid match date.", true);
  const results = [];
  for (const reg of approved) {
    const mode = reg.mode || (String(reg.roomId || "").startsWith("CS-") ? "cs" : "br");
    if (mode === "br") {
      const matches = [0, 1, 2].map((index) => {
        const killsInput = $(`[data-match-kills="${CSS.escape(String(reg.id))}"][data-match-index="${index}"]`);
        const positionInput = $(`[data-match-position="${CSS.escape(String(reg.id))}"][data-match-index="${index}"]`);
        const kills = killsInput?.value.trim() || "";
        const position = positionInput?.value || "";
        return { kills: kills === "" ? null : Number(kills), position: position === "" ? null : Number(position) };
      });
      if (matches.some((match) => (match.kills === null) !== (match.position === null))) return toast(`Enter both kills and placement, or leave both blank, for ${reg.teamName}.`, true);
      if (matches.some((match) => match.kills !== null && match.position !== null)) results.push({ registrationId: reg.id, matches });
    } else {
      const outcome = $(`[data-cs-outcome="${CSS.escape(String(reg.id))}"]`)?.value || "";
      const rawRoundDiff = $(`[data-cs-round-diff="${CSS.escape(String(reg.id))}"]`)?.value.trim() || "";
      const roundDiff = rawRoundDiff === "" ? 0 : Number(rawRoundDiff);
      if (!Number.isInteger(roundDiff) || roundDiff < -99 || roundDiff > 99) return toast(`Enter a valid round difference for ${reg.teamName}.`, true);
      if (outcome) results.push({ registrationId: reg.id, csResult: { outcome, roundDiff } });
    }
  }
  if (!results.length) return toast("Enter at least one played match result before saving.", true);
  try {
    if (SERVER_AVAILABLE && currentAdminPin) {
      await apiPost("/api/admin/match-results", { pin: currentAdminPin, matchDate, results });
      await refreshStateFromServer();
      await renderAdminTables();
      renderLeaderboards("#admin-br-preview", "br");
      renderLeaderboards("#admin-cs-preview", "cs");
      showAdminConfirmation("Dated match results saved");
      return;
    }
    const state = loadState();
    state.matchHistory = Array.isArray(state.matchHistory) ? state.matchHistory : [];
    results.forEach((item) => {
      const reg = (state.registrations || []).find((entry) => String(entry.id) === String(item.registrationId));
      if (!reg || String(reg.status || "").toLowerCase() !== "approved") return;
      let mode = "br";
      let brMatches = [];
      let csResult = null;
      let finalScore = null;
      if (item.matches) {
        brMatches = item.matches.map((match) => {
          if (match.kills === null || match.position === null) return { kills: null, position: null, score: null };
          const score = Number(match.kills) + Number(DATA.scoring.br.placement[match.position] || 0);
          return { ...match, score };
        });
        const scored = brMatches.filter((match) => match.score !== null);
        finalScore = scored.reduce((sum, match) => sum + match.score, 0);
      } else {
        mode = "cs";
        csResult = { outcome: item.csResult.outcome, roundDiff: item.csResult.roundDiff };
        finalScore = item.csResult.outcome === "Win" ? 3 : 0;
      }
      const stamp = new Date().toISOString();
      const registrationId = String(reg.id || "");
      const savedRow = {
        registrationId,
        entryKey: stableLocalEntryKey(registrationId),
        date: matchDate,
        mode,
        teamName: reg.teamName,
        modeLabel: reg.modeLabel,
        format: reg.format,
        formatLabel: registrationFormatLabel(reg),
        variant: reg.variant,
        roomId: reg.roomId,
        roomTitle: reg.roomTitle,
        slotNumber: reg.slotNumber,
        slotCapacity: reg.slotCapacity,
        scheduleSlotLabel: reg.scheduleSlotLabel,
        scheduleTime: reg.scheduleTime,
        players: (reg.players || []).map((player) => player.ign).filter(Boolean),
        fee: reg.fee,
        brMatches,
        csResult,
        finalScore,
        lastMatchScore: [...brMatches].reverse().find((match) => match.score !== null)?.score ?? null,
        csRoundDiff: csResult?.roundDiff ?? null,
        scoreUpdatedAt: stamp
      };
      const index = state.matchHistory.findIndex((row) => String(row.registrationId) === registrationId && row.date === matchDate);
      if (index >= 0) state.matchHistory[index] = savedRow;
      else state.matchHistory.push(savedRow);
      const latestDate = state.matchHistory.filter((row) => String(row.registrationId) === registrationId).map((row) => row.date).sort().at(-1);
      if (!latestDate || matchDate >= latestDate) {
        if (mode === "br") {
          reg.brMatches = brMatches;
          delete reg.csResult;
        } else {
          reg.csResult = csResult;
          delete reg.brMatches;
        }
        reg.finalScore = finalScore;
        reg.scoreUpdatedAt = stamp;
      }
    });
    state.matchHistory.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.registrationId).localeCompare(String(b.registrationId)));
    saveState(state);
    ADMIN_REGISTRATIONS = state.registrations || [];
    await renderAdminTables();
    showAdminConfirmation("Dated results saved on this device");
  } catch (error) {
    toast(error.message || "Could not save match results.", true);
  }
}

async function updateRegistrationStatus(registrationId, status) {
  if (!registrationId) return;
  try {
    if (SERVER_AVAILABLE && currentAdminPin) {
      const result = await apiPost("/api/admin/registration-status", { pin: currentAdminPin, registrationId, status });
      await refreshStateFromServer();
      await renderAdminTables();
      renderPage();
      const slotText = result.registration?.slotNumber ? ` · slot ${result.registration.slotNumber}/${result.registration.slotCapacity}` : "";
      showAdminConfirmation(`Registration ${status.toLowerCase()}${slotText}`);
      return;
    }
    const state = loadState();
    const reg = state.registrations.find((r) => r.id === registrationId);
    if (!reg) throw new Error("Registration not found on this device.");
    reg.status = status;
    state.registrationCounts = {};
    (state.registrations || []).forEach((entry) => {
      if (String(entry.status || "Pending").toLowerCase() === "rejected") return;
      state.registrationCounts[entry.roomId] = Number(state.registrationCounts[entry.roomId] || 0) + 1;
    });
    saveState(state);
    await renderAdminTables();
    renderPage();
    showAdminConfirmation(`Registration ${status.toLowerCase()} saved on this device`);
  } catch (error) {
    toast(error.message || "Could not update registration status.", true);
  }
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
  const headers = ["id", "status", "slotNumber", "mode", "formatOrType", "playersPerEntry", "scheduleTime", "roomId", "fee", "feeRule", "teamName", "finalScore", "iglName", "iglUid", "whatsapp", "paymentRef", "submittedAt", "p1Name", "p1Uid", "p2Name", "p2Uid", "p3Name", "p3Uid", "p4Name", "p4Uid"];
  const rows = state.registrations.map((r) => {
    const flat = {
      id: r.id, status: r.status, slotNumber: r.slotNumber, mode: r.modeLabel, formatOrType: registrationFormatLabel(r) || r.variant || "", playersPerEntry: r.playersPerEntry || "", scheduleTime: r.scheduleTime || r.scheduleSlotLabel || "", roomId: r.roomId, fee: r.fee, feeRule: r.feeRule || "", teamName: r.teamName, finalScore: r.finalScore ?? "", iglName: r.iglName || r.captainName, iglUid: r.iglUid || r.players?.[0]?.uid, whatsapp: r.whatsapp, paymentRef: r.paymentRef, submittedAt: r.submittedAt,
      p1Name: r.players?.[0]?.ign, p1Uid: r.players?.[0]?.uid, p2Name: r.players?.[1]?.ign, p2Uid: r.players?.[1]?.uid, p3Name: r.players?.[2]?.ign, p3Uid: r.players?.[2]?.uid, p4Name: r.players?.[3]?.ign, p4Uid: r.players?.[3]?.uid
    };
    return headers.map((h) => csvEscape(flat[h])).join(",");
  });
  downloadFile(`nith-free-fire-registrations-${new Date().toISOString().slice(0, 10)}.csv`, [headers.join(","), ...rows].join("\n"), "text/csv");
}

async function clearRegistrations() {
  if (!confirm("Clear registrations? This cannot be undone.")) return;
  try {
    if (SERVER_AVAILABLE && currentAdminPin) {
      await apiPost("/api/admin/clear-registrations", { pin: currentAdminPin });
      await refreshStateFromServer();
      await renderAdminTables();
      renderPage();
      showAdminConfirmation("Registrations cleared");
      return;
    }
    const state = loadState();
    state.registrations = [];
    saveState(state);
    await renderAdminTables();
    renderPage();
    showAdminConfirmation("Registrations cleared on this device");
  } catch (error) {
    toast(error.message || "Could not clear registrations.", true);
  }
}


function exportStateJson() {
  const state = loadState();
  const exportable = {
    roomOverrides: state.roomOverrides,
    registrationCounts: state.registrationCounts,
    roomDetails: state.roomDetails,
    leaderboard: state.leaderboard,
    matchHistory: state.matchHistory || [],
    leaderboardSettings: state.leaderboardSettings || { defaultView: "latest" },
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
    state.matchHistory = incoming.matchHistory || state.matchHistory;
    state.leaderboardSettings = incoming.leaderboardSettings || state.leaderboardSettings;
    state.notices = incoming.notices || state.notices;
    saveState(state);
    renderAdminTables();
    renderPage();
    showAdminConfirmation("Admin state imported");
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
  showAdminConfirmation("Local admin state reset");
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

function toast(message, isError = false, durationMs = null) {
  let el = $(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.setAttribute("role", isError ? "alert" : "status");
  el.setAttribute("aria-live", isError ? "assertive" : "polite");
  el.setAttribute("aria-atomic", "true");
  el.classList.toggle("error", isError);
  el.classList.toggle("success", !isError);
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  const duration = Number(durationMs) || (isError ? 4200 : 3000);
  toastTimer = setTimeout(() => el.classList.remove("show"), duration);
}

document.addEventListener("DOMContentLoaded", pageInit);
