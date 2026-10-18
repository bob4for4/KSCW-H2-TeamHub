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
    stats: [],
    lastSeason: [],
    awards: [],
    news: [],
    playbook: [],
    clubs: [],
    season: 0, // index into league.seasons (0 = current)
    leagueTeam: "",
    sort: { key: "ppg", dir: -1 },
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
  async function loadTab(name, required) {
    const looksRight = (rows) => !!rows && (!rows.length ? true : (required || []).every((c) => c in rows[0]));
    // ?local=1 in the address uses the data/ files only (handy for testing)
    if (CFG.googleSheetId && !/[?&]local=1\b/.test(location.search)) {
      const rows = await fetchCSV("https://docs.google.com/spreadsheets/d/" + encodeURIComponent(CFG.googleSheetId) +
        "/gviz/tq?tqx=out:csv&headers=1&sheet=" + encodeURIComponent(name));
      if (rows && rows.length && looksRight(rows)) return rows;
      console.warn("Google Sheet tab not readable, using data/" + name + ".csv instead:", name);
    }
    return (await fetchCSV("data/" + encodeURIComponent(name) + ".csv?v=" + Date.now())) || [];
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
    };
  }

  const season = () => state.league.seasons[state.season];
  const isUs = (g, s) => g.home === s.team || g.away === s.team;
  const teamGames = (s) => s.games.filter((g) => isUs(g, s));
  const hasScore = (g) => Array.isArray(g.score) && g.score[0] != null && g.score[1] != null;

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
    let w = 0, l = 0, pf = 0, pa = 0;
    teamGames(s).forEach((g) => {
      const v = ourView(g, s);
      if (!v.played || !g.counts) return;
      v.win ? w++ : l++;
      pf += v.us; pa += v.them;
    });
    return { w, l, pf, pa, gp: w + l };
  }

  // Standings worked out from final results: points, then head-to-head, then point difference.
  function standings(s) {
    const t = {};
    const row = (name) => (t[name] = t[name] || { team: name, gp: 0, w: 0, l: 0, pts: 0, pf: 0, pa: 0, form: [] });
    s.games.forEach((g) => { row(g.home); row(g.away); });
    const played = s.games.filter((g) => hasScore(g) && g.counts)
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
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
      if (!r.player || r.dnp || r.pts == null) return;
      if (!games.some((g) => statMatchesGame(r, g))) return;
      const k = resolvePlayer(r.player);
      const o = (by[k] = by[k] || { slug: k, name: r.player, gp: 0, pts: 0, tpm: 0, ftm: 0, fta: 0, pf: 0, gs: 0, games: [] });
      o.gp++;
      STAT_KEYS.forEach((key) => { o[key] += r[key] || 0; });
      o.games.push(r);
    });
    return finishAverages(Object.values(by), trackedIn(Object.values(by).flatMap((o) => o.games)));
  }

  // Last season: one row per player with season totals (gp + totals).
  // Season totals from the LastSeason tab (one row per player), used when a past
  // season has no game-by-game rows in the Stats tab.
  function lastSeasonAverages() {
    const rows = state.lastSeason.filter((r) => r.player);
    return finishAverages(rows.map((r) => ({
      slug: resolvePlayer(r.player), name: r.player, gp: r.gp, pts: r.pts || 0, tpm: r.tpm || 0, ftm: r.ftm || 0, fta: r.fta || 0, pf: r.pf || 0, games: [],
    })), trackedIn(rows));
  }

  // Which stats were recorded at all in a set of rows.
  function trackedIn(rows) {
    const t = {};
    STAT_KEYS.forEach((k) => { t[k] = rows.some((r) => r[k] != null); });
    return t;
  }

  function statsFor(idx) {
    const list = playerAverages(idx);
    if (!list.length && idx > 0) return lastSeasonAverages();
    return list;
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
    const rows = state.stats.filter((r) => !r.dnp && r.player && r.pts != null && statMatchesGame(r, g));
    if (!rows.length) return "";
    rows.sort((a, b) => b.pts - a.pts);
    const t = trackedIn(rows);
    const cols = [["pts", "PTS"], ["tpm", "3PM"], ["ftm", "FTM"], ["pf", "PF"]].filter(([k]) => t[k]);
    return '<h3 style="margin-top:14px">H2 box score</h3><div class="table-wrap"><table><thead><tr><th>Player</th>' + cols.map((c) => "<th>" + c[1] + "</th>").join("") + "</tr></thead><tbody>" +
      rows.map((r) => '<tr><td class="name">' + playerLink(r.player) + "</td>" + cols.map(([k], i) => '<td class="' + (i === 0 ? "hi" : "") + '">' + (k === "pts" ? statCell(r[k]) : statCell(r[k], r.est)) + "</td>").join("") + "</tr>").join("") +
      "</tbody></table></div>";
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

    // Last season
    const prev = state.league.seasons[1];
    if (prev) {
      const rec = record(prev);
      const pt = standings(prev).find((r) => r.team === prev.team);
      html += '<section class="card"><div class="card-head"><h3>Last season · ' + esc(prev.season) + '</h3><a href="#schedule" data-season-link="1">Results →</a></div>' +
        '<div class="statline two"><div class="stat-tile"><b>' + rec.w + "–" + rec.l + "</b><span>Record</span></div>" +
        (pt ? '<div class="stat-tile"><b>' + ordinal(pt.rank) + "</b><span>" + esc(leagueName(prev)) + "</span></div>" : "") +
        '<div class="stat-tile"><b>' + (rec.gp ? fmt1(rec.pf / rec.gp) : "–") + "</b><span>PPG</span></div>" +
        '<div class="stat-tile"><b>' + (rec.gp ? fmt1(rec.pa / rec.gp) : "–") + "</b><span>Opp PPG</span></div></div></section>";
    }

    // News
    html += '<section class="card"><div class="card-head"><h3>News</h3></div>' + newsList(s, results) + "</section>";
    html += "</div></div>";
    return html;
  }

  function newsList(s, results) {
    const items = state.news.map((n) => ({ date: normDate(pick(n, "date")), title: pick(n, "title", "headline"), text: pick(n, "text", "body"), link: pick(n, "link", "url") }))
      .filter((n) => n.title);
    results.slice(0, 3).forEach((g) => {
      const v = ourView(g, s);
      items.push({
        date: g.date,
        title: (v.win ? "H2 beat " : "H2 fell to ") + short(v.opp) + " " + v.us + "–" + v.them,
        text: (v.home ? "Home game at " : "Away game at ") + (g.venue ? g.venue.name : "") + ".",
      });
    });
    items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    if (!items.length) return empty("No news yet.");
    return '<ul class="news">' + items.slice(0, 6).map((n) => '<li><div class="nd">' + esc(fmtDayYear(n.date)) + '</div><div class="nt">' +
      (n.link ? '<a href="' + esc(n.link) + '" target="_blank" rel="noopener">' + esc(n.title) + "</a>" : esc(n.title)) + "</div>" +
      (n.text ? '<div class="small muted">' + esc(n.text) + "</div>" : "") + "</li>").join("") + "</ul>";
  }

  function whenCell(g) {
    if (!g.date) return '<div class="when"><div class="wd">TBA</div></div>';
    const d = asDate(g.date);
    return '<div class="when"><div class="wd">' + d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }) + " " + d.getUTCFullYear() + '</div><div class="dm">' +
      d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) + '</div><div class="tm">' + esc(g.time || "") + "</div></div>";
  }

  function gameRow(g, s, details) {
    const v = ourView(g, s);
    let html = '<li class="game">' + whenCell(g) + '<div class="opp">' + teamMark(v.opp) + '<div class="t"><span class="ha">' + (v.home ? "VS" : "@") + "</span>" + esc(short(v.opp)) +
      "<small>" + venueLink(g) + "</small></div></div>" +
      '<div class="result">' + (v.played ? resultText(v) : g.withdrawn ? '<span class="muted small">Cancelled</span>' : '<span class="badge home">' + (v.home ? "HOME" : "AWAY") + "</span>") + "</div>";
    if (details && v.played) {
      html += "<details><summary>Box score</summary><div class=\"box\">" + quarterTable(g) + boxScore(g) +
        (g.referees.length ? '<div class="small muted" style="margin-top:10px">Referees: ' + g.referees.map(esc).join(", ") + "</div>" : "") + "</div></details>";
    }
    return html + "</li>";
  }

  // Subscribe links for basketplan's calendar feed. webcal:// keeps phones and Outlook in sync.
  function calendarLinks(compact) {
    if (!CFG.calendarUrl) return "";
    const webcal = CFG.calendarUrl.replace(/^https?:/, "webcal:");
    const google = "https://calendar.google.com/calendar/render?cid=" + encodeURIComponent(webcal);
    const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    if (compact) return '<a class="cal-link" href="' + esc(webcal) + '">' + icon + "Add all games to your calendar</a>";
    return '<div class="cal"><div class="cal-text">' + icon + '<div><b>Add all H2 games to your calendar</b><span>Updates automatically when times or venues change.</span></div></div>' +
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

  function viewStandings() {
    const s = season();
    const rows = standings(s);
    return '<div class="toolbar"><h2>Standings</h2>' + seasonToggle() + "</div>" +
      '<section class="card"><div class="card-head"><h3>' + esc(leagueName(s)) + " · " + esc(s.season) + '</h3></div><div class="table-wrap"><table><thead><tr><th>#</th><th class="left">Team</th><th>GP</th><th>W</th><th>L</th><th>Pts</th><th>PF</th><th>PA</th><th>+/-</th><th>Strk</th><th>Last 5</th></tr></thead><tbody>' +
      rows.map((r) => '<tr class="' + (r.team === s.team ? "us" : "") + '"><td class="rank">' + r.rank + '</td><td class="name"><div class="teamcell">' + teamMark(r.team, "sm") + "<span>" + esc(short(r.team)) + "</span></div></td><td>" + r.gp + "</td><td>" + r.w + "</td><td>" + r.l +
        '</td><td class="hi">' + r.pts + "</td><td>" + r.pf + "</td><td>" + r.pa + "</td><td>" + (r.pf - r.pa > 0 ? "+" : "") + (r.pf - r.pa) + "</td><td>" + r.streak + '</td><td><span class="form">' +
        r.form.slice(-5).map((x) => '<i class="' + (x === "W" ? "w" : "") + '" title="' + (x === "W" ? "Win" : "Loss") + '"></i>').join("") + "</span></td></tr>").join("") +
      '</tbody></table></div><p class="small muted" style="margin:12px 0 0">Win = 2 points. Ties split by head-to-head, then point difference. Unofficial, worked out from the <a href="' + esc(s.sourceUrl) + '" target="_blank" rel="noopener">official results on basketplan</a>.</p></section>';
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
      html += '<section class="card" style="margin-top:20px"><div class="card-head"><h3>Game log · ' + esc(sn.season) + '</h3></div><div class="table-wrap"><table><thead><tr><th>Date</th><th class="left">Opponent</th><th>Result</th>' + (showGs ? '<th title="Started the game">GS</th>' : "") + '<th>PTS</th>' +
        cols.map((c) => "<th>" + c[1] + "</th>").join("") + "</tr></thead><tbody>" +
        rows.map((r) => {
          const g = gameForStat(r, sn);
          const v = g ? ourView(g, sn) : null;
          return '<tr><td class="left">' + esc(fmtDayYear(g ? g.date : r.date)) + '</td><td class="name">' + (v ? '<div class="teamcell">' + teamMark(v.opp, "sm") + "<span>" + (v.home ? "vs " : "@ ") + esc(short(v.opp)) + "</span></div>" : "") +
            "</td><td>" + (v ? resultText(v).replace("</span>", "</span> ") : "") + "</td>" +
            (showGs ? '<td>' + (r.gs === 1 ? '<span class="gs-dot" title="Started">●</span>' : r.gs === 0 ? '<span class="muted">–</span>' : '<span class="muted" title="Unknown: not marked on the score sheet">?</span>') + "</td>" : "") +
            '<td class="hi">' + r.pts + "</td>" + cols.map(([k]) => "<td>" + statCell(r[k], r.est) + "</td>").join("") + "</tr>";
        }).join("") + "</tbody></table></div></section>";
    });
    return html;
  }

  const STAT_COLS = [
    ["name", "Player", false], ["gp", "GP", true], ["gs", "GS", true], ["ppg", "PPG", true], ["pts", "PTS", true], ["tpg", "3PM/G", true], ["tpm", "3PM", true],
    ["ftpg", "FTM/G", true], ["ftm", "FTM", true], ["pfpg", "PF/G", true], ["pf", "PF", true],
  ];

  function viewStats() {
    const isCur = state.season === 0;
    const s = season();
    const all = statsFor(state.season);
    const list = all.filter((o) => o.gp > 0);
    const statCols = STAT_COLS.filter(([key]) => {
      const base = { tpg: "tpm", tpm: "tpm", ftpg: "ftm", ftm: "ftm", pfpg: "pf", pf: "pf", gs: "gs" }[key];
      return !base || all.tracked[base];
    });
    const k = state.sort.key, d = state.sort.dir;
    list.sort((a, b) => (k === "name" ? a.name.localeCompare(b.name) * d : (a[k] - b[k]) * d) || b.ppg - a.ppg);
    const fmt = (o, key) => (["ppg", "tpg", "ftpg", "pfpg"].includes(key) ? fmt1(o[key]) : total(o[key]));
    const body = list.length
      ? '<div class="table-wrap"><table><thead><tr>' + statCols.map(([key, label]) =>
          '<th class="sortable ' + (key === k ? "sorted" : "") + (key === "name" ? " left" : "") + '" data-sort="' + key + '">' + label + (key === k ? (d < 0 ? " ▾" : " ▴") : "") + "</th>").join("") + "</tr></thead><tbody>" +
        list.map((o) => '<tr class="clickable" data-player="' + esc(o.slug) + '">' + statCols.map(([key]) =>
          key === "name" ? '<td class="name"><div class="teamcell">' + avatar(playerBySlug(o.slug) || { name: o.name }, "") + "<span>" + esc(o.name) + "</span></div></td>"
            : '<td class="' + (key === k ? "hi" : "") + '">' + fmt(o, key) + "</td>").join("") + "</tr>").join("") +
        "</tbody></table></div>"
      : empty(isCur ? "No stats yet this season. They appear here after the first game is entered." : "No stats for this season yet.");
    return '<div class="toolbar"><h2>Stats</h2>' + seasonToggle() + '</div><section class="card">' + body +
      '<p class="small muted" style="margin:12px 0 0">' + esc(s.season) + ". Per-game numbers count only games a player played. Tap a column to sort." +
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
          teamMark(g.away, "sm") + "<span>" + esc(short(g.away)) + '</span></div><div class="when">' + esc(fmtDayYear(g.date)) + (g.venue ? " · " + esc(g.venue.name) : "") + "</div></div>";
      }).join("")).join("") + "</section>";
    return html;
  }

  // ---------- router ----------
  function render() {
    clearInterval(countdownTimer);
    const hash = location.hash.replace(/^#/, "") || "home";
    const [route, arg] = hash.split("/");
    const views = { home: viewHome, schedule: viewSchedule, standings: viewStandings, roster: viewRoster, stats: viewStats, awards: viewAwards, playbook: viewPlaybook, league: viewLeague };
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

  document.addEventListener("click", (e) => {
    const seasonBtn = e.target.closest("[data-season]");
    if (seasonBtn) { state.season = +seasonBtn.dataset.season; render(); return; }
    const seasonLink = e.target.closest("[data-season-link]");
    if (seasonLink) { e.preventDefault(); state.season = +seasonLink.dataset.seasonLink; location.hash = seasonLink.getAttribute("href"); return; }
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
    } catch (e) {
      $("#view").innerHTML = empty("Could not load league data (data/league.json).");
      return;
    }
    try {
      const res = await fetch("data/teams.json?v=" + Date.now(), { cache: "no-store" });
      state.clubs = (await res.json()).clubs || [];
    } catch (e) { state.clubs = []; }
    const t = CFG.tabs || {};
    const [players, stats, lastSeason, awards, news, playbook] = await Promise.all([
      loadTab(t.players || "Players", ["name"]), loadTab(t.stats || "Stats", ["date", "pts"]), loadTab(t.lastSeason || "LastSeason", ["gp"]),
      loadTab(t.awards || "Awards", ["award"]), loadTab(t.news || "News", ["title"]), loadTab(t.playbook || "Playbook", ["name", "link"]),
    ]);
    state.playbook = playbook;
    state.players = normPlayers(players);
    state.stats = stats.map(normStatRow);
    state.lastSeason = lastSeason.map(normStatRow);
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
    render();
  }
  init();
})();
