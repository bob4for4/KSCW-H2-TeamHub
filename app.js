/* KSCW H2 team hub. Plain JavaScript, no build step.
 * League data comes from data/league.json (refreshed from basketplan by
 * scripts/update_league.py). Players, stats, awards and news come from a
 * Google Sheet, or from the CSV files in data/ when no sheet is configured. */
(function () {
  "use strict";

  const CFG = window.HUB_CONFIG || {};
  const state = {
    league: null,
    players: [],
    stats: [], // rows from every season's stats tab, each tagged with its season index
    awards: [],
    news: [],
    playbook: [],
    clubs: [],
    trainings: [], // rows of the Trainings tab (weekly pattern, cancellations, extras)
    att: { answers: {}, away: [], loaded: false, error: "", queue: [], sending: false }, // attendance, from the Apps Script; queue = taps not saved yet
    season: 0, // index into league.seasons (0 = current)
    leagueTeam: "",
    sort: { key: "ppg", dir: -1 },
    standSort: { key: "rank", dir: 1 }, // Standings page sort
    statsMode: "both", // Stats page: "both" (per game + totals side by side), or "avg" / "tot" with a switch
  };
  let countdownTimer = null;

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const esc = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const num = (v) => {
    if (v == null || v === "") return 0;
    const n = parseFloat(String(v).replace(",", "."));
    return isNaN(n) ? 0 : n;
  };
  const slug = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const short = (label) => String(label || "").replace(/\s+H\d$/, "");
  const fmt1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
  const todayStr = () => {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  };
  const dayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const longFmt = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const monthFmt = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const asDate = (d) => new Date(d + "T12:00:00Z");
  const fmtDay = (d) => (d ? dayFmt.format(asDate(d)) : "Date TBA");
  const dayYearFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const fmtDayYear = (d) => (d ? dayYearFmt.format(asDate(d)) : "Date TBA");
  // Stat cell: whole numbers as-is, estimates (from games without a score sheet) as ~0.5
  // Stat cell: games without a score sheet are shown like any other game (whole numbers).
  const statCell = (v) => (v == null ? "–" : Number.isInteger(v) ? String(v) : fmt1(v));
  const total = (v) => (Number.isInteger(v) ? String(v) : fmt1(v));
  const fmtLong = (d) => (d ? longFmt.format(asDate(d)) : "Date TBA");
  const initials = (name) => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", i = 0, q = false;
    text = text.replace(/^﻿/, "");
    while (i < text.length) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
        } else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
      i++;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
    if (!nonEmpty.length) return [];
    const head = nonEmpty[0].map((h) => h.trim().toLowerCase());
    return nonEmpty.slice(1).map((r) => {
      const o = {};
      head.forEach((h, j) => { if (h) o[h] = (r[j] || "").trim(); });
      return o;
    });
  }

  // First non-empty value among several possible column names.
  const pick = (row, ...keys) => {
    for (const k of keys) if (row[k] != null && row[k] !== "") return row[k];
    return "";
  };

  async function fetchCSV(url) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      const text = await res.text();
      if (/^\s*</.test(text)) return null; // an HTML page (e.g. Google sign-in), not CSV
      return parseCSV(text);
    } catch (e) {
      return null;
    }
  }

  // Reads a tab from the Google Sheet; if the sheet can't be read (not shared,
  // offline, tab renamed), falls back to the CSV copy in data/. Google returns the
  // first tab when a tab name doesn't exist, so the header row is checked too.
  async function loadTab(name, required, file) {
    const looksRight = (rows) => !!rows && (!rows.length ? true : (required || []).every((c) => c in rows[0]));
    // ?local=1 in the address uses the data/ files only (handy for testing)
    if (CFG.googleSheetId && !/[?&]local=1\b/.test(location.search)) {
      const rows = await fetchCSV("https://docs.google.com/spreadsheets/d/" + encodeURIComponent(CFG.googleSheetId) +
        "/gviz/tq?tqx=out:csv&headers=1&sheet=" + encodeURIComponent(name));
      if (rows && rows.length && looksRight(rows)) return rows;
      console.warn("Google Sheet tab not readable, using data/" + name + ".csv instead:", name);
    }
    return (await fetchCSV("data/" + encodeURIComponent(file || name) + ".csv?v=" + Date.now())) || [];
  }

  // ---------- data shaping ----------
  function normPlayers(rows) {
    return rows.map((r) => {
      const name = pick(r, "name", "player");
      return {
        name,
        slug: slug(name),
        number: pick(r, "number", "#", "jersey", "nr").replace(/^N\/A$/i, ""),
        position: pick(r, "position", "pos").toUpperCase(),
        position2: pick(r, "secondary_position", "position2").toUpperCase().replace(/^N\/A$/, ""),
        role: pick(r, "role") || "Player",
        nationality: pick(r, "nationality", "country"),
        height: pick(r, "height_cm", "height"),
        weight: pick(r, "weight_kg", "weight"),
        born: pick(r, "born", "birth_year", "birthday"),
        hometown: pick(r, "hometown", "from"),
        nickname: pick(r, "nickname"),
        since: pick(r, "since", "joined"),
        bio: pick(r, "bio", "about"),
        photo: pick(r, "photo", "photo_url", "image"),
        depth: pick(r, "depth_slot", "depth").toUpperCase(),
        depthOrder: num(pick(r, "depth_order", "order")) || 99,
        active: !/^(no|n|false|0|inactive)$/i.test(pick(r, "active")),
        // other spellings used for this player in the stats tabs, e.g. a first name
        aliases: pick(r, "alias", "aliases", "stats_name").split(",").map(slug).filter(Boolean),
      };
    }).filter((p) => p.name);
  }

  // Blank cells stay null so a stat nobody tracked shows as "–", not 0.
  const numOrNull = (v) => (v == null || String(v).trim() === "" ? null : num(v));

  // Sheets may show a typed date as 23.10.2026, 10/23/2026 or 2026-10-23; the hub uses YYYY-MM-DD.
  function normDate(v) {
    v = String(v || "").trim();
    let m;
    if ((m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
    if ((m = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/))) return (m[3].length === 2 ? "20" + m[3] : m[3]) + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
    if ((m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return m[3] + "-" + m[1].padStart(2, "0") + "-" + m[2].padStart(2, "0");
    return v;
  }

  function normStatRow(r) {
    const pts = pick(r, "pts", "points");
    return {
      date: normDate(pick(r, "date", "game_date")),
      game: pick(r, "game", "game_number"),
      player: pick(r, "player", "name"),
      dnp: /^(yes|y|x|true|1|dnp)$/i.test(pick(r, "dnp")) || /^dnp$/i.test(pts),
      est: /^(yes|y|x|true|1)$/i.test(pick(r, "est", "estimated")),
      gp: num(pick(r, "gp", "games")),
      pts: numOrNull(pts),
      tpm: numOrNull(pick(r, "3pm", "threes", "3p", "3s")),
      ftm: numOrNull(pick(r, "ftm", "ft")),
      fta: numOrNull(pick(r, "fta")),
      pf: numOrNull(pick(r, "fouls", "pf", "f")),
      gs: (() => { const v = pick(r, "gs", "started", "starter"); return v === "" ? null : /^(1|yes|y|x|true)$/i.test(v) ? 1 : 0; })(),
      // points in each quarter (columns q1–q4); null when the row has none
      q: (() => { const q = ["q1", "q2", "q3", "q4"].map((k) => numOrNull(pick(r, k))); return q.some((v) => v == null) ? null : q; })(),
    };
  }

  const season = () => state.league.seasons[state.season];
  const isUs = (g, s) => g.home === s.team || g.away === s.team;
  const hasScore = (g) => Array.isArray(g.score) && g.score[0] != null && g.score[1] != null;
  // A forfeit comes from basketplan as a 20–0 result with no date (and no venue).
  const isForfeit = (g) => !g.date && hasScore(g) && Math.max(...g.score) === 20 && Math.min(...g.score) === 0;
  // Our games in date order; games without a date (forfeits, unscheduled) go last.
  const teamGames = (s) => s.games.filter((g) => isUs(g, s))
    .sort((a, b) => (!a.date) - (!b.date) || (a.date || "").localeCompare(b.date || ""));

  function ourView(g, s) {
    const home = g.home === s.team;
    const opp = home ? g.away : g.home;
    const r = { home, opp, oppClub: home ? g.awayClub : g.homeClub, played: hasScore(g) };
    if (r.played) {
      r.us = g.score[home ? 0 : 1];
      r.them = g.score[home ? 1 : 0];
      r.win = r.us > r.them;
    }
    return r;
  }

  function record(s) {
    // Forfeits count as a win or loss, but their 20–0 is left out of the points averages.
    let w = 0, l = 0, pf = 0, pa = 0, scored = 0;
    teamGames(s).forEach((g) => {
      const v = ourView(g, s);
      if (!v.played || !g.counts) return;
      v.win ? w++ : l++;
      if (isForfeit(g)) return;
      pf += v.us; pa += v.them; scored++;
    });
    return { w, l, pf, pa, gp: w + l, scored };
  }

  // Standings worked out from final results: points, then head-to-head, then point difference.
  function standings(s) {
    const t = {};
    const row = (name) => (t[name] = t[name] || { team: name, gp: 0, w: 0, l: 0, pts: 0, pf: 0, pa: 0, form: [] });
    s.games.forEach((g) => { row(g.home); row(g.away); });
    const played = s.games.filter((g) => hasScore(g) && g.counts)
      .sort((a, b) => (!a.date) - (!b.date) || (a.date || "").localeCompare(b.date || ""));
    played.forEach((g) => {
      const h = row(g.home), a = row(g.away);
      const hw = g.score[0] > g.score[1];
      h.gp++; a.gp++;
      h.pf += g.score[0]; h.pa += g.score[1];
      a.pf += g.score[1]; a.pa += g.score[0];
      if (hw) { h.w++; a.l++; } else { a.w++; h.l++; }
      const p = g.points || [hw ? 2 : 0, hw ? 0 : 2];
      h.pts += p[0] || 0; a.pts += p[1] || 0;
      h.form.push(hw ? "W" : "L"); a.form.push(hw ? "L" : "W");
    });
    const rows = Object.values(t);
    const groups = {};
    rows.forEach((r) => (groups[r.pts] = groups[r.pts] || []).push(r));
    Object.values(groups).forEach((grp) => {
      const names = new Set(grp.map((r) => r.team));
      grp.forEach((r) => { r.h2hPts = 0; r.h2hDiff = 0; });
      if (grp.length < 2) return;
      played.forEach((g) => {
        if (!names.has(g.home) || !names.has(g.away)) return;
        const hw = g.score[0] > g.score[1];
        const h = t[g.home], a = t[g.away];
        h.h2hPts += hw ? 2 : 0; a.h2hPts += hw ? 0 : 2;
        h.h2hDiff += g.score[0] - g.score[1]; a.h2hDiff += g.score[1] - g.score[0];
      });
    });
    rows.sort((a, b) => b.pts - a.pts || b.h2hPts - a.h2hPts || b.h2hDiff - a.h2hDiff ||
      (b.pf - b.pa) - (a.pf - a.pa) || b.pf - a.pf || a.team.localeCompare(b.team));
    rows.forEach((r, i) => {
      r.rank = i + 1;
      let n = 0;
      const last = r.form[r.form.length - 1];
      for (let k = r.form.length - 1; k >= 0 && r.form[k] === last; k--) n++;
      r.streak = last ? last + n : "–";
    });
    return rows;
  }

  // Per-player season averages from the Stats tab (current season games only).
  const STAT_KEYS = ["pts", "tpm", "ftm", "fta", "pf", "gs"];

  // Slug of the player a stats row belongs to (matches name or alias in the Players tab).
  function resolvePlayer(name) {
    const sl = slug(name);
    const p = state.players.find((x) => x.slug === sl || x.aliases.includes(sl));
    return p ? p.slug : sl;
  }

  const statMatchesGame = (r, g) => (r.game ? r.game === g.number : r.date === g.date);

  // Per-player averages for one season, from the game-by-game Stats tab.
  function playerAverages(idx) {
    const games = teamGames(state.league.seasons[idx]);
    const by = {};
    state.stats.forEach((r) => {
      if (r.season !== idx || !r.player || r.dnp || r.pts == null) return;
      if (!games.some((g) => statMatchesGame(r, g))) return;
      const k = resolvePlayer(r.player);
      const o = (by[k] = by[k] || { slug: k, name: r.player, gp: 0, pts: 0, tpm: 0, ftm: 0, fta: 0, pf: 0, gs: 0, games: [] });
      o.gp++;
      STAT_KEYS.forEach((key) => { o[key] += r[key] || 0; });
      o.games.push(r);
    });
    return finishAverages(Object.values(by), trackedIn(Object.values(by).flatMap((o) => o.games)));
  }

  // Which stats were recorded at all in a set of rows.
  function trackedIn(rows) {
    const t = {};
    STAT_KEYS.forEach((k) => { t[k] = rows.some((r) => r[k] != null); });
    return t;
  }

  function statsFor(idx) {
    return playerAverages(idx);
  }

  function finishAverages(list, tracked) {
    list.forEach((o) => {
      const g = o.gp || 1;
      o.ppg = o.pts / g; o.tpg = o.tpm / g; o.ftpg = o.ftm / g; o.pfpg = o.pf / g;
      o.ftpct = o.fta ? o.ftm / o.fta : null;
      const p = playerBySlug(o.slug);
      if (p) { o.name = p.name; o.number = p.number; }
    });
    list.tracked = tracked;
    return list;
  }

  const playerBySlug = (s) => state.players.find((p) => p.slug === s);
  const isStaff = (p) => !/^player$/i.test(p.role);
  const positions = (p) => [p.position, p.position2].filter(Boolean).join(" / ");

  const FLAGS = {
    switzerland: "CH", germany: "DE", austria: "AT", italy: "IT", france: "FR", greece: "GR", ghana: "GH", philippines: "PH",
    usa: "US", "united states": "US", latvia: "LV", romania: "RO", spain: "ES", portugal: "PT", serbia: "RS", croatia: "HR",
    "united kingdom": "GB", uk: "GB", england: "GB", netherlands: "NL", belgium: "BE", poland: "PL", turkey: "TR", brazil: "BR",
    canada: "CA", nigeria: "NG", kosovo: "XK", "bosnia and herzegovina": "BA", lithuania: "LT", slovenia: "SI", ukraine: "UA",
  };
  function flag(country) {
    const code = FLAGS[String(country || "").trim().toLowerCase()];
    if (!code || code === "XK") return "";
    return String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0)));
  }

  function gameForStat(r, s) {
    return teamGames(s).find((g) => statMatchesGame(r, g));
  }

  // ---------- small render pieces ----------
  function avatar(p, cls) {
    const label = p && p.number !== "" && p.number != null ? p.number : initials(p && p.name);
    if (p && p.photo) return '<div class="avatar ' + (cls || "") + '"><img src="' + esc(p.photo) + '" alt="" loading="lazy"></div>';
    return '<div class="avatar ' + (cls || "") + '">' + esc(label) + "</div>";
  }

  // Badge for a team: our crest, or coloured initials for everyone else.
  const MARK_COLORS = ["#0f766e", "#b45309", "#7c3aed", "#be123c", "#0369a1", "#4d7c0f", "#a21caf", "#c2410c", "#334155", "#15803d"];
  const clubFor = (name) => state.clubs.find((c) => c.match && String(name).includes(c.match));
  function teamMark(name, size) {
    const cls = "mark" + (size ? " " + size : "");
    const club = clubFor(name);
    if (club && club.logo) return '<img class="' + cls + (/KSC Wiedikon/.test(name) ? " crest-mark" : " logo") + '" src="' + esc(club.logo) + '" alt=""' +
      (club.logoBg ? ' style="background:' + esc(club.logoBg) + '"' : "") + ' loading="lazy">';
    const words = short(name).split(/\s+/).filter((w) => !/^(basket|basketball|herren|\d+|h\d|bbc|bc|stv|cvjm)$/i.test(w));
    let ini = words.length === 1 && /^[A-Z]{2,4}$/.test(words[0]) ? words[0].slice(0, 3) : words.slice(0, 2).map((w) => w[0]).join("");
    ini = (ini || short(name).slice(0, 2)).toUpperCase();
    let h = 0;
    for (const c of name.replace(/\s+(Herren\s+\d+\s+)?H\d$/, "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return '<span class="' + cls + '" style="background:' + MARK_COLORS[h % MARK_COLORS.length] + '" aria-hidden="true">' + esc(ini) + "</span>";
  }

  function playerLink(name) {
    const p = playerBySlug(resolvePlayer(name));
    return p ? '<a href="#player/' + esc(p.slug) + '">' + esc(p.name) + "</a>" : esc(name);
  }

  function seasonToggle() {
    return '<div class="seg" role="group" aria-label="Season">' + state.league.seasons.map((s, i) =>
      '<button type="button" data-season="' + i + '" class="' + (i === state.season ? "on" : "") + '">' + esc(s.season) + "</button>").join("") + "</div>";
  }

  function resultText(v) {
    if (!v.played) return "";
    return '<span class="' + (v.win ? "res-w" : "res-l") + '">' + (v.win ? "W" : "L") + "</span>" + v.us + "–" + v.them;
  }

  const PIN = '<svg class="pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';
  function venueLink(g) {
    if (!g.venue || !g.venue.name) return "";
    const q = [g.venue.name, g.venue.address, g.venue.zip, g.venue.city].filter(Boolean).join(", ");
    return '<a href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) + '" target="_blank" rel="noopener">' + PIN + esc(g.venue.name) + (g.venue.city ? ", " + esc(g.venue.city) : "") + "</a>";
  }

  function quarterTable(g) {
    if (!g.quarters || !g.quarters.length) return "";
    const labels = g.quarters.map((_, i) => (i < 4 ? "Q" + (i + 1) : "OT" + (i - 3 > 1 ? i - 3 : "")));
    const line = (name, idx, total) => '<tr><td class="left"><div class="teamcell">' + teamMark(name, "sm") + "<span>" + esc(short(name)) + "</span></div></td>" +
      g.quarters.map((q) => "<td>" + (q[idx] == null ? "–" : q[idx]) + "</td>").join("") + '<td class="hi">' + total + "</td></tr>";
    return '<div class="table-wrap"><table><thead><tr><th></th>' + labels.map((l) => "<th>" + l + "</th>").join("") +
      "<th>T</th></tr></thead><tbody>" + line(g.home, 0, g.score[0]) + line(g.away, 1, g.score[1]) + "</tbody></table></div>";
  }

  function boxScore(g) {
    // only our own games (other league games on the same day must not show our stats)
    const idx = state.league.seasons.findIndex((x) => x.games.includes(g));
    if (idx < 0 || !isUs(g, state.league.seasons[idx])) return "";
    const rows = state.stats.filter((r) => r.season === idx && !r.dnp && r.player && r.pts != null && statMatchesGame(r, g));
    if (!rows.length) return "";
    rows.sort((a, b) => b.pts - a.pts);
    const t = trackedIn(rows);
    const cols = [["pts", "PTS"], ["tpm", "3PM"], ["ftm", "FTM"], ["pf", "PF"]].filter(([k]) => t[k]);
    return '<h3 style="margin-top:14px">H2 box score</h3><div class="table-wrap"><table><thead><tr><th>Player</th>' + cols.map((c) => statTh(c[1])).join("") + "</tr></thead><tbody>" +
      rows.map((r) => '<tr><td class="name">' + playerLink(r.player) + "</td>" + cols.map(([k], i) => '<td class="' + (i === 0 ? "hi" : "") + '">' + (k === "pts" ? statCell(r[k]) : statCell(r[k], r.est)) + "</td>").join("") + "</tr>").join("") +
      "</tbody></table></div>";
  }

  // Open/close box score for any played game: quarters, our player box score (if ours) and referees.
  function boxInner(g) {
    if (!hasScore(g) || isForfeit(g)) return "";
    return quarterTable(g) + boxScore(g) + (g.referees && g.referees.length ? '<div class="small muted" style="margin-top:10px">Referees: ' + g.referees.map(esc).join(", ") + "</div>" : "");
  }
  function boxToggle(g) {
    const inner = boxInner(g);
    return inner ? '<details class="boxtoggle"><summary>Box score</summary><div class="box">' + inner + "</div></details>" : "";
  }

  function empty(msg) { return '<div class="empty">' + msg + "</div>"; }

  const ordinal = (n) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
  const leagueName = (s) => {
    const code = (s.league || "").split(" ")[0];
    const m = code.match(/^H(\d)L/);
    return m ? m[1] + ". Liga" + (code.endsWith("R") ? " Regional" : "") : code;
  };

  // ---------- views ----------
  function viewHome() {
    const s = state.league.seasons[0];
    const games = teamGames(s);
    const today = todayStr();
    const next = games.find((g) => !hasScore(g) && !g.withdrawn && g.date && g.date >= today);
    const results = games.filter(hasScore).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const last = results[0];
    const upcoming = games.filter((g) => !hasScore(g) && g.date && g.date >= today && g !== next).slice(0, 4);
    const table = standings(s);

    let html = '<div class="grid grid-home"><div class="stack">';

    // Next game
    html += '<section class="hero"><div class="card-head"><h3>Next game</h3><a href="#schedule">Full schedule →</a></div>';
    if (next) {
      const v = ourView(next, s);
      const side = (name, sub) => {
        const club = clubFor(name);
        const site = club && club.website && !/KSC Wiedikon/.test(name) ? ' · <a href="' + esc(club.website) + '" target="_blank" rel="noopener">Website ↗</a>' : "";
        const subText = sub && sub !== short(name) ? esc(sub) + site : site.replace(/^ · /, "");
        return '<div class="side">' + teamMark(name, "lg") + '<div><div class="tname">' + esc(short(name)) + '</div><div class="tsub">' + subText + "</div></div></div>";
      };
      html += '<div class="matchup">' + side(next.home, v.home ? "Home" : v.oppClub || "") + '<div class="vs">VS</div>' + side(next.away, v.home ? v.oppClub || "" : "Away") + "</div>" +
        '<div class="countdown" id="countdown" data-at="' + esc(next.date + "T" + (next.time || "00:00")) + '"></div>' +
        '<div class="meta"><span>' + esc(fmtLong(next.date)) + (next.time ? " · " + esc(next.time) : "") + "</span><span>" + venueLink(next) + "</span></div>" +
        (CFG.calendarUrl ? '<div class="meta">' + calendarLinks(true) + "</div>" : "");
    } else html += empty("No upcoming games on the schedule.");
    html += "</section>";
    html += attHomeCard();

    // Last result
    if (last) {
      const v = ourView(last, s);
      const side = (name) => '<div class="side">' + teamMark(name, "lg") + '<div class="tname">' + esc(short(name)) + "</div></div>";
      html += '<section class="card"><div class="card-head"><h3>Last result</h3><span class="badge ' + (v.win ? "w" : "l") + '">' + (v.win ? "WIN" : "LOSS") + "</span></div>" +
        '<div class="matchup">' + side(last.home) + '<div class="bigscore"><span class="' + (last.score[0] < last.score[1] ? "lose" : "") + '">' + last.score[0] +
        '</span>–<span class="' + (last.score[1] < last.score[0] ? "lose" : "") + '">' + last.score[1] + "</span></div>" + side(last.away) + "</div>" +
        '<div class="meta"><span>' + esc(fmtLong(last.date)) + "</span><span>" + venueLink(last) + "</span></div>" +
        '<div style="margin-top:16px">' + quarterTable(last) + boxScore(last) + "</div></section>";
    }

    // Leaders
    let leadIdx = 0;
    let leadList = statsFor(0);
    if (!leadList.some((o) => o.gp > 0) && state.league.seasons[1]) { leadIdx = 1; leadList = statsFor(1); }
    const avg = leadList.filter((o) => o.gp > 0);
    if (avg.length) {
      const tracked = leadList.tracked;
      const lead = (key, label) => {
        const top = avg.slice().sort((a, b) => b[key] - a[key])[0];
        const p = playerBySlug(top.slug) || { name: top.name };
        return '<a class="leader" href="#player/' + esc(top.slug) + '">' + avatar(p) + '<div><div class="lbl">' + label + '</div><div class="val">' + (key === "pts" ? top.pts : fmt1(top[key])) +
          '</div><div class="who">' + esc(top.name) + "</div></div></a>";
      };
      html += '<section class="card"><div class="card-head"><h3>' + (leadIdx ? "Leaders · last season " + esc(state.league.seasons[1].season) : "Team leaders") +
        '</h3><a href="#stats">All stats →</a></div><div class="leaders">' + lead("ppg", "Points / game") + lead("pts", "Total points") +
        (tracked.tpm ? lead("tpg", "3PM / game") : "") + (tracked.ftm ? lead("ftpg", "FTM / game") : "") + "</div></section>";
    }

    // Upcoming
    if (upcoming.length) {
      html += '<section class="card"><div class="card-head"><h3>Coming up</h3><a href="#schedule">All games →</a></div><ul class="games">' +
        upcoming.map((g) => gameRow(g, s, false)).join("") + "</ul></section>";
    }

    html += '</div><div class="stack">';

    // Standings mini
    html += '<section class="card"><div class="card-head"><h3>' + esc(leagueName(s)) + '</h3><a href="#standings">Full table →</a></div><div class="table-wrap"><table><thead><tr><th>#</th><th class="left">Team</th><th>W</th><th>L</th><th>Pts</th></tr></thead><tbody>' +
      table.map((r) => '<tr class="' + (r.team === s.team ? "us" : "") + '"><td class="rank">' + r.rank + '</td><td class="name"><div class="teamcell">' + teamMark(r.team, "sm") + "<span>" + esc(short(r.team)) +
        "</span></div></td><td>" + r.w + "</td><td>" + r.l + '</td><td class="hi">' + r.pts + "</td></tr>").join("") +
      "</tbody></table></div></section>";

    // This season: record, league place, points for and against
    html += teamCard(0, true);

    // Scouting (rows from the Scouting tab)
    html += '<section class="card"><div class="card-head"><h3>Scouting</h3></div>' + newsList() + "</section>";
    html += "</div></div>";
    return html;
  }

  // Team record, league place and points per game for one season (Home: this season; Stats: chosen season).
  function teamCard(idx, home) {
    const s = state.league.seasons[idx];
    if (!s) return "";
    const rec = record(s);
    const pt = standings(s).find((r) => r.team === s.team);
    return '<section class="card"' + (home ? "" : ' style="margin-bottom:16px"') + '><div class="card-head"><h3>' + (home ? "This season · " : "Team · ") + esc(s.season) +
      "</h3>" + (home ? '<a href="#schedule">Results →</a>' : "") + "</div>" +
      '<div class="statline' + (home ? " two" : "") + '"><div class="stat-tile"><b>' + rec.w + "–" + rec.l + "</b><span>Record</span></div>" +
      '<div class="stat-tile"><b>' + (pt && rec.gp ? ordinal(pt.rank) : "–") + "</b><span>" + esc(leagueName(s)) + "</span></div>" +
      '<div class="stat-tile"><b>' + (rec.scored ? fmt1(rec.pf / rec.scored) : "–") + "</b><span>PPG</span></div>" +
      '<div class="stat-tile"><b>' + (rec.scored ? fmt1(rec.pa / rec.scored) : "–") + "</b><span>Opp PPG</span></div></div></section>";
  }

  function newsList() {
    // A news row shows from its date on; with an "until" date it is hidden from the day after.
    const today = todayStr();
    const items = state.news.map((n) => ({ date: normDate(pick(n, "date")), until: normDate(pick(n, "until")), title: pick(n, "title", "headline"), text: pick(n, "text", "body"), link: pick(n, "link", "url") }))
      .filter((n) => n.title && !(n.date && n.date > today) && !(n.until && n.until < today));
    // Soonest game first (by "until", the game date); rows without one go last.
    const key = (n) => n.until || "9999";
    items.sort((a, b) => key(a).localeCompare(key(b)));
    if (!items.length) return empty("No scouting videos for the next game.");
    return '<ul class="news">' + items.slice(0, 6).map((n) => '<li><div class="nd">' + esc(fmtDayYear(n.date)) + '</div><div class="nt">' +
      (n.link ? '<a href="' + esc(n.link) + '" target="_blank" rel="noopener">' + esc(n.title) + "</a>" : esc(n.title)) + "</div>" +
      (n.text ? '<div class="small muted">' + esc(n.text) + "</div>" : "") + "</li>").join("") + "</ul>";
  }

  function whenCell(g) {
    if (!g.date) return '<div class="when"><div class="wd">' + (isForfeit(g) ? "No date" : "TBA") + "</div></div>";
    const d = asDate(g.date);
    return '<div class="when"><div class="wd">' + d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }) + " " + d.getUTCFullYear() + '</div><div class="dm">' +
      d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) + '</div><div class="tm">' + esc(g.time || "") + "</div></div>";
  }

  function gameRow(g, s, details) {
    const v = ourView(g, s);
    const ff = isForfeit(g);
    const where = ff ? "Forfeit: " + (v.win ? esc(short(v.opp)) + " didn't play, so we were awarded the win 20–0." : "we didn't play, so the game was awarded 0–20.") : venueLink(g);
    let html = '<li class="game">' + whenCell(g) + '<div class="opp">' + teamMark(v.opp) + '<div class="t"><span class="ha">' + (v.home ? "VS" : "@") + "</span>" + esc(short(v.opp)) +
      "<small>" + where + "</small></div></div>" +
      '<div class="result">' + (v.played ? resultText(v) : g.withdrawn ? '<span class="muted small">Cancelled</span>' : '<span class="badge home">' + (v.home ? "HOME" : "AWAY") + "</span>") + "</div>";
    if (details && v.played) html += boxToggle(g);
    return html + "</li>";
  }

  // Subscribe links for basketplan's calendar feed. webcal:// keeps phones and Outlook in sync.
  function calendarLinks(compact) {
    if (!CFG.calendarUrl) return "";
    const webcal = CFG.calendarUrl.replace(/^https?:/, "webcal:");
    const google = "https://calendar.google.com/calendar/render?cid=" + encodeURIComponent(webcal);
    const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    if (compact) return '<a class="cal-link" href="' + esc(webcal) + '">' + icon + "Add all games and trainings to your calendar</a>";
    return '<div class="cal"><div class="cal-text">' + icon + '<div><b>Add all H2 games and trainings to your calendar</b><span>Updates by itself when times change or a training is cancelled.</span></div></div>' +
      '<div class="cal-actions"><a href="' + esc(webcal) + '">iPhone / Mac / Outlook</a><a href="' + esc(google) + '" target="_blank" rel="noopener">Google Calendar</a><a href="' + esc(CFG.calendarUrl) + '" download="kscw-h2.ics">Download file</a></div></div>';
  }

  function viewSchedule() {
    const s = season();
    const games = teamGames(s);
    const rec = record(s);
    return '<div class="toolbar"><h2>Schedule</h2>' + seasonToggle() + "</div>" + (state.season === 0 ? calendarLinks(false) : "") +
      '<section class="card"><div class="card-head"><h3>' + esc(leagueName(s)) + " · " + esc(s.season) + '</h3><span class="muted small">Record <b class="num" style="font-size:16px;color:var(--ink)">' + rec.w + "–" + rec.l + "</b></span></div>" +
      (games.length ? '<ul class="games">' + games.map((g) => gameRow(g, s, true)).join("") + "</ul>" : empty("No games found.")) + "</section>";
  }

  // Standings columns: [key, label, hover text, default direction]. Tap a header to sort; tap again to flip.
  const STAND_COLS = [
    ["rank", "#", "League position", 1], ["team", "Team", "", 1], ["gp", "GP", "Games played", -1], ["w", "W", "Wins", -1], ["l", "L", "Losses", -1],
    ["pts", "Pts", "League points (2 per win)", -1], ["pf", "PF", "Points for (scored)", -1], ["pa", "PA", "Points against (conceded)", -1],
    ["diff", "+/-", "Point difference", -1], ["strk", "Strk", "Current streak", -1], ["form", "Last 5", "Last five games", 0],
  ];
  // Streak as a number for sorting: W3 = 3, L2 = -2.
  const streakNum = (r) => (r.streak === "–" ? 0 : (r.streak[0] === "W" ? 1 : -1) * +r.streak.slice(1));

  function viewStandings() {
    const s = season();
    const { key, dir } = state.standSort;
    const val = (r) => ({ team: short(r.team), diff: r.pf - r.pa, strk: streakNum(r) }[key] ?? r[key]);
    const rows = standings(s).sort((a, b) => (key === "team" ? val(a).localeCompare(val(b)) : val(a) - val(b)) * dir || a.rank - b.rank);
    const th = ([k, label, info, d]) => "<th" + (d ? ' class="sortable' + (k === key ? " sorted" : "") + (k === "team" ? " left" : "") + '" data-ssort="' + k + '"' : "") +
      (info ? ' title="' + info + '"' : "") + ">" + label + (k === key ? (dir < 0 ? " ▾" : " ▴") : "") + "</th>";
    const cell = (k, html) => '<td class="' + (k === key ? "hi" : "") + '">' + html + "</td>";
    return '<div class="toolbar"><h2>Standings</h2>' + seasonToggle() + "</div>" +
      '<section class="card"><div class="card-head"><h3>' + esc(leagueName(s)) + " · " + esc(s.season) + '</h3></div><div class="table-wrap"><table class="standings-table"><thead><tr>' +
      STAND_COLS.map(th).join("") + "</tr></thead><tbody>" +
      rows.map((r) => '<tr class="' + (r.team === s.team ? "us" : "") + '"><td class="rank">' + r.rank + '</td><td class="name"><div class="teamcell">' + teamMark(r.team, "sm") + "<span>" + esc(short(r.team)) + "</span></div></td>" +
        cell("gp", r.gp) + cell("w", r.w) + cell("l", r.l) + cell("pts", r.pts) + cell("pf", r.pf) + cell("pa", r.pa) +
        cell("diff", (r.pf - r.pa > 0 ? "+" : "") + (r.pf - r.pa)) + cell("strk", r.streak) + '<td><span class="form">' +
        r.form.slice(-5).map((x) => '<i class="' + (x === "W" ? "w" : "") + '" title="' + (x === "W" ? "Win" : "Loss") + '"></i>').join("") + "</span></td></tr>").join("") +
      '</tbody></table></div><p class="small muted" style="margin:12px 0 0">Win = 2 points. Ties split by head-to-head, then point difference. Tap a column to sort. Unofficial, worked out from the <a href="' + esc(s.sourceUrl) + '" target="_blank" rel="noopener">official results on basketplan</a>.</p></section>';
  }

  function viewRoster() {
    const active = state.players.filter((p) => p.active).sort((a, b) => num(a.number) - num(b.number));
    if (!active.length) return "<h2>Roster</h2>" + empty("No players yet. Add them to the <b>" + esc(CFG.tabs.players) + "</b> tab of the sheet.");
    const card = (p) => '<a class="player-card" href="#player/' + esc(p.slug) + '">' +
      (isStaff(p) ? avatar(p) : '<div class="jersey">' + esc(p.number) + "</div>") + '<div><div class="pname">' + esc(p.name) +
      (p.nationality ? ' <span title="' + esc(p.nationality) + '">' + flag(p.nationality) + "</span>" : "") + '</div><div class="pmeta">' +
      [isStaff(p) ? p.role : positions(p), p.height ? p.height + " cm" : ""].filter(Boolean).map(esc).join(" · ") + "</div></div></a>";
    const players = active.filter((p) => !isStaff(p)), staff = active.filter(isStaff);
    return '<div class="toolbar"><h2>Roster</h2><span class="muted small">' + esc(state.league.seasons[0].season) + " · " + players.length + " players</span></div>" +
      '<div class="roster">' + players.map(card).join("") + "</div>" +
      (staff.length ? '<h3 class="round-head" style="margin-top:28px">Coaching staff</h3><div class="roster">' + staff.map(card).join("") + "</div>" : "");
  }

  function viewPlayer(id) {
    const p = playerBySlug(id);
    const curList = statsFor(0), prevList = state.league.seasons[1] ? statsFor(1) : [];
    const cur = curList.find((o) => o.slug === id);
    const prev = prevList.find((o) => o.slug === id);
    const name = p ? p.name : (cur || prev || {}).name;
    if (!name) return empty("Player not found. <a href=\"#roster\">Back to roster</a>");
    const fact = (label, val) => (val ? "<div><span>" + label + "</span><b>" + esc(val) + "</b></div>" : "");
    let html = '<a class="back" href="#roster"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Roster</a><section class="profile-hero">' + avatar(p || { name }, "big") +
      '<div><div class="pos">' + esc([p && p.number ? "#" + p.number : "", p && (isStaff(p) ? p.role : positions(p))].filter(Boolean).join(" · ")) + "</div><h2>" + esc(name) + "</h2>" +
      (p && p.nickname ? '<div class="nick">“' + esc(p.nickname) + "”</div>" : "") +
      '<div class="facts">' + (p ? fact("Position", isStaff(p) ? p.role : positions(p)) + fact("Height", p.height && p.height + " cm") +
        fact("Nationality", p.nationality && (flag(p.nationality) + " " + p.nationality).trim()) + fact("Born", p.born) + fact("With H2 since", p.since) : "") + "</div></div></section>" +
      (p && p.bio ? '<p class="bio">' + esc(p.bio) + "</p>" : "");

    const tile = (val, label) => '<div class="stat-tile"><b>' + val + "</b><span>" + label + "</span></div>";
    const tiles = (o, t) => '<div class="statline">' + tile(o.gp, "Games") + (t.gs ? tile(o.gs, "Starts") : "") + tile(fmt1(o.ppg), "PPG") +
      (t.tpm ? tile(fmt1(o.tpg), "3PM / G") : "") + (t.ftm ? tile(fmt1(o.ftpg), "FTM / G") : "") + (t.pf ? tile(fmt1(o.pfpg), "Fouls / G") : "") +
      tile(o.pts, "Total") + (o.games.length ? tile(Math.max(...o.games.map((r) => r.pts)), "High") : "") + "</div>";

    const curSeason = state.league.seasons[0];
    html += '<div class="grid grid-2" style="margin-top:20px"><section class="card"><div class="card-head"><h3>' + esc(curSeason.season) + " season</h3></div>" + (cur ? tiles(cur, curList.tracked) : empty("No stats entered yet.")) + "</section>" +
      '<section class="card"><div class="card-head"><h3>Last season' + (state.league.seasons[1] ? " · " + esc(state.league.seasons[1].season) : "") + "</h3></div>" + (prev ? tiles(prev, prevList.tracked) : empty("No stats from last season.")) + "</section></div>";

    // Points per quarter: average per game, only on the player page
    const perQuarter = (o) => {
      const g = o ? o.games.filter((r) => r.q) : [];
      return g.length ? { n: g.length, avg: [0, 1, 2, 3].map((i) => g.reduce((s, r) => s + r.q[i], 0) / g.length) } : null;
    };
    const qSeasons = [[curSeason.season, perQuarter(cur)], [state.league.seasons[1] ? state.league.seasons[1].season : "", perQuarter(prev)]].filter((x) => x[1]);
    if (qSeasons.length) {
      const top = Math.max(...qSeasons.flatMap((x) => x[1].avg), 1);
      html += '<section class="card" style="margin-top:20px"><div class="card-head"><h3>Points per quarter</h3><span class="muted small">Average per game</span></div><div class="qgrid">' +
        qSeasons.map(([label, d]) => '<div class="qseason"><div class="lbl">' + esc(label) + ' <span class="muted">· ' + d.n + (d.n === 1 ? " game" : " games") + '</span></div><div class="qbars">' +
          d.avg.map((v, i) => '<div class="qbar"><b>' + fmt1(v) + '</b><div class="qtrack"><span class="qfill" style="height:' + Math.round((v / top) * 100) + '%"></span></div><em>Q' + (i + 1) + "</em></div>").join("") +
          "</div></div>").join("") + "</div></section>";
    }

    const won = state.awards.filter((a) => resolvePlayer(pick(a, "player", "winner")) === id);
    if (won.length) {
      html += '<section class="card" style="margin-top:20px"><div class="card-head"><h3>Awards</h3></div><div class="awards">' +
        won.map((a) => '<div class="award' + (isMajor(pick(a, "award")) ? " major" : "") + '"><div class="trophy">' + trophy(pick(a, "award")) + '</div><div class="aname">' + esc(pick(a, "award")) +
          '</div><div class="note">' + esc(pick(a, "season")) + "</div></div>").join("") + "</div></section>";
    }

    [[cur, curList, 0], [prev, prevList, 1]].forEach(([o, list, idx]) => {
      if (!o || !o.games.length) return;
      const sn = state.league.seasons[idx];
      const cols = [["tpm", "3PM"], ["ftm", "FTM"], ["pf", "PF"]].filter(([k]) => list.tracked[k]);
      const showGs = list.tracked.gs;
      const rows = o.games.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      html += '<section class="card" style="margin-top:20px"><div class="card-head"><h3>Game log · ' + esc(sn.season) + '</h3></div><div class="table-wrap"><table><thead><tr><th>Date</th><th class="left">Opponent</th><th>Result</th>' + (showGs ? statTh("GS") : "") + statTh("PTS") +
        cols.map((c) => statTh(c[1])).join("") + "</tr></thead><tbody>" +
        rows.map((r) => {
          const g = gameForStat(r, sn);
          const v = g ? ourView(g, sn) : null;
          const box = g ? boxInner(g) : "";
          const ncol = 4 + (showGs ? 1 : 0) + cols.length;
          return '<tr><td class="left">' + (box ? '<button type="button" class="logdate" data-logbox aria-expanded="false">' + esc(fmtDayYear(g.date)) + "</button>" : esc(fmtDayYear(g ? g.date : r.date))) + '</td><td class="name">' + (v ? '<div class="teamcell">' + teamMark(v.opp, "sm") + "<span>" + (v.home ? "vs " : "@ ") + esc(short(v.opp)) + "</span></div>" : "") +
            "</td><td>" + (v ? resultText(v).replace("</span>", "</span> ") : "") + "</td>" +
            (showGs ? '<td>' + (r.gs === 1 ? '<span class="gs-dot" title="Started">●</span>' : r.gs === 0 ? '<span class="muted">–</span>' : '<span class="muted" title="Unknown: not marked on the score sheet">?</span>') + "</td>" : "") +
            '<td class="hi">' + r.pts + "</td>" + cols.map(([k]) => "<td>" + statCell(r[k], r.est) + "</td>").join("") + "</tr>" +
            (box ? '<tr class="logbox" hidden><td colspan="' + ncol + '"><div class="box">' + box + "</div></td></tr>" : "");
        }).join("") + '</tbody></table></div><p class="small muted" style="margin:10px 0 0">Tap a date to see that game\'s box score.</p></section>';
    });
    return html;
  }

  // What each stat abbreviation means (hover text on headers, key under the table).
  const STAT_INFO = {
    GP: "Games played", GS: "Games started", PPG: "Points per game", PTS: "Points",
    "3PM/G": "3-pointers made per game", "3PM": "3-pointers made", "FTM/G": "Free throws made per game", FTM: "Free throws made",
    "PF/G": "Personal fouls per game", PF: "Personal fouls",
  };
  const statTh = (label, attrs) => "<th" + (attrs || "") + (STAT_INFO[label] ? ' title="' + STAT_INFO[label] + '"' : "") + ">" + label + "</th>";

  // [key, label, shown in "avg" / "tot" view]
  const STAT_COLS = [
    ["name", "Player", "both"], ["gp", "GP", "both"], ["gs", "GS", "both"], ["ppg", "PPG", "avg"], ["pts", "PTS", "tot"], ["tpg", "3PM/G", "avg"], ["tpm", "3PM", "tot"],
    ["ftpg", "FTM/G", "avg"], ["ftm", "FTM", "tot"], ["pfpg", "PF/G", "avg"], ["pf", "PF", "tot"],
  ];
  // Same stat in the other view, so the sort follows when switching.
  const STAT_PAIR = { ppg: "pts", pts: "ppg", tpg: "tpm", tpm: "tpg", ftpg: "ftm", ftm: "ftpg", pfpg: "pf", pf: "pfpg" };

  function viewStats() {
    const isCur = state.season === 0;
    const s = season();
    const all = statsFor(state.season);
    const list = all.filter((o) => o.gp > 0);
    const mode = state.statsMode;
    const shown = ([key, , view]) => {
      const base = { tpg: "tpm", tpm: "tpm", ftpg: "ftm", ftm: "ftm", pfpg: "pf", pf: "pf", gs: "gs" }[key];
      return (mode === "both" || view === "both" || view === mode) && (!base || all.tracked[base]);
    };
    // "both": shared columns, then all per-game columns, then all totals.
    const statCols = mode === "both"
      ? ["both", "avg", "tot"].flatMap((v) => STAT_COLS.filter((c) => c[2] === v && shown(c)))
      : STAT_COLS.filter(shown);
    const grp = (view, i) => (mode !== "both" || view === "both" ? "" : (view === "avg" ? "ga" : "gt") + (statCols.findIndex((c) => c[2] === view) === i ? " gstart" : ""));
    const count = (v) => statCols.filter((c) => c[2] === v).length;
    const k = state.sort.key, d = state.sort.dir;
    const headTh = ([key, label, view], i, extra) =>
      '<th class="sortable ' + (key === k ? "sorted" : "") + (key === "name" ? " left pcol" : "") + " " + grp(view, i) + (i === 1 || / gstart/.test(grp(view, i)) ? " snap" : "") + '" data-sort="' + key + '"' + (STAT_INFO[label] ? ' title="' + STAT_INFO[label] + '"' : "") + (extra || "") + ">" +
        label + (key === k ? '<span class="arr">' + (d < 0 ? "▾" : "▴") + "</span>" : "") + "</th>";
    // Side by side: "Player" spans both header rows, so the pinned column is one clean block on phones.
    const head = mode === "both"
      ? '<tr class="grp-row">' + headTh(statCols[0], 0, ' rowspan="2"') + (count("both") > 1 ? '<th colspan="' + (count("both") - 1) + '"></th>' : "") +
        '<th colspan="' + count("avg") + '" class="ga gstart">Per game</th><th colspan="' + count("tot") + '" class="gt gstart">Totals</th></tr>' +
        "<tr>" + statCols.map((c, i) => (i ? headTh(c, i) : "")).join("") + "</tr>"
      : "<tr>" + statCols.map((c, i) => headTh(c, i)).join("") + "</tr>";
    list.sort((a, b) => (k === "name" ? a.name.localeCompare(b.name) * d : (a[k] - b[k]) * d) || b.ppg - a.ppg);
    const fmt = (o, key) => (["ppg", "tpg", "ftpg", "pfpg"].includes(key) ? fmt1(o[key]) : total(o[key]));
    const modeToggle = '<div class="seg" role="group" aria-label="Show">' + [["avg", "Averages"], ["tot", "Totals"]].map(([m, label]) =>
      '<button type="button" data-statmode="' + m + '" class="' + (m === mode ? "on" : "") + '">' + label + "</button>").join("") + "</div>";
    const key2 = statCols.filter(([, label]) => STAT_INFO[label]).map(([, label]) => "<b>" + label + "</b> " + STAT_INFO[label].toLowerCase()).join(" · ");
    const body = list.length
      ? (mode === "both" ? "" : '<div class="card-head stats-head">' + modeToggle + "</div>") +
        '<div class="table-wrap stats-wrap"><table class="stats-table"><thead>' + head + "</thead><tbody>" +
        list.map((o) => '<tr class="clickable" data-player="' + esc(o.slug) + '">' + statCols.map(([key, , view], i) =>
          key === "name" ? '<td class="name pcol"><div class="teamcell">' + avatar(playerBySlug(o.slug) || { name: o.name }, "") + "<span>" + esc(o.name) + "</span></div></td>"
            : '<td class="' + (key === k ? "hi " : "") + grp(view, i) + '">' + fmt(o, key) + "</td>").join("") + "</tr>").join("") +
        "</tbody></table></div>"
      : empty(isCur ? "No stats yet this season. They appear here after the first game is entered." : "No stats for this season yet.");
    return '<div class="toolbar"><h2>Stats</h2>' + seasonToggle() + "</div>" + teamCard(state.season, false) + '<section class="card">' + body +
      (list.length ? '<p class="small muted stat-key">' + key2 + "</p>" : "") +
      '<p class="small muted" style="margin:8px 0 0">' + esc(s.season) + ". Per-game numbers count only games a player played. Tap a column to sort." +
      (all.tracked.gs && list.some((o) => o.games.some((r) => r.gs == null)) ? " GS counts only games where starters are marked on the score sheet." : "") + "</p></section>";
  }

  const isMajor = (award) => /mvp|mip|sixth man|defensive player|clutch/i.test(award);

  function trophy(award) {
    const a = String(award).toLowerCase();
    if (/mvp|most valuable/.test(a)) return "🏆";
    if (/\bmip\b|improv/.test(a)) return "📈";
    if (/clutch/.test(a)) return "⏱️";
    if (/championship/.test(a)) return "💍";
    if (/rebound/.test(a)) return "🧱";
    if (/playmak|assist/.test(a)) return "🪄";
    if (/heat check/.test(a)) return "🔥";
    if (/where were you/.test(a)) return "🔎";
    if (/guard me/.test(a)) return "🙅";
    if (/practice/.test(a)) return "👑";
    if (/cardio/.test(a)) return "🫀";
    if (/swiss army/.test(a)) return "🛠️";
    if (/ankle/.test(a)) return "🦴";
    if (/negotiat/.test(a)) return "🤝";
    if (/defen/.test(a)) return "🛡️";
    if (/loud|trash|mouth/.test(a)) return "📣";
    if (/rookie|newcomer/.test(a)) return "🌱";
    if (/sixth|6th|bench/.test(a)) return "🪑";
    if (/shoot|three|sniper/.test(a)) return "🎯";
    return "🏅";
  }

  function viewAwards() {
    const rows = state.awards.map((a) => ({ season: pick(a, "season"), award: pick(a, "award"), player: pick(a, "player", "winner"), note: pick(a, "note", "reason", "description") }))
      .filter((a) => a.award);
    if (!rows.length) return "<h2>Awards</h2>" + empty("No awards yet. Add them to the <b>" + esc(CFG.tabs.awards) + "</b> tab.");
    const seasons = [...new Set(rows.map((r) => r.season))].sort().reverse();
    const card = (r) => '<div class="award' + (isMajor(r.award) ? " major" : "") + '"><div class="trophy">' + trophy(r.award) + '</div><div class="aname">' + esc(r.award) +
      '</div><div class="winner">' + playerLink(r.player) + "</div>" + (r.note ? '<div class="note">' + esc(r.note) + "</div>" : "") + "</div>";
    return "<h2>Awards</h2>" + seasons.map((sn) => {
      const list = rows.filter((r) => r.season === sn);
      const major = list.filter((r) => isMajor(r.award)), fun = list.filter((r) => !isMajor(r.award));
      return '<h3 class="round-head">' + esc(sn || "Season") + " · Season awards</h3>" + '<div class="awards">' + major.map(card).join("") + "</div>" +
        (fun.length ? '<h3 class="round-head">' + esc(sn || "Season") + ' · Team awards</h3><div class="awards">' + fun.map(card).join("") + "</div>" : "");
    }).join("");
  }

  // Play types in the order a game uses them; unknown types go last.
  const PLAY_TYPES = [
    ["offense", "Offense", ""], ["man", "vs Man-to-man", "Offense against man-to-man"], ["zone", "vs Zone", "Offense against zone"],
    ["blob", "BLOB", "Baseline out of bounds"], ["slob", "SLOB", "Sideline out of bounds"], ["press", "Press break", "Full court press break"],
  ];
  function playGroup(type) {
    const t = String(type).toLowerCase();
    if (/man/.test(t)) return "man";
    if (/zone/.test(t)) return "zone";
    if (/blob|baseline/.test(t)) return "blob";
    if (/slob|sideline/.test(t)) return "slob";
    if (/press/.test(t)) return "press";
    if (/offen/.test(t)) return "offense";
    return "other";
  }

  function viewPlaybook() {
    const plays = state.playbook.map((r) => ({ name: pick(r, "name", "play"), type: pick(r, "type"), link: pick(r, "link", "url"), image: pick(r, "image"), notes: pick(r, "notes", "description") }))
      .filter((p) => p.name);
    if (!plays.length) return "<h2>Playbook</h2>" + empty("No plays yet. Add them to the <b>Playbook</b> tab of the sheet.");
    const groups = PLAY_TYPES.concat([["other", "Other", ""]]).map(([key, label, sub]) => [label, sub, plays.filter((p) => playGroup(p.type) === key)]).filter((g) => g[2].length);
    const safeLink = (u) => (/^https?:\/\//i.test(u) ? u : "");
    const card = (p) => {
      const link = safeLink(p.link);
      const img = safeLink(p.image);
      return '<' + (link ? 'a href="' + esc(link) + '" target="_blank" rel="noopener"' : "div") + ' class="play">' +
        '<div class="play-img">' + (img ? '<img src="' + esc(img) + '" alt="Court diagram for ' + esc(p.name) + '">' : '<span class="num">' + esc(p.name) + "</span>") + "</div>" +
        '<div class="play-body"><div class="play-name">' + esc(p.name) + '</div><div class="play-type">' + esc(p.type) + "</div>" +
        (p.notes ? '<div class="play-notes">' + esc(p.notes) + "</div>" : "") + (link ? '<div class="play-cta">Watch animation ↗</div>' : "") + "</div>" + (link ? "</a>" : "</div>");
    };
    return '<div class="toolbar"><h2>Playbook</h2><span class="muted small">' + plays.length + " plays · animations on HoopsGeek</span></div>" +
      groups.map(([label, sub, list]) => '<h3 class="round-head">' + esc(label) + (sub ? ' <span class="sub">· ' + esc(sub) + "</span>" : "") + '</h3><div class="plays">' + list.map(card).join("") + "</div>").join("");
  }

  function viewLeague() {
    const s = season();
    const teams = [...new Set(s.games.flatMap((g) => [g.home, g.away]))].sort();
    if (state.leagueTeam && !teams.includes(state.leagueTeam)) state.leagueTeam = "";
    const games = s.games.filter((g) => !state.leagueTeam || g.home === state.leagueTeam || g.away === state.leagueTeam);
    const byMonth = {};
    games.forEach((g) => {
      const key = g.date ? g.date.slice(0, 7) : "TBA";
      (byMonth[key] = byMonth[key] || []).push(g);
    });
    let html = '<div class="toolbar"><h2>League</h2><select id="team-filter" aria-label="Filter by team"><option value="">All teams</option>' +
      teams.map((t) => '<option value="' + esc(t) + '"' + (t === state.leagueTeam ? " selected" : "") + ">" + esc(short(t)) + "</option>").join("") + "</select>" + seasonToggle() + "</div>";
    const rows = standings(s);
    html += '<section class="card" style="margin-bottom:20px"><div class="card-head"><h3>Teams · ' + esc(leagueName(s)) + '</h3></div><div class="teams">' +
      rows.slice().sort((a, b) => short(a.team).localeCompare(short(b.team))).map((r) => {
        const club = clubFor(r.team);
        return '<div class="team-card' + (r.team === s.team ? " us" : "") + '">' + teamMark(r.team) + '<div class="tc-body"><div class="tc-name">' + esc(short(r.team)) + '</div><div class="tc-meta">' +
          ordinal(r.rank) + " · " + r.w + "–" + r.l + (club && club.website ? ' · <a href="' + esc(club.website) + '" target="_blank" rel="noopener">Website ↗</a>' : "") + "</div></div></div>";
      }).join("") + "</div></section>";
    html += '<section class="card">' + Object.keys(byMonth).sort().map((m) => '<div class="round-head">' + (m === "TBA" ? "Date TBA" : esc(monthFmt.format(asDate(m + "-01")))) + "</div>" +
      byMonth[m].map((g) => {
        const sc = hasScore(g);
        const hw = sc && g.score[0] > g.score[1];
        return '<div class="lg-game ' + (isUs(g, s) ? "us" : "") + '"><div class="h ' + (sc && !hw ? "lose" : "") + '"><span>' + esc(short(g.home)) + "</span>" + teamMark(g.home, "sm") +
          '</div><div class="s">' + (sc ? g.score[0] + "–" + g.score[1] : g.withdrawn ? "–" : '<span class="muted small">' + esc(g.time || "") + "</span>") + '</div><div class="a ' + (sc && hw ? "lose" : "") + '">' +
          teamMark(g.away, "sm") + "<span>" + esc(short(g.away)) + '</span></div><div class="when">' + (isForfeit(g) ? "Forfeit" : esc(fmtDayYear(g.date)) + (g.venue ? " · " + esc(g.venue.name) : "")) + "</div>" +
          boxToggle(g) + "</div>";
      }).join("")).join("") + "</section>";
    return html;
  }

  // ---------- router ----------
  // ---------- attendance ----------
  // Players tap In / Out for each training and game. Answers go to a private Google
  // sheet through a small Apps Script (scripts/attendance.gs); the hub only gets the
  // answers for upcoming sessions back. Saying In counts as attending.
  // Sessions open one month at a time: on the 15th the next month opens
  // (22 Oct shows October and November; from 15 Nov December too).
  const ATT_OPEN_DAY = 15;
  // Switched off in config.js (attendance: false): no tab, no Home card, no requests.
  const ATT_ON = CFG.attendance !== false && !!CFG.attendanceUrl;
  function attUntil(today) {
    const d = asDate(today || todayStr());
    const months = d.getUTCMonth() + (d.getUTCDate() >= ATT_OPEN_DAY ? 2 : 1);
    return new Date(Date.UTC(d.getUTCFullYear(), months, 0, 12)).toISOString().slice(0, 10); // last day of that month
  }
  const store = {
    get(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } },
    set(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* private mode: not remembered */ } },
  };
  const addDays = (d, n) => { const x = asDate(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const hhmm = (v) => { const m = String(v || "").trim().match(/^(\d{1,2})[:.](\d{2})/); return m ? m[1].padStart(2, "0") + ":" + m[2] : ""; };
  const rosterNames = () => state.players.filter((p) => p.active && !/coach/i.test(p.role)).map((p) => p.name);
  const me = () => { const n = store.get("h2.me"); return rosterNames().includes(n) ? n : ""; };
  const startsAt = (x) => new Date(x.date + "T" + (x.start || "23:59"));
  const mapLink = (place, address) => '<a href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([place, address].filter(Boolean).join(", ")) +
    '" target="_blank" rel="noopener">' + PIN + esc(address || place) + "</a>";

  // Rows of the Trainings tab: weekly pattern plus cancellations, moves and extra sessions.
  function trainingRows(rows) {
    return rows.map((r) => ({
      kind: pick(r, "kind").toLowerCase().trim(), day: pick(r, "day"), date: normDate(pick(r, "date")), until: normDate(pick(r, "until")),
      start: hhmm(pick(r, "start")), end: hhmm(pick(r, "end")), place: pick(r, "place"), address: pick(r, "address"), note: pick(r, "note"),
    })).filter((r) => r.kind);
  }

  // Same rules as expandTrainings() in scripts/attendance.gs and scripts/make_calendar.py. Keep them in step.
  //   weekly    day (Tue/Fri), start, end, place, address; date / until limit when the pattern applies
  //   cancelled date (and until for a range, e.g. school holidays); note is shown in the hub
  //   moved     date plus the new start / end / place / address
  //   extra     date, start, end, place, address: a one-off training
  // No training is planned on a day we have a game.
  function expandTrainings(rows, gameDates, from, to) {
    const DAYS = { su: 0, so: 0, mo: 1, tu: 2, di: 2, we: 3, mi: 3, th: 4, do: 4, fr: 5, sa: 6 };
    const byDate = {};
    const games = new Set(gameDates);
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const wd = asDate(d).getUTCDay();
      rows.forEach((r) => {
        if (r.kind !== "weekly" || DAYS[String(r.day).slice(0, 2).toLowerCase()] !== wd) return;
        if ((r.date && d < r.date) || (r.until && d > r.until) || games.has(d)) return;
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

  // Trainings and games from today on, until they start (answers can change right up to the start).
  function attSessions() {
    const s = state.league.seasons[0];
    const today = todayStr(), to = attUntil(today);
    const games = teamGames(s).filter((g) => g.date && !g.withdrawn && !hasScore(g));
    const list = expandTrainings(state.trainings, games.map((g) => g.date), today, to).map((t) => ({ ...t, type: "training", label: "Training " + t.start }));
    games.filter((g) => g.date >= today && g.date <= to).forEach((g) => {
      const v = ourView(g, s);
      list.push({ id: "G" + g.id, date: g.date, start: g.time, type: "game", game: g, label: (v.home ? "vs " : "@ ") + short(v.opp) });
    });
    const now = new Date();
    return list.filter((x) => startsAt(x) > now).sort((a, b) => startsAt(a) - startsAt(b));
  }

  // Taps still waiting to be saved count straight away, the newest one first.
  const attQueued = (test) => state.att.queue.slice().reverse().find((q) => test(q.body));
  const attPending = (id, name) => !!attQueued((b) => b.a === "set" && b.session === id && b.player === name);
  function attAwayList() {
    let list = state.att.away.slice();
    state.att.queue.forEach(({ body: b }) => {
      const same = (w) => w.player === b.player && w.from === b.from && w.to === b.to;
      if (b.a === "away" && !list.some(same)) list.push({ player: b.player, from: b.from, to: b.to });
      if (b.a === "unaway") list = list.filter((w) => !same(w));
    });
    return list;
  }

  // A player's answer; an away period with no answer counts as Out.
  function attStatus(x, name, away) {
    const q = attQueued((b) => b.a === "set" && b.session === x.id && b.player === name);
    const a = q ? q.body.status : state.att.answers[x.id] && state.att.answers[x.id][name];
    if (a) return a;
    return (away || attAwayList()).some((w) => w.player === name && w.from <= x.date && x.date <= w.to) ? "away" : "";
  }

  function attSession(x, compact) {
    const name = me();
    const away = attAwayList();
    const mine = name ? attStatus(x, name, away) : "";
    const groups = { in: [], out: [], none: [] };
    rosterNames().forEach((n) => {
      const st = attStatus(x, n, away);
      (st === "in" ? groups.in : st ? groups.out : groups.none).push(esc(n) + (st === "away" ? ' <span class="muted">(away)</span>' : ""));
    });
    const when = fmtDay(x.date) + (x.start ? " · " + x.start + (x.end ? "–" + x.end : "") : "");
    const where = x.type === "game" ? venueLink(x.game) : x.place ? mapLink(x.place, x.address) : "";
    const title = x.type === "game" ? esc(x.label) : x.cancelled ? "No training" : esc(x.place || "Training") + (x.moved ? ' <span class="badge moved">Changed</span>' : "");
    let act;
    if (x.cancelled) act = '<span class="att-note">' + esc(x.note || "Cancelled") + "</span>";
    else {
      const can = CFG.attendanceUrl && name;
      const btn = (st, label) => '<button type="button" data-att="' + esc(x.id + "|" + st) + '" class="' + (mine === st || (st === "out" && mine === "away") ? "on-" + st : "") +
        '" aria-pressed="' + (mine === st || (st === "out" && mine === "away")) + '"' + (can ? "" : " disabled") + ">" + label + "</button>";
      act = '<div class="att-btns" role="group" aria-label="' + esc("Your answer for " + when) + '">' + btn("in", "In") + btn("out", mine === "away" ? "Out · away" : "Out") + "</div>";
    }
    const counts = '<span class="att-count"><b>' + groups.in.length + "</b> in · <b>" + groups.out.length + "</b> out · " + groups.none.length + " no answer" +
      (name && attPending(x.id, name) ? ' <span class="att-saving">· saving…</span>' : "") + "</span>";
    const who = (label, list) => list.length ? '<div class="att-who"><span class="lbl">' + label + "</span>" + list.join(", ") + "</div>" : "";
    return '<article class="att-session ' + x.type + (x.cancelled ? " cancelled" : "") + '"><div class="att-info"><span class="att-kind">' + (x.type === "game" ? "Game" : "Training") +
      '</span><div class="att-title">' + title + '</div><div class="att-when">' + esc(when) + (where ? " · " + where : "") + "</div></div>" + act +
      (x.cancelled ? "" : compact ? '<div class="att-foot">' + counts + "</div>" :
        '<details class="att-foot boxtoggle" data-sid="' + esc(x.id) + '"><summary>' + counts + "</summary>" + who("In", groups.in) + who("Out", groups.out) + who("No answer", groups.none) + "</details>") + "</article>";
  }

  function attPicker(name) {
    return '<section class="card att-me"><label for="att-me">I am</label><select id="att-me"><option value="">Pick your name…</option>' +
      rosterNames().map((n) => '<option' + (n === name ? " selected" : "") + ">" + esc(n) + "</option>").join("") + '</select><span class="muted small">' +
      (name ? "Saved on this phone." : "Pick once. This phone remembers it.") + "</span></section>";
  }

  function awayCard(name) {
    const today = todayStr();
    const all = attAwayList().filter((w) => w.to >= today).sort((a, b) => a.from.localeCompare(b.from) || a.player.localeCompare(b.player));
    let html = '<section class="card"><div class="card-head"><h3>Away for a while?</h3></div><p class="muted small">Holidays, injury, work: set it once and you\'re Out for every training and game in that time. If plans change, just tap In.</p>';
    if (name && CFG.attendanceUrl) {
      html += '<form class="att-away" id="att-away"><label>From<input type="date" name="from" min="' + today + '" required></label><label>To<input type="date" name="to" min="' + today +
        '" required></label><button type="submit">Save</button></form>';
    }
    const saving = (w) => !!attQueued((b) => (b.a === "away" || b.a === "unaway") && b.player === w.player && b.from === w.from && b.to === w.to);
    html += all.length ? '<ul class="att-awaylist">' + all.map((w) => "<li><b>" + esc(w.player) + "</b><span>" + esc(fmtDay(w.from)) + " – " + esc(fmtDayYear(w.to)) + "</span>" +
      (saving(w) ? '<span class="att-saving">saving…</span>' : "") +
      (w.player === name ? '<button type="button" class="linkbtn" data-unaway="' + esc(w.from + "|" + w.to) + '">Remove</button>' : "") + "</li>").join("") + "</ul>" : "";
    return html + "</section>";
  }

  function attNotice() {
    if (!CFG.attendanceUrl) return '<p class="att-msg">Attendance isn\'t switched on yet.</p>';
    if (state.att.error) return '<p class="att-msg err" role="alert">' + esc(state.att.error) + "</p>";
    if (!state.att.loaded) return '<p class="att-msg">Loading answers…</p>';
    return "";
  }

  function viewAttendance() {
    const name = me();
    const list = attSessions();
    // grouped by month, with a line saying when the next month opens
    const months = [];
    list.forEach((x) => {
      const m = x.date.slice(0, 7);
      if (!months.length || months[months.length - 1].m !== m) months.push({ m, items: [] });
      months[months.length - 1].items.push(x);
    });
    const until = attUntil();
    const nextOpen = asDate(until.slice(0, 8) + String(ATT_OPEN_DAY).padStart(2, "0"));
    const lastGame = teamGames(state.league.seasons[0]).filter((g) => g.date).map((g) => g.date).pop() || "";
    const note = until < lastGame ? '<p class="att-msg">' + esc(monthFmt.format(asDate(addDays(until, 1))).replace(/ \d{4}$/, "")) + " opens on " +
      esc(longFmt.format(nextOpen).replace(/^\w+, /, "").replace(/ \d{4}$/, "")) + ".</p>" : "";
    return '<div class="toolbar"><h2>Attendance</h2></div>' + attPicker(name) + attNotice() +
      (list.length ? months.map((g) => '<h3 class="att-month">' + esc(monthFmt.format(asDate(g.m + "-01"))) + '</h3><div class="att-list">' +
        g.items.map((x) => attSession(x, false)).join("") + "</div>").join("") : empty("No trainings or games coming up.")) +
      note + awayCard(name) + calendarLinks(false);
  }

  // Home: the next training and the next game, with the In / Out buttons.
  function attHomeCard() {
    if (!ATT_ON) return "";
    const list = attSessions();
    const items = ["training", "game"].map((t) => list.find((x) => x.type === t && !x.cancelled)).filter(Boolean).sort((a, b) => startsAt(a) - startsAt(b));
    if (!items.length) return "";
    return '<section class="card"><div class="card-head"><h3>Are you in?</h3><a href="#attendance">All sessions →</a></div>' +
      (me() ? attNotice() : '<p class="att-msg"><a href="#attendance">Pick your name</a> once, then answer right here.</p>') +
      '<div class="att-list compact">' + items.map((x) => attSession(x, true)).join("") + "</div></section>";
  }

  const attRoute = () => ["home", "attendance"].includes((location.hash.replace(/^#/, "") || "home").split("/")[0]);

  // Redraws the page after an attendance change, keeping half-typed away dates, open name lists and focus.
  function attRefresh() {
    if (!attRoute()) return;
    const typed = {};
    document.querySelectorAll("#att-away input").forEach((i) => { typed[i.name] = i.value; });
    const open = [...document.querySelectorAll("details.att-foot[open]")].map((d) => d.dataset.sid);
    const focus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.att : "";
    render();
    document.querySelectorAll("#att-away input").forEach((i) => { if (typed[i.name]) i.value = typed[i.name]; });
    open.forEach((sid) => { const d = document.querySelector('details.att-foot[data-sid="' + sid + '"]'); if (d) d.open = true; });
    if (focus) { const f = document.querySelector('[data-att="' + focus + '"]'); if (f) f.focus(); }
  }

  // Google sometimes answers with an error page instead of data, or not at all, mostly right
  // after a quiet spell. So a request with no reply after ATT_TIMEOUT is dropped, and every
  // request is tried up to 3 times before the hub gives up.
  const ATT_TIMEOUT = 12000;
  async function attFetch(opts) {
    for (let tries = 1; ; tries++) {
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), ATT_TIMEOUT);
      try {
        const res = await fetch(CFG.attendanceUrl, { cache: "no-store", ...opts, signal: stop.signal });
        const data = await res.json();
        clearTimeout(timer);
        if (data && (data.answers || data.error)) return data;
        throw new Error("no data");
      } catch (e) {
        clearTimeout(timer);
        if (tries >= 3) throw e;
        await new Promise((r) => setTimeout(r, 1000 * tries));
      }
    }
  }

  async function attLoad() {
    if (!ATT_ON) return;
    try {
      const data = await attFetch();
      if (!data.ok) throw new Error(data.error);
      state.att.answers = data.answers || {};
      state.att.away = data.away || [];
    } catch (e) {
      state.att.error = "Couldn't load the answers. Check your connection and reload.";
    }
    state.att.loaded = true;
    attRefresh();
  }

  // Every tap shows at once and goes into a queue. Whatever is queued is sent in one
  // request; taps made meanwhile go in the next one. So the buttons never wait for Google,
  // and many quick taps cost one or two round trips instead of one each.
  function attSend(body, x) {
    state.att.queue.push({ body });
    state.att.error = "";
    if (x) attRedrawCard(x); else attRefresh();
    attFlush();
  }

  // After a tap only that session's card is redrawn (on Home and the Attendance page),
  // which keeps tapping quick even on slow phones.
  function attRedrawCard(x) {
    document.querySelectorAll('[data-att="' + x.id + '|in"]').forEach((b) => {
      const card = b.closest(".att-session");
      const open = card.querySelector("details[open]");
      const tmp = document.createElement("div");
      tmp.innerHTML = attSession(x, !!card.closest(".att-list.compact"));
      const fresh = tmp.firstElementChild;
      if (open && fresh.querySelector("details")) fresh.querySelector("details").open = true;
      card.replaceWith(fresh);
    });
    const err = document.querySelector(".att-msg.err");
    if (err) err.remove();
  }

  async function attFlush() {
    if (state.att.sending) return;
    state.att.sending = true;
    attStatusPill();
    while (state.att.queue.length) {
      const batch = state.att.queue.slice();
      let data = null;
      try {
        data = await attFetch({ method: "POST", body: JSON.stringify({ a: "batch", items: batch.map((q) => q.body) }) });
      } catch (e) {
        data = { ok: false, error: "no connection" };
      }
      state.att.queue.splice(0, batch.length);
      if (data.answers) {
        state.att.answers = data.answers;
        state.att.away = data.away || [];
      }
      if (data.error) state.att.error = "Not saved (" + data.error + "). Please tap again.";
      attRefresh();
    }
    state.att.sending = false;
    attStatusPill(true);
  }

  // Small "Saving… / Saved" note at the bottom of the screen, outside the page so redraws keep it.
  let pillTimer = null;
  function attStatusPill(done) {
    let el = document.getElementById("att-status");
    if (!el) {
      el = document.createElement("div");
      el.id = "att-status";
      el.className = "att-status";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    clearTimeout(pillTimer);
    if (!done) { el.textContent = "Saving…"; el.className = "att-status show"; return; }
    el.textContent = state.att.error ? "Not saved" : "Saved ✓";
    el.className = "att-status show" + (state.att.error ? " err" : " ok");
    pillTimer = setTimeout(() => { el.className = "att-status"; }, 1800);
  }

  // Closing the app while a tap is still on its way: let the browser ask first.
  window.addEventListener("beforeunload", (e) => {
    if (state.att.queue.length) { e.preventDefault(); e.returnValue = ""; }
  });

  function render() {
    clearInterval(countdownTimer);
    const hash = location.hash.replace(/^#/, "") || "home";
    const [route, arg] = hash.split("/");
    const views = { home: viewHome, attendance: ATT_ON ? viewAttendance : viewHome, schedule: viewSchedule, standings: viewStandings, roster: viewRoster, stats: viewStats, awards: viewAwards, playbook: viewPlaybook, league: viewLeague };
    if (route === "home") state.season = 0;
    const view = route === "player" ? () => viewPlayer(decodeURIComponent(arg || "")) : views[route] || viewHome;
    $("#view").innerHTML = view();
    document.querySelectorAll("#tabs a").forEach((a) => {
      const on = a.getAttribute("href") === "#" + (route === "player" ? "roster" : route);
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    startCountdown();
  }

  function startCountdown() {
    const el = $("#countdown");
    if (!el) return;
    const at = new Date(el.dataset.at);
    const tick = () => {
      let ms = at - new Date();
      if (ms <= 0) { el.innerHTML = "<div><b>LIVE</b><span>tip-off</span></div>"; return; }
      const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60;
      el.innerHTML = "<div><b>" + d + "</b><span>days</span></div><div><b>" + h + "</b><span>hrs</span></div><div><b>" + m + "</b><span>min</span></div>";
    };
    tick();
    countdownTimer = setInterval(tick, 30000);
  }

  // Wide tables: mark when scrolled sideways, so the pinned player column shows its soft edge.
  document.addEventListener("scroll", (e) => {
    const w = e.target;
    if (w.classList && w.classList.contains("table-wrap")) w.classList.toggle("scrolled", w.scrollLeft > 2);
  }, true);

  document.addEventListener("click", (e) => {
    const seasonBtn = e.target.closest("[data-season]");
    if (seasonBtn) { state.season = +seasonBtn.dataset.season; render(); return; }
    const seasonLink = e.target.closest("[data-season-link]");
    if (seasonLink) { e.preventDefault(); state.season = +seasonLink.dataset.seasonLink; location.hash = seasonLink.getAttribute("href"); return; }
    const modeBtn = e.target.closest("[data-statmode]");
    if (modeBtn) {
      state.statsMode = modeBtn.dataset.statmode;
      if (STAT_PAIR[state.sort.key]) state.sort = { key: STAT_PAIR[state.sort.key], dir: state.sort.dir };
      render(); return;
    }
    const attBtn = e.target.closest("[data-att]");
    if (attBtn) {
      const name = me();
      const [id, status] = attBtn.dataset.att.split("|");
      const x = attSessions().find((v) => v.id === id);
      if (!name || !x || attStatus(x, name) === status) return;
      attSend({ a: "set", session: id, date: x.date, label: x.label, player: name, status }, x);
      return;
    }
    const unaway = e.target.closest("[data-unaway]");
    if (unaway) {
      const [from, to] = unaway.dataset.unaway.split("|");
      attSend({ a: "unaway", player: me(), from, to });
      return;
    }
    const logBtn = e.target.closest("[data-logbox]");
    if (logBtn) {
      const row = logBtn.closest("tr").nextElementSibling;
      row.hidden = !row.hidden;
      logBtn.setAttribute("aria-expanded", String(!row.hidden));
      return;
    }
    const sth = e.target.closest("th[data-ssort]");
    if (sth) {
      const key = sth.dataset.ssort, col = STAND_COLS.find((c) => c[0] === key);
      state.standSort = state.standSort.key === key ? { key, dir: -state.standSort.dir } : { key, dir: col[3] };
      render(); return;
    }
    const th = e.target.closest("th[data-sort]");
    if (th) {
      const key = th.dataset.sort;
      state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === "name" ? 1 : -1 };
      render(); return;
    }
    const tr = e.target.closest("tr[data-player]");
    if (tr) location.hash = "player/" + tr.dataset.player;
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "team-filter") { state.leagueTeam = e.target.value; render(); }
    if (e.target.id === "att-me") { store.set("h2.me", e.target.value); render(); }
  });
  document.addEventListener("submit", (e) => {
    if (e.target.id !== "att-away") return;
    e.preventDefault();
    const f = new FormData(e.target);
    const from = f.get("from"), to = f.get("to");
    if (to < from) { state.att.error = "The end date is before the start date."; attRefresh(); return; }
    e.target.reset();
    attSend({ a: "away", player: me(), from, to });
  });
  window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });

  // ---------- start ----------
  async function init() {
    if (CFG.accent) document.documentElement.style.setProperty("--blue", CFG.accent);
    if (CFG.gold) document.documentElement.style.setProperty("--gold", CFG.gold);
    $("#team-name").innerHTML = esc((CFG.teamName || "Team Hub").replace(/\s+Herren\s+2$/, "")) + (CFG.shortName ? '<span class="badge-h2">' + esc(CFG.shortName) + "</span>" : "");
    document.title = (CFG.club ? CFG.club + " " : "") + (CFG.shortName || "") + " Team Hub";
    try {
      const res = await fetch("data/league.json?v=" + Date.now(), { cache: "no-store" });
      state.league = await res.json();
      // Results from score sheets that basketplan hasn't entered yet (data/results-manual.json).
      // Only fills games without a score, so basketplan's own result takes over once it's there.
      try {
        const manual = await (await fetch("data/results-manual.json?v=" + Date.now(), { cache: "no-store" })).json();
        state.league.seasons.forEach((s) => s.games.forEach((g) => {
          const m = manual[g.number];
          if (!m || hasScore(g)) return;
          Object.assign(g, { score: m.score, quarters: m.quarters, state: "gespielt", manual: true,
            points: m.score[0] > m.score[1] ? [2, 0] : [0, 2] });
        }));
      } catch (e) { /* no manual results */ }
    } catch (e) {
      $("#view").innerHTML = empty("Could not load league data (data/league.json).");
      return;
    }
    try {
      const res = await fetch("data/teams.json?v=" + Date.now(), { cache: "no-store" });
      state.clubs = (await res.json()).clubs || [];
    } catch (e) { state.clubs = []; }
    const t = CFG.tabs || {};
    // One stats tab per season, e.g. "Stats 2026/27" (local copy: data/Stats-2026-27.csv).
    const statsTab = (s) => (t.stats || "Stats") + " " + s.season;
    const [players, awards, news, playbook, trainings, ...seasonStats] = await Promise.all([
      loadTab(t.players || "Players", ["name"]), loadTab(t.awards || "Awards", ["award"]),
      loadTab(t.news || "News", ["title"]), loadTab(t.playbook || "Playbook", ["name", "link"]),
      loadTab(t.trainings || "Trainings", ["kind", "day"]),
      ...state.league.seasons.map((s) => loadTab(statsTab(s), ["date", "pts"], statsTab(s).replace(/[ /]/g, "-"))),
    ]);
    state.playbook = playbook;
    state.trainings = trainingRows(trainings);
    state.players = normPlayers(players);
    state.stats = seasonStats.flatMap((rows, idx) => rows.map((r) => ({ ...normStatRow(r), season: idx })));
    state.awards = awards;
    state.news = news;

    const cur = state.league.seasons[0];
    const rec = record(cur);
    const pos = standings(cur).find((r) => r.team === cur.team);
    $("#league-name").textContent = leagueName(cur) + " · Season " + cur.season;
    const next = teamGames(cur).find((g) => !hasScore(g) && !g.withdrawn && g.date && g.date >= todayStr());
    const chip = (big, small) => '<span class="chip"><b>' + esc(big) + "</b>" + esc(small) + "</span>";
    $("#chips").innerHTML = chip(rec.w + "–" + rec.l, "record") + (pos && rec.gp ? chip(ordinal(pos.rank), "in league") : "") +
      (next ? chip(fmtDay(next.date), (ourView(next, cur).home ? "vs " : "@ ") + short(ourView(next, cur).opp)) : "");
    const upd = new Date(state.league.updated);
    $("#updated").textContent = "League data last changed " + upd.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) + ".";
    if (!ATT_ON) { const tab = document.querySelector('#tabs a[href="#attendance"]'); if (tab) tab.remove(); }
    homeScreenHint();
    render();
    attLoad();
  }

  // "Add to home screen" note at the top right of the header, so people know the hub works
  // like an app. Tapping it shows the steps for their phone (or Android's install prompt).
  // Hidden when the hub is already opened from the home screen.
  let installPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; });
  function homeScreenHint() {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    if (standalone || $("#a2hs")) return;
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const android = /Android/.test(ua);
    const share = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4M5 11v9h14v-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    // on a phone show only its own steps; on a computer show both
    const steps = [];
    if (!android) steps.push("<b>iPhone:</b> in Safari tap Share " + share + " → <b>Add to Home Screen</b>.");
    if (!ios) steps.push("<b>Android:</b> in Chrome tap ⋮ → <b>Add to Home screen</b> (or <b>Install app</b>).");
    const box = document.createElement("div");
    box.className = "a2hs";
    box.innerHTML = '<button type="button" id="a2hs" aria-expanded="false" aria-controls="a2hs-panel">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11 18.5h2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
      "Add to home screen</button>" +
      '<div class="a2hs-panel" id="a2hs-panel" hidden><p>Open the hub like an app: one tap from your home screen, no browser.</p><ul>' +
      steps.map((x) => "<li>" + x + "</li>").join("") + '</ul><button type="button" class="a2hs-install" hidden>Install now</button></div>';
    $(".masthead-inner").appendChild(box);
    document.body.appendChild($("#a2hs-panel")); // outside the header, so the tab bar can't cover it
  }
  window.addEventListener("scroll", () => { const p = $("#a2hs-panel"); if (p && !p.hidden) { p.hidden = true; $("#a2hs").setAttribute("aria-expanded", "false"); } }, { passive: true });
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#a2hs");
    const panel = $("#a2hs-panel");
    if (btn) {
      panel.hidden = !panel.hidden;
      btn.setAttribute("aria-expanded", String(!panel.hidden));
      // placed under the button, on top of the page
      const r = btn.getBoundingClientRect();
      panel.style.top = r.bottom + 6 + "px";
      panel.style.right = Math.max(16, document.documentElement.clientWidth - r.right) + "px";
      panel.querySelector(".a2hs-install").hidden = !installPrompt;
      return;
    }
    if (e.target.closest(".a2hs-install") && installPrompt) { installPrompt.prompt(); installPrompt = null; panel.hidden = true; return; }
    if (panel && !panel.hidden && !e.target.closest(".a2hs, #a2hs-panel")) { panel.hidden = true; $("#a2hs").setAttribute("aria-expanded", "false"); }
  });
  init();
})();
