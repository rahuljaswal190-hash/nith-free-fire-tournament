(function () {
  const feeTiers = [20, 40, 60, 80, 100];
  const roomsPerTier = 5;
  const battleFormats = [
    { id: "solo", label: "Solo", playersPerEntry: 1, capacity: 48, description: "For players who want to play alone. 48 solo entries per lobby." },
    { id: "duo", label: "Duo", playersPerEntry: 2, capacity: 24, description: "For two-player teams. 24 duo teams per lobby." },
    { id: "trio", label: "Trio", playersPerEntry: 3, capacity: 16, description: "For three-player teams. 16 trio teams per lobby." },
    { id: "squad", label: "Squad", playersPerEntry: 4, capacity: 12, description: "For full four-player squads. 12 squad teams per lobby." }
  ];
  const rooms = [];

  feeTiers.forEach((fee) => {
    for (let i = 1; i <= roomsPerTier; i += 1) {
      battleFormats.forEach((format) => {
        rooms.push({
          id: `BR-${format.id.toUpperCase()}-${fee}-${i}`,
          mode: "br",
          format: format.id,
          formatLabel: format.label,
          playersPerEntry: format.playersPerEntry,
          title: `${format.label} Battle Royale Lobby ${i}`,
          fee,
          capacity: format.capacity,
          matchCount: 3,
          rewardRule: "Top 3 entries/teams after 3 matches",
          confirmedTeams: 0,
          status: "open"
        });
      });

      ["Normal", "One Tap"].forEach((variant) => {
        const shortVariant = variant === "One Tap" ? "OT" : "NM";
        rooms.push({
          id: `CS-${shortVariant}-${fee}-${i}`,
          mode: "cs",
          variant,
          title: `${variant} Clash Squad Room ${i}`,
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
      supportChannel: "Official WhatsApp group/contact to be added",
      whatsappNumber: "",
      upiId: "yourupi@bank",
      adminPin: "2026",
      disclaimer: "This is a student-organized tournament portal for a Free Fire event around NIT Hamirpur. It is not affiliated with, endorsed by, or sponsored by Garena or Free Fire. Use institute-official wording only after proper permission."
    },
    economics: {
      feeTiers,
      roomsPerTier,
      payoutType: "entry-based",
      feeRule: "Solo fee is per player. Duo, Trio and Squad fee is per team. Prize is entry-based and may vary with confirmed entries and organizer announcement.",
      starterPrizeNote: "The ₹20 Battle Royale full-lobby target reward pool starts from ₹200. Final prize may vary according to format, confirmed teams, payments, and organizer announcement.",
      brFullLobbyPrizeByTier: { 20: 200, 40: 400, 60: 600, 80: 800, 100: 1000 },
      csPrizeNote: "Clash Squad winner reward is entry-based and announced per room after both teams are confirmed. Admin may top up or reduce according to confirmed payments."
    },
    battleFormats,
    scoring: {
      br: {
        title: "Battle Royale scoring",
        killPoint: 1,
        placement: { 1: 12, 2: 9, 3: 8, 4: 7, 5: 6, 6: 5, 7: 4, 8: 3, 9: 2, 10: 1, 11: 0, 12: 0 },
        note: "Each Battle Royale lobby plays 3 matches. Total score = placement points + kill points - penalties. Top 3 entries/teams are selected after cumulative scoring."
      },
      cs: {
        title: "Clash Squad scoring",
        winPoint: 3,
        lossPoint: 0,
        note: "Each Clash Squad room is one match between 2 teams. Winner is rewarded. Leaderboard ranks by points, then round difference."
      }
    },
    rooms,
    schedule: [
      { time: "TBA", title: "Registration opens", detail: "Players choose fee tier, room, and mode/format." },
      { time: "TBA", title: "Admin verification", detail: "Organizer confirms payment and slot availability." },
      { time: "15 minutes before match", title: "Room ID shared privately", detail: "Room ID/password are shared only through the official communication channel." },
      { time: "Match time", title: "Battle Royale / Clash Squad", detail: "Battle Royale has 3 matches per lobby. Clash Squad has 1 match per room." },
      { time: "After verification", title: "Leaderboard and payout", detail: "Scores are updated after screenshots/recordings and fair-play checks." }
    ],
    publishedState: {
      roomOverrides: {},
      leaderboard: { br: [], cs: [] },
      notices: [
        "Slots shown are admin-confirmed or locally held. Final slot is valid only after organizer confirmation.",
        "Solo, Duo, Trio and Squad Battle Royale sections are available for players with or without a full team.",
        "Room ID/password will never be posted publicly on this website."
      ]
    }
  };
})();
