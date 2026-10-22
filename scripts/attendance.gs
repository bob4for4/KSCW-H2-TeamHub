/* KSCW H2 attendance. Google Apps Script, bound to the PRIVATE sheet
 * "KSCW H2 Attendance" (only Philipp and the coach can open it).
 *
 * The hub sends In / Out taps and away periods here; this script stores them
 * in the private sheet and gives the hub back the answers for upcoming
 * sessions only. Attendance rates are worked out in the Tracker and
 * Sessions tabs, which only people with access to the sheet can see.
 *
 * Setup (once): paste this file into Extensions → Apps Script, run setup(),
 * then Deploy → New deployment → Web app, Execute as: Me, Who has access:
 * Anyone. Copy the web app URL into config.js (attendanceUrl). */

const HUB_SHEET_ID = "1uqdwqKDBaPhrfV_0vpxq2teJHUE5p9HwCo9FDXZT-z0"; // public hub sheet (Players, Trainings)
const LEAGUE_URL = "https://bob4for4.github.io/KSCW-H2-TeamHub/data/league.json";
const TZ = "Europe/Zurich";
const TABS = {
  answers: ["session", "date", "type", "label", "player", "status", "updated"],
  away: ["player", "from", "to", "added"],
  log: ["time", "action", "player", "details"],
};

// ---------- web app ----------
function doGet() {
  return json_(listData_());
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: "Bad request" }); }
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const roster = roster_();
    if (roster.indexOf(body.player) < 0) return json_({ ok: false, error: "Unknown player" });
    if (body.a === "set") setAnswer_(body);
    else if (body.a === "away") addAway_(body);
    else if (body.a === "unaway") removeAway_(body);
    else return json_({ ok: false, error: "Unknown action" });
    sheet_("log").appendRow([now_(), body.a, body.player, JSON.stringify(body)]);
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    lock.releaseLock();
  }
  return json_(listData_());
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Answers for today and later, plus away periods that haven't ended. Nothing older leaves the sheet.
function listData_() {
  const today = today_();
  const answers = {};
  rows_("answers").forEach((r) => {
    if (r.date < today) return;
    (answers[r.session] = answers[r.session] || {})[r.player] = r.status;
  });
  const away = rows_("away").filter((r) => r.to >= today).map((r) => ({ player: r.player, from: r.from, to: r.to }));
  return { ok: true, answers, away };
}

// ---------- writes ----------
function setAnswer_(b) {
  if (!/^(T\d{4}-\d{2}-\d{2}|G\d+)$/.test(b.session)) throw new Error("Bad session");
  if (!isDate_(b.date) || b.date < today_()) throw new Error("This session is over");
  if (b.status !== "in" && b.status !== "out") throw new Error("Bad status");
  const sh = sheet_("answers");
  const values = sh.getDataRange().getDisplayValues();
  const row = [b.session, b.date, b.session[0] === "G" ? "Game" : "Training", String(b.label || "").slice(0, 80), b.player, b.status, now_()];
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === b.session && values[i][4] === b.player) {
      sh.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return;
    }
  }
  sh.appendRow(row);
}

function addAway_(b) {
  if (!isDate_(b.from) || !isDate_(b.to) || b.to < b.from) throw new Error("Check the dates");
  if (b.to < today_()) throw new Error("That period is already over");
  sheet_("away").appendRow([b.player, b.from, b.to, now_()]);
}

function removeAway_(b) {
  const sh = sheet_("away");
  const values = sh.getDataRange().getDisplayValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (values[i][0] === b.player && values[i][1] === b.from && values[i][2] === b.to) sh.deleteRow(i + 1);
  }
}

// ---------- tracker (private) ----------
// Builds two tabs: Tracker (one line per player) and Sessions (who said In / Out per past session).
// Saying In counts as attending. An away period with no answer counts as Out.
function rebuildTracker() {
  const today = today_();
  const players = roster_();
  const sessions = pastSessions_(today);
  const answers = {};
  rows_("answers").forEach((r) => { (answers[r.session] = answers[r.session] || {})[r.player] = r.status; });
  const away = rows_("away");
  const statusOf = (s, p) => {
    const a = answers[s.id] && answers[s.id][p];
    if (a) return a;
    return away.some((w) => w.player === p && w.from <= s.date && s.date <= w.to) ? "away" : "";
  };

  const head = ["Player", "Trainings in", "Trainings held", "Training %", "Games in", "Games held", "Game %", "Said out", "Away", "No answer"];
  const lines = players.map((p) => {
    const c = { tIn: 0, t: 0, gIn: 0, g: 0, out: 0, away: 0, none: 0 };
    sessions.forEach((s) => {
      const st = statusOf(s, p);
      if (s.type === "Training") { c.t++; if (st === "in") c.tIn++; } else { c.g++; if (st === "in") c.gIn++; }
      if (st === "out") c.out++; else if (st === "away") c.away++; else if (!st) c.none++;
    });
    const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "–");
    return [p, c.tIn, c.t, pct(c.tIn, c.t), c.gIn, c.g, pct(c.gIn, c.g), c.out, c.away, c.none];
  });
  lines.sort((a, b) => (b[1] + b[4]) - (a[1] + a[4]) || a[0].localeCompare(b[0]));
  writeTab_("Tracker", [head].concat(lines), "Updated " + now_() + " · counts sessions up to yesterday");

  const mark = { in: "In", out: "Out", away: "Away", "": "–" };
  const grid = [["Date", "Type", "Session", "In"].concat(players)].concat(sessions.slice().reverse().map((s) => {
    const st = players.map((p) => mark[statusOf(s, p)]);
    return [s.date, s.type, s.label, st.filter((x) => x === "In").length].concat(st);
  }));
  writeTab_("Sessions", grid, "");
}

function writeTab_(name, values, note) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  if (values.length && values[0].length) {
    sh.getRange(1, 1, values.length, values[0].length).setNumberFormat("@").setValues(values.map((r) => r.map(String)));
    sh.getRange(1, 1, 1, values[0].length).setFontWeight("bold").setBackground("#1c2a5e").setFontColor("#ffffff");
    sh.setFrozenRows(1);
    sh.setFrozenColumns(1);
  }
  if (note) sh.getRange(values.length + 2, 1).setValue(note).setFontColor("#64748b");
}

// Trainings (from the hub's Trainings tab) and our games, before today.
function pastSessions_(today) {
  const league = JSON.parse(UrlFetchApp.fetch(LEAGUE_URL, { muteHttpExceptions: true }).getContentText());
  const s = league.seasons[0];
  const games = s.games.filter((g) => (g.home === s.team || g.away === s.team) && g.date && !g.withdrawn);
  const trainingRows = hubTab_("Trainings");
  const first = trainingRows.filter((r) => r.kind === "weekly" && r.date).map((r) => r.date).sort()[0] || today;
  const list = expandTrainings(trainingRows, games.map((g) => g.date), first, addDays_(today, -1))
    .filter((t) => !t.cancelled)
    .map((t) => ({ id: t.id, date: t.date, type: "Training", label: "Training " + t.start }));
  games.filter((g) => g.date < today).forEach((g) => {
    const home = g.home === s.team;
    list.push({ id: "G" + g.id, date: g.date, type: "Game", label: (home ? "vs " : "@ ") + String(home ? g.away : g.home).replace(/\s+H\d$/, "") });
  });
  return list.sort((a, b) => a.date.localeCompare(b.date));
}

// Same rules as trainingSessions() in the hub's app.js. Keep the two in step.
//   weekly    day (Tue/Fri), start, end, place, address; date / until limit when the pattern applies
//   cancelled date (and until for a range, e.g. school holidays); note is shown in the hub
//   moved     date plus the new start / end / place / address
//   extra     date, start, end, place, address: a one-off training
// No training is planned on a day we have a game.
function expandTrainings(rows, gameDates, from, to) {
  const DAYS = { su: 0, so: 0, mo: 1, tu: 2, di: 2, we: 3, mi: 3, th: 4, do: 4, fr: 5, sa: 6 };
  const byDate = {};
  const games = {};
  gameDates.forEach((d) => { games[d] = true; });
  for (let d = from; d <= to; d = addDays_(d, 1)) {
    const wd = new Date(d + "T12:00:00Z").getUTCDay();
    rows.forEach((r) => {
      if (r.kind !== "weekly" || DAYS[String(r.day).slice(0, 2).toLowerCase()] !== wd) return;
      if ((r.date && d < r.date) || (r.until && d > r.until) || games[d]) return;
      byDate[d] = { id: "T" + d, date: d, start: r.start, end: r.end, place: r.place, address: r.address, note: "" };
    });
  }
  rows.forEach((r) => {
    if (!r.date) return;
    if (r.kind === "extra" && r.date >= from && r.date <= to) byDate[r.date] = { id: "T" + r.date, date: r.date, start: r.start, end: r.end, place: r.place, address: r.address, note: r.note || "" };
    if (r.kind === "moved" && byDate[r.date]) {
      const t = byDate[r.date];
      ["start", "end", "place", "address", "note"].forEach((k) => { if (r[k]) t[k] = r[k]; });
      t.moved = true;
    }
  });
  rows.forEach((r) => {
    if (r.kind !== "cancelled" || !r.date) return;
    Object.keys(byDate).forEach((d) => {
      if (d >= r.date && d <= (r.until || r.date)) { byDate[d].cancelled = true; byDate[d].note = r.note || ""; }
    });
  });
  return Object.keys(byDate).sort().map((d) => byDate[d]);
}

// ---------- sheet helpers ----------
function sheet_(key) {
  const ss = SpreadsheetApp.getActive();
  const name = key[0].toUpperCase() + key.slice(1);
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, TABS[key].length).setValues([TABS[key]]).setFontWeight("bold");
    sh.getRange("A:Z").setNumberFormat("@");
    sh.setFrozenRows(1);
  }
  return sh;
}

function rows_(key) {
  const values = sheet_(key).getDataRange().getDisplayValues();
  const head = values.shift() || [];
  return values.filter((v) => v.join("") !== "").map((v) => {
    const o = {};
    head.forEach((h, i) => { o[h] = String(v[i]).trim(); });
    return o;
  });
}

// A tab of the public hub sheet as objects (headers lower-case).
function hubTab_(name) {
  const sh = SpreadsheetApp.openById(HUB_SHEET_ID).getSheetByName(name);
  if (!sh) return [];
  const values = sh.getDataRange().getDisplayValues();
  const head = (values.shift() || []).map((h) => String(h).trim().toLowerCase());
  return values.filter((v) => v.join("") !== "").map((v) => {
    const o = {};
    head.forEach((h, i) => { o[h] = normDate_(String(v[i]).trim()); });
    return o;
  });
}

// Active players from the hub's Players tab (coaches are left out). Cached for 10 minutes.
function roster_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get("roster");
  if (hit) return JSON.parse(hit);
  const list = hubTab_("Players")
    .filter((r) => r.name && !/^(no|n|false|0|inactive)$/i.test(r.active || "") && !/coach/i.test(r.role || ""))
    .map((r) => r.name);
  cache.put("roster", JSON.stringify(list), 600);
  return list;
}

// 23.10.2026 or 10/23/2026 → 2026-10-23, 20:30:00 → 20:30; anything else stays as it is.
function normDate_(v) {
  let m = v.match(/^(\d{1,2}):(\d{2})(:\d{2})?$/);
  if (m) return ("0" + m[1]).slice(-2) + ":" + m[2];
  m = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return m[3] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2);
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + "-" + ("0" + m[1]).slice(-2) + "-" + ("0" + m[2]).slice(-2);
  return v;
}

const isDate_ = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
const today_ = () => Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
const now_ = () => Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm");
function addDays_(d, n) {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

// ---------- setup ----------
// Run once from the editor: creates the tabs and keeps the tracker fresh
// (every night, and whenever the sheet is opened).
function setup() {
  Object.keys(TABS).forEach(sheet_);
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("rebuildTracker").timeBased().everyDays(1).atHour(4).inTimezone(TZ).create();
  ScriptApp.newTrigger("rebuildTracker").forSpreadsheet(SpreadsheetApp.getActive()).onOpen().create();
  rebuildTracker();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("H2").addItem("Refresh tracker", "rebuildTracker").addToUi();
}
