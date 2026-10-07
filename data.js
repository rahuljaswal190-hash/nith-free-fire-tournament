(function () {
  const brFeeTiers = [20, 40, 60, 80, 100];
  const csFeeTiers = [50, 70, 90, 110];
  const roomsPerTier = 3;
  const battleFormats = [
    { id: "solo", label: "Solo", playersPerEntry: 1, capacity: 12, description: "For solo players. Slots are numbered 1–12 per lobby." },
    { id: "duo", label: "Duo", playersPerEntry: 2, capacity: 12, description: "For two-player teams. Up to 12 teams per lobby." },
    { id: "trio", label: "Trio", playersPerEntry: 3, capacity: 12, description: "For three-player teams. Up to 12 teams per lobby." },
    { id: "squad", label: "Squad", playersPerEntry: 4, capacity: 12, description: "For full four-player squads. Up to 12 teams per lobby." }
  ];
  const rooms = [];

  brFeeTiers.forEach((fee) => {
    for (let i = 1; i <= roomsPerTier; i += 1) {
      battleFormats.forEach((format) => {
        rooms.push({
          id: `BR-${format.id.toUpperCase()}-${fee}-${i}`,
          mode: "br",
          format: format.id,
          formatLabel: format.label,
          playersPerEntry: format.playersPerEntry,
          title: `${format.label} Battle Royale Lobby ${i}`,
          scheduleSlot: `slot${i}`,
          fee,
          capacity: format.capacity,
          matchCount: 3,
          rewardRule: "Top 3 entries/teams after 3 matches",
          confirmedTeams: 0,
          status: "open"
        });
      });
    }
  });

  csFeeTiers.forEach((fee) => {
    for (let i = 1; i <= roomsPerTier; i += 1) {
      ["Normal", "One Tap"].forEach((variant) => {
        const shortVariant = variant === "One Tap" ? "OT" : "NM";
        rooms.push({
          id: `CS-${shortVariant}-${fee}-${i}`,
          mode: "cs",
          variant,
          title: `${variant} Clash Squad Room ${i}`,
          scheduleSlot: `slot${i}`,
          fee,
          capacity: 2,
          playersPerEntry: 4,
          matchCount: 1,
          rewardRule: "Winner team rewarded after 1 match",
          confirmedTeams: 0,
          status: "open"
        });
      });
    }
  });

  window.TOURNAMENT_DATA = {
    event: {
      name: "NIT Hamirpur Free Fire Tournament",
      shortName: "NITH Free Fire Tournament",
      label: "Student-organized registration portal",
      host: "NIT Hamirpur Students",
      venue: "National Institute of Technology Hamirpur",
      dateText: "Date and time to be announced",
      supportChannel: "Organizer WhatsApp/contact to be added",
      whatsappNumber: "",
      upiId: "",
      adminPin: "2026",
      disclaimer: "This is a student-organized tournament around NIT Hamirpur. It is not affiliated with, endorsed by, or sponsored by Garena or Free Fire."
    },
    economics: {
      feeTiers: brFeeTiers,
      brFeeTiers,
      csFeeTiers,
      roomsPerTier,
      payoutType: "entry-based",
      feeRule: "Battle Royale Solo fee is per player. Battle Royale Duo, Trio, Squad and Clash Squad fee is per team. Prize is entry-based and may vary with confirmed entries and organizer announcement.",
      starterPrizeNote: "The ₹20 Battle Royale full-lobby target reward pool starts from ₹200. Final prize may vary according to format, confirmed teams, payments, and organizer announcement.",
      brFullLobbyPrizeByTier: { 20: 200, 40: 400, 60: 600, 80: 800, 100: 1000 },
      csPrizeNote: "Clash Squad starts from ₹50 entry. Winner reward is entry-based and announced per room after both teams are confirmed. Admin may top up or reduce according to confirmed payments."
    },
    battleFormats,
    scoring: {
      br: {
        title: "Battle Royale scoring",
        killPoint: 1,
        placement: { 1: 12, 2: 9, 3: 8, 4: 7, 5: 6, 6: 5, 7: 4, 8: 3, 9: 2, 10: 1, 11: 0, 12: 0 },
        note: "Each Battle Royale session plays 3 matches. Match score is kills plus placement points; the leaderboard adds the three match scores into a cumulative total. Top 3 entries/teams are selected after verification."
      },
      cs: {
        title: "Clash Squad scoring",
        winPoint: 3,
        lossPoint: 0,
        note: "Each Clash Squad room is one match between 2 teams. Winner is rewarded. Leaderboard ranks by points, then round difference."
      }
    },
    rooms,
    matchWindows: {
      br: [
        { id: "slot1", label: "Slot 1", time: "9:00 PM–10:00 PM" },
        { id: "slot2", label: "Slot 2", time: "10:00 PM–11:00 PM" },
        { id: "slot3", label: "Slot 3", time: "11:00 PM–12:00 AM" }
      ],
      cs: [
        { id: "slot1", label: "Slot 1", time: "9:00 PM–10:00 PM" },
        { id: "slot2", label: "Slot 2", time: "10:00 PM–11:00 PM" },
        { id: "slot3", label: "Slot 3", time: "11:00 PM–12:00 AM" }
      ]
    },
    schedule: [
      { time: "Before match day", title: "Registration and admin verification", detail: "Players choose a mode, format, and one of three time-linked lobbies. Registration receives a reserved lobby slot; organizer approval is still required (BR slots 1–12, CS slots 1–2)." },
      { time: "15 minutes before match", title: "Room ID shared privately", detail: "Room ID/password are shared only through the Room Details page after admin release." },
      { time: "Match window", title: "Play the scheduled matches", detail: "Battle Royale teams play 3 matches within their assigned window. Clash Squad teams play 1 match within their assigned window. Current timings can be changed by the admin." },
      { time: "After result verification", title: "Match results and leaderboard", detail: "Admin records kills and placements for each BR match or the CS win/loss and round difference. Points and standings update automatically." }
    ],
    publishedState: {
      roomOverrides: {},
      registrationCounts: {},
      roomDetails: {},
      leaderboard: { br: [], cs: [] },
      notices: [
        "Battle Royale lobby slots are numbered 1–12; Clash Squad slots are 1–2. A submitted slot is reserved while approval is pending.",
        "All listed match times use India Standard Time (IST); the event date will be announced by the organizers.",
        "Solo, Duo, Trio and Squad Battle Royale sections are available for players with or without a full team.",
        "Clash Squad entry starts directly from ₹50.",
        "Room ID/password will appear on the Room Details page only after admin release."
      ]
    }
  };
})();
