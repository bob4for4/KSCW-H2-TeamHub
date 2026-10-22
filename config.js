// Team hub settings. This is the only file you normally need to edit.
window.HUB_CONFIG = {
  teamName: "KSC Wiedikon Herren 2",
  shortName: "H2",
  club: "KSCW",
  // Main team colour (any CSS colour). Used for the header and highlights.
  accent: "#3a52a4",
  // Second club colour, used for highlights (active tab, starters).
  gold: "#fadb3c",

  // Calendar feed with all games and trainings (made by scripts/make_calendar.py every 2 hours).
  calendarUrl: "https://bob4for4.github.io/KSCW-H2-TeamHub/data/team.ics",

  // Attendance: web app URL of the Apps Script in the private attendance sheet
  // (see scripts/attendance.gs). Leave empty to switch attendance off.
  attendanceUrl: "https://script.google.com/macros/s/AKfycbwCf6G5DIb8J0YpG3bmgp8k8Sk-vf5SW1jor0UnZ5wRazeTkW2iqp0ugYhbaGRcEQMQ/exec",

  // Google Sheet with players, stats, awards and news.
  // Paste the ID from the sheet's address: docs.google.com/spreadsheets/d/<THIS PART>/edit
  // The sheet must be shared as "Anyone with the link can view".
  // If the sheet can't be read, the hub falls back to the CSV files in the data/ folder.
  googleSheetId: "1uqdwqKDBaPhrfV_0vpxq2teJHUE5p9HwCo9FDXZT-z0",

  // Tab names inside the Google Sheet (or CSV files in data/ when no sheet is set).
  // Stats has one tab per season: "Stats 2026/27", "Stats 2025/26" (data/Stats-2026-27.csv locally).
  tabs: {
    players: "Players",
    stats: "Stats",
    awards: "Awards",
    news: "Scouting",
    playbook: "Playbook",
    // Weekly training times, cancellations (e.g. school holidays), moved and extra trainings.
    trainings: "Trainings",
  },
};
