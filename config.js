// Team hub settings. This is the only file you normally need to edit.
window.HUB_CONFIG = {
  teamName: "KSC Wiedikon Herren 2",
  shortName: "H2",
  club: "KSCW",
  // Main team colour (any CSS colour). Used for the header and highlights.
  accent: "#3a52a4",
  // Second club colour, used for highlights (active tab, starters).
  gold: "#fadb3c",

  // Google Sheet with players, stats, awards and news.
  // Paste the ID from the sheet's address: docs.google.com/spreadsheets/d/<THIS PART>/edit
  // The sheet must be shared as "Anyone with the link can view".
  // Leave it empty to use the CSV files in the data/ folder instead.
  googleSheetId: "",

  // Tab names inside the Google Sheet (or CSV files in data/ when no sheet is set).
  tabs: {
    players: "Players",
    stats: "Stats",
    lastSeason: "LastSeason",
    awards: "Awards",
    news: "News",
  },
};
