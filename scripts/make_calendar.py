#!/usr/bin/env python3
"""Write data/team.ics: this season's games plus all planned trainings, for
phones to subscribe to. Cancelled trainings are left out, so they disappear
from calendars on the next refresh.

Games come from data/league.json; trainings from the hub sheet's Trainings tab
(or data/Trainings.csv when the sheet can't be read).
Standard library only.  Usage:  python3 scripts/make_calendar.py
"""
import csv
import io
import json
import os
import re
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "team.ics")
SHEET_ID = "1uqdwqKDBaPhrfV_0vpxq2teJHUE5p9HwCo9FDXZT-z0"
LAST_DAY = "2027-07-31"  # trainings are listed up to here (or the pattern's own end date)
GAME_MINUTES = 120

VTIMEZONE = """BEGIN:VTIMEZONE
TZID:Europe/Zurich
BEGIN:DAYLIGHT
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE"""


def norm_date(v):
    v = (v or "").strip()
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", v)
    if m:
        return "%s-%02d-%02d" % (m[1], int(m[2]), int(m[3]))
    m = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})$", v)
    if m:
        return "%s-%02d-%02d" % (m[3], int(m[2]), int(m[1]))
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", v)
    if m:
        return "%s-%02d-%02d" % (m[3], int(m[1]), int(m[2]))
    return v


def hhmm(v):
    m = re.match(r"^(\d{1,2})[:.](\d{2})", (v or "").strip())
    return "%02d:%s" % (int(m[1]), m[2]) if m else ""


def training_rows():
    """Rows of the Trainings tab, from the Google Sheet or the local CSV copy."""
    url = ("https://docs.google.com/spreadsheets/d/%s/gviz/tq?tqx=out:csv&headers=1&sheet=%s"
           % (SHEET_ID, urllib.parse.quote("Trainings")))
    rows = None
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            text = resp.read().decode("utf-8")
        rows = list(csv.DictReader(io.StringIO(text)))
        # Google returns the first tab when a tab is missing, so check the header
        if not rows or "kind" not in {k.strip().lower() for k in rows[0]}:
            rows = None
    except Exception:
        rows = None
    if rows is None:
        with open(os.path.join(ROOT, "data", "Trainings.csv"), encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    out = []
    for r in rows:
        r = {k.strip().lower(): (v or "").strip() for k, v in r.items() if k}
        if not r.get("kind"):
            continue
        out.append({
            "kind": r["kind"].lower(), "day": r.get("day", ""), "date": norm_date(r.get("date")),
            "until": norm_date(r.get("until")), "start": hhmm(r.get("start")), "end": hhmm(r.get("end")),
            "place": r.get("place", ""), "address": r.get("address", ""), "note": r.get("note", ""),
        })
    return out


def add_days(d, n):
    return (date.fromisoformat(d) + timedelta(days=n)).isoformat()


# Same rules as expandTrainings() in app.js and scripts/attendance.gs. Keep them in step.
def expand_trainings(rows, game_dates, start, end):
    days = {"su": 0, "so": 0, "mo": 1, "tu": 2, "di": 2, "we": 3, "mi": 3, "th": 4, "do": 4, "fr": 5, "sa": 6}
    by_date = {}
    d = start
    while d <= end:
        wd = (date.fromisoformat(d).weekday() + 1) % 7  # Sunday = 0, as in JavaScript
        for r in rows:
            if r["kind"] != "weekly" or days.get(r["day"][:2].lower()) != wd:
                continue
            if (r["date"] and d < r["date"]) or (r["until"] and d > r["until"]) or d in game_dates:
                continue
            by_date[d] = {"date": d, "start": r["start"], "end": r["end"], "place": r["place"], "address": r["address"], "note": ""}
        d = add_days(d, 1)
    for r in rows:
        if not r["date"]:
            continue
        if r["kind"] == "extra" and start <= r["date"] <= end:
            by_date[r["date"]] = {k: r[k] for k in ("date", "start", "end", "place", "address", "note")}
        if r["kind"] == "moved" and r["date"] in by_date:
            for k in ("start", "end", "place", "address", "note"):
                if r[k]:
                    by_date[r["date"]][k] = r[k]
    for r in rows:
        if r["kind"] != "cancelled" or not r["date"]:
            continue
        for d in by_date:
            if r["date"] <= d <= (r["until"] or r["date"]):
                by_date[d]["cancelled"] = True
    return [by_date[d] for d in sorted(by_date)]


def esc(text):
    return str(text).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def stamp(d, t):
    return d.replace("-", "") + "T" + t.replace(":", "") + "00"


def event(uid, d, start, end, summary, location, description=""):
    lines = ["BEGIN:VEVENT", "UID:" + uid, "DTSTAMP:20261001T000000Z"]  # fixed stamp, so the file only changes when an event does
    if start:
        lines += ["DTSTART;TZID=Europe/Zurich:" + stamp(d, start), "DTEND;TZID=Europe/Zurich:" + stamp(d, end)]
    else:
        lines += ["DTSTART;VALUE=DATE:" + d.replace("-", ""), "DTEND;VALUE=DATE:" + add_days(d, 1).replace("-", "")]
    lines += ["SUMMARY:" + esc(summary)]
    if location:
        lines.append("LOCATION:" + esc(location))
    if description:
        lines.append("DESCRIPTION:" + esc(description))
    return lines + ["END:VEVENT"]


def main():
    with open(os.path.join(ROOT, "data", "league.json"), encoding="utf-8") as f:
        season = json.load(f)["seasons"][0]
    team = season["team"]
    short = lambda n: re.sub(r"\s+H\d$", "", n)
    games = [g for g in season["games"] if team in (g["home"], g["away"]) and g.get("date") and not g.get("withdrawn")]

    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//KSCW H2 Team Hub//EN", "CALSCALE:GREGORIAN",
             "METHOD:PUBLISH", "X-WR-CALNAME:KSCW H2", "X-WR-TIMEZONE:Europe/Zurich",
             "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H"] + VTIMEZONE.split("\n")

    for g in games:
        home = g["home"] == team
        title = "🏀 KSCW H2 " + ("vs " if home else "@ ") + short(g["away"] if home else g["home"])
        if g.get("score") and None not in g["score"]:
            us, them = (g["score"] if home else g["score"][::-1])
            title += " (%s %d–%d)" % ("W" if us > them else "L", us, them)
        v = g.get("venue") or {}
        where = ", ".join(x for x in (v.get("name"), v.get("address"), " ".join(filter(None, (v.get("zip"), v.get("city"))))) if x)
        start = g.get("time") or ""
        end = (datetime.strptime(start, "%H:%M") + timedelta(minutes=GAME_MINUTES)).strftime("%H:%M") if start else ""
        lines += event("game-%s@kscw-h2" % g["id"], g["date"], start, end, title, where, "Round %s · %s" % (g.get("round", ""), g.get("number", "")))

    rows = training_rows()
    firsts = sorted(r["date"] for r in rows if r["kind"] == "weekly" and r["date"])
    first = firsts[0] if firsts else date.today().isoformat()
    for t in expand_trainings(rows, {g["date"] for g in games}, first, LAST_DAY):
        if t.get("cancelled"):
            continue
        where = ", ".join(x for x in (t["place"], t["address"]) if x)
        lines += event("training-%s@kscw-h2" % t["date"], t["date"], t["start"], t["end"] or t["start"], "KSCW H2 Training", where, t.get("note", ""))

    lines.append("END:VCALENDAR")
    # iCalendar wants CRLF line ends and lines of at most 75 bytes
    folded = []
    for line in lines:
        b = line.encode("utf-8")
        while len(b) > 75:
            cut = 75
            while (b[cut] & 0xC0) == 0x80:  # don't split a UTF-8 character
                cut -= 1
            folded.append(b[:cut].decode("utf-8"))
            b = b" " + b[cut:]
        folded.append(b.decode("utf-8"))
    with open(OUT, "w", encoding="utf-8", newline="") as f:
        f.write("\r\n".join(folded) + "\r\n")
    print("Wrote %s (%d games)" % (OUT, len(games)))


if __name__ == "__main__":
    main()
