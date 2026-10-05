const DATA = window.TOURNAMENT_DATA;
const STATE_KEY = "nithFreeFireTournamentStateV3";
let toastTimer;
let lastSummary = "";

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

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
    const base = defaultState();
    return {
      ...base,
      ...parsed,
      registrations: Array.isArray(parsed.registrations) ? parsed.registrations : [],
      roomOverrides: parsed.roomOverrides || {},
      leaderboard: {
        br: Array.isArray(parsed.leaderboard?.br) ? parsed.leaderboard.br : [],
        cs: Array.isArray(parsed.leaderboard?.cs) ? parsed.leaderboard.cs : []
      },
      notices: Array.isArray(parsed.notices) ? parsed.notices : []
    };
  } catch (error) {
    console.warn("State parse failed", error);
    return defaultState();
  }
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
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


function getRoom(roomId) {
  return DATA.rooms.find((room) => room.id === roomId);
}

function localRegistrationsForRoom(roomId) {
  const state = loadState();
  return state.registrations.filter((entry) => entry.roomId === roomId && entry.localSlotHeld !== false);
}

function getConfirmedBase(room) {
  const state = loadState();
  const pubOverrides = published().roomOverrides || {};
  const base = typeof pubOverrides[room.id] === "number" ? pubOverrides[room.id] : Number(room.confirmedTeams || 0);
  return typeof state.roomOverrides[room.id] === "number" ? state.roomOverrides[room.id] : base;
}

function getConfirmedTeams(room) {
  const baseConfirmed = getConfirmedBase(room);
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
      if (input.name?.endsWith("Ign") || input.name?.endsWith("Uid")) input.required = active;
    });
  });
}

function pageInit() {
  setupNavigation();
  renderGlobalEventText();
  renderNotices();
  renderPage();
  setupCommonRegistration();
  setupModal();
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
  if (page === "schedule") renderSchedulePage();
  if (page === "admin") setupAdminPage();
}

function renderHome() {
  const totals = DATA.economics.feeTiers.map((fee) => {
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
        <p>Battle Royale target reward pool: <b>${formatFee(brProjectedPrize(row.fee))}</b> when lobby conditions are met. Solo fee is per player; Duo/Trio/Squad fee is per team.</p>
        <div class="mini-bars">
          <span>BR slots <b>${row.brSlots}</b></span>
          <span>CS slots <b>${row.csSlots}</b></span>
        </div>
        <div class="fee-actions">
          <a href="battle-royale.html?fee=${row.fee}" class="mini-link">Battle Royale</a>
          <a href="clash-squad.html?fee=${row.fee}" class="mini-link">Clash Squad</a>
        </div>
      </article>
    `).join("");
  }
}


function renderClashPage() {
  const params = new URLSearchParams(location.search);
  const defaultFee = Number(params.get("fee")) || DATA.economics.feeTiers[0];
  const tierFilter = $("#cs-tier-filter");
  const variantFilter = $("#cs-variant-filter");
  if (tierFilter) populateFeeSelect(tierFilter, defaultFee);
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
  const defaultFee = Number(params.get("fee")) || DATA.economics.feeTiers[0];
  const defaultFormat = params.get("format") || "solo";
  const tierFilter = $("#br-tier-filter");
  const formatFilter = $("#br-format-filter");
  const formFormat = $("#br-form-format");
  if (tierFilter) populateFeeSelect(tierFilter, defaultFee);
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


function populateFeeSelect(select, selectedFee) {
  if (!select) return;
  select.innerHTML = DATA.economics.feeTiers.map((fee) => `<option value="${fee}" ${Number(selectedFee) === fee ? "selected" : ""}>${formatFee(fee)}</option>`).join("");
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
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const mode = form.dataset.mode;
      const data = readRegistrationForm(form, mode);
      const error = validateRegistration(data);
      if (error) {
        toast(error, true);
        return;
      }
      const state = loadState();
      state.registrations.unshift(data);
      saveState(state);
      lastSummary = buildRegistrationSummary(data);
      showSuccess(lastSummary, data);
      form.reset();
      renderPage();
      updateDynamicRoster(form);
      toast("Registration saved on this device. Final slot needs admin confirmation.");
    });
  });
}

function readRegistrationForm(form, mode) {
  const fd = new FormData(form);
  const roomId = clean(fd.get("roomId"));
  const room = getRoom(roomId);
  const now = new Date();
  const requiredPlayers = mode === "br" ? Number(room?.playersPerEntry || 1) : 4;
  const players = [];
  for (let index = 1; index <= requiredPlayers; index += 1) {
    players.push({
      ign: clean(fd.get(`p${index}Ign`)),
      uid: clean(fd.get(`p${index}Uid`)),
      roll: clean(fd.get(`p${index}Roll`))
    });
  }
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
    teamName: clean(fd.get("teamName")),
    captainName: clean(fd.get("captainName")),
    whatsapp: clean(fd.get("whatsapp")),
    institution: clean(fd.get("institution")),
    rollNumber: clean(fd.get("rollNumber")),
    email: clean(fd.get("email")),
    paymentRef: clean(fd.get("paymentRef")),
    players,
    acceptedRules: Boolean(fd.get("acceptedRules")),
    localSlotHeld: true,
    status: "Pending organizer verification",
    submittedAt: now.toISOString(),
    submittedAtDisplay: now.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
  };
}


function validateRegistration(data) {
  if (!data.teamName || !data.captainName || !data.whatsapp) return "Please enter team name, captain name, and WhatsApp number.";
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
  return `${DATA.event.name}\n` +
    `Registration ID: ${data.id}\n` +
    `Status: ${data.status}\n` +
    `Mode: ${data.modeLabel}${modeExtra}\n` +
    `Room: ${data.roomTitle} (${data.roomId})\n` +
    `Team/Entry Name: ${data.teamName}\n` +
    `Captain: ${data.captainName}\n` +
    `WhatsApp: ${data.whatsapp}\n` +
    `Institution: ${data.institution || "Not provided"}\n` +
    `Roll No: ${data.rollNumber || "N/A"}\n` +
    `Entry Fee: ${formatFee(data.fee)} ${data.feeRule || "per entry/team"}\n` +
    `Payment Ref: ${data.paymentRef}\n\n` +
    `Players:\n${players}\n\n` +
    `Submitted: ${data.submittedAtDisplay}\n` +
    `Note: Final slot is confirmed only after organizer verification.`;
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

  unlock.addEventListener("click", () => {
    if (pin.value.trim() !== DATA.event.adminPin) {
      toast("Wrong admin PIN.", true);
      return;
    }
    panel.classList.remove("hidden");
    renderAdminPanel();
    toast("Admin controls unlocked on this device.");
  });

  setupAdminListeners();
}

function setupAdminListeners() {
  $("#admin-mode")?.addEventListener("change", updateAdminRoomChoices);
  $("#admin-fee")?.addEventListener("change", updateAdminRoomChoices);
  $("#admin-format")?.addEventListener("change", updateAdminRoomChoices);
  $("#admin-variant")?.addEventListener("change", updateAdminRoomChoices);
  $("#save-room-count")?.addEventListener("click", saveAdminRoomCount);
  $("#save-leaderboard")?.addEventListener("click", saveAdminLeaderboardEntry);
  $("#admin-lb-mode")?.addEventListener("change", updateLeaderboardFormMode);
  $("#export-registrations")?.addEventListener("click", exportRegistrationsCsv);
  $("#clear-registrations")?.addEventListener("click", clearRegistrations);
  $("#export-state")?.addEventListener("click", exportStateJson);
  $("#import-state")?.addEventListener("click", importStateJson);
  $("#reset-admin-state")?.addEventListener("click", resetAdminState);
}

function renderAdminPanel() {
  populateFeeSelect($("#admin-fee"), DATA.economics.feeTiers[0]);
  populateFormatSelect($("#admin-format"), "solo");
  updateAdminRoomChoices();
  updateLeaderboardFormMode();
  renderAdminTables();
}

function updateAdminRoomChoices() {
  const mode = $("#admin-mode")?.value || "br";
  const fee = Number($("#admin-fee")?.value || DATA.economics.feeTiers[0]);
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


function saveAdminRoomCount() {
  const roomId = $("#admin-room")?.value;
  const room = getRoom(roomId);
  if (!room) return toast("Select a room first.", true);
  const count = Number($("#admin-confirmed-count")?.value || 0);
  if (count < 0 || count > room.capacity) return toast(`Count must be between 0 and ${room.capacity}.`, true);
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

function saveAdminLeaderboardEntry() {
  const mode = $("#admin-lb-mode")?.value || "br";
  const teamName = clean($("#admin-lb-team")?.value);
  if (!teamName) return toast("Enter team name.", true);
  const state = loadState();
  const common = {
    id: `LB-${Date.now()}`,
    teamName,
    fee: Number($("#admin-lb-fee")?.value || 20),
    roomId: clean($("#admin-lb-room")?.value),
    updatedAt: new Date().toISOString()
  };
  if (mode === "br") {
    const format = $("#admin-lb-brformat")?.value || "squad";
    const formatInfo = battleFormatById(format);
    state.leaderboard.br.push({
      ...common,
      format,
      formatLabel: formatInfo?.label || format,
      matchesPlayed: Number($("#admin-lb-matches")?.value || 0),
      booyah: Number($("#admin-lb-booyah")?.value || 0),
      placementPoints: Number($("#admin-lb-placement")?.value || 0),
      kills: Number($("#admin-lb-kills")?.value || 0),
      penalty: Number($("#admin-lb-penalty")?.value || 0)
    });
  } else {
    state.leaderboard.cs.push({
      ...common,
      variant: $("#admin-lb-variant")?.value || "Normal",
      wins: Number($("#admin-lb-wins")?.value || 0),
      losses: Number($("#admin-lb-losses")?.value || 0),
      roundDiff: Number($("#admin-lb-rounddiff")?.value || 0),
      penalty: Number($("#admin-lb-penalty")?.value || 0)
    });
  }
  saveState(state);
  renderAdminTables();
  renderLeaderboards("#admin-br-preview", "br");
  renderLeaderboards("#admin-cs-preview", "cs");
  toast("Leaderboard entry saved locally.");
}

function renderAdminTables() {
  const state = loadState();
  const regs = $("#admin-registrations");
  if (regs) {
    if (!state.registrations.length) {
      regs.innerHTML = `<div class="empty-state"><h3>No local registrations yet</h3><p>Registrations submitted in this browser will appear here.</p></div>`;
    } else {
      regs.innerHTML = `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Mode</th><th>Format/Type</th><th>Room</th><th>Team/Entry</th><th>Captain</th><th>Phone</th><th>Fee</th><th>Time</th></tr></thead><tbody>${state.registrations.map((r) => `<tr><td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.modeLabel)}</td><td>${escapeHtml(r.formatLabel || r.variant || "-")}</td><td>${escapeHtml(r.roomId)}</td><td>${escapeHtml(r.teamName)}</td><td>${escapeHtml(r.captainName)}</td><td>${escapeHtml(r.whatsapp)}</td><td>${formatFee(r.fee)}</td><td>${escapeHtml(r.submittedAtDisplay)}</td></tr>`).join("")}</tbody></table></div>`;
    }
  }
  renderLeaderboards("#admin-br-preview", "br");
  renderLeaderboards("#admin-cs-preview", "cs");
}

function exportRegistrationsCsv() {
  const state = loadState();
  if (!state.registrations.length) return toast("No local registrations to export.", true);
  const headers = ["id", "mode", "formatOrType", "playersPerEntry", "roomId", "fee", "feeRule", "teamName", "captainName", "whatsapp", "institution", "rollNumber", "email", "paymentRef", "submittedAt", "p1Ign", "p1Uid", "p2Ign", "p2Uid", "p3Ign", "p3Uid", "p4Ign", "p4Uid"];
  const rows = state.registrations.map((r) => {
    const flat = {
      id: r.id, mode: r.modeLabel, formatOrType: r.formatLabel || r.variant || "", playersPerEntry: r.playersPerEntry || "", roomId: r.roomId, fee: r.fee, feeRule: r.feeRule || "", teamName: r.teamName, captainName: r.captainName, whatsapp: r.whatsapp, institution: r.institution, rollNumber: r.rollNumber, email: r.email, paymentRef: r.paymentRef, submittedAt: r.submittedAt,
      p1Ign: r.players?.[0]?.ign, p1Uid: r.players?.[0]?.uid, p2Ign: r.players?.[1]?.ign, p2Uid: r.players?.[1]?.uid, p3Ign: r.players?.[2]?.ign, p3Uid: r.players?.[2]?.uid, p4Ign: r.players?.[3]?.ign, p4Uid: r.players?.[3]?.uid
    };
    return headers.map((h) => csvEscape(flat[h])).join(",");
  });
  downloadFile(`nith-free-fire-registrations-${new Date().toISOString().slice(0, 10)}.csv`, [headers.join(","), ...rows].join("\n"), "text/csv");
}

function clearRegistrations() {
  if (!confirm("Clear local registrations on this device?")) return;
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
