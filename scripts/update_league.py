#!/usr/bin/env python3
"""Pull league schedules and results from basketplan.ch (the system behind
probasket.ch) and write them to data/league.json for the hub.

Standard library only, so it runs anywhere Python 3.8+ is installed.
Usage:  python3 scripts/update_league.py
"""
import json
import os
import ssl
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "data", "seasons.json")
OUT = os.path.join(ROOT, "data", "league.json")
BASE = "https://www.basketplan.ch"


def ssl_context():
    # python.org installs on macOS ship without system certificates
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def fetch(path):
    url = BASE + path + "&xmlView=true&perspective=de_default"
    req = urllib.request.Request(url, headers={"User-Agent": "KSCW-H2-team-hub/1.0"})
    with urllib.request.urlopen(req, timeout=60, context=ssl_context()) as resp:
        return resp.read()


def find_league_holding(federation_id, season_id, league_short):
    root = ET.fromstring(fetch(
        "/findAllLeagueHoldings.do?federationId=%s&seasonId=%s" % (federation_id, season_id)))
    for lh in root.iter("leagueHolding"):
        if lh.get("fullName", "").startswith(league_short + " "):
            return lh.get("id"), lh.get("fullName")
    raise SystemExit("League %s not found for season %s" % (league_short, season_id))


def as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_game(g):
    res = g.find("result")
    loc = g.find("location")
    state = g.find("state")
    home, guest = g.find("homeTeam"), g.find("guestTeam")
    game = {
        "id": g.get("id"),
        "number": g.get("gameNumber"),
        "date": g.get("date"),
        "time": g.get("time"),
        "round": as_int(g.get("runde")),
        "home": g.get("homeTeamLabel"),
        "away": g.get("guestTeamLabel"),
        "homeClub": home.get("clubShortName") if home is not None else None,
        "awayClub": guest.get("clubShortName") if guest is not None else None,
        "final": g.get("final") == "true",
        "withdrawn": g.get("withdrawn") == "true",
        "counts": g.get("considerOnRanking") == "true",
        "state": state.get("name") if state is not None else None,
        "venue": None,
        "referees": [n for n in (g.get("referee1Name"), g.get("referee2Name")) if n],
    }
    if loc is not None:
        game["venue"] = {
            "name": loc.get("name"),
            "address": loc.get("line1"),
            "zip": loc.get("zip"),
            "city": loc.get("city"),
        }
    if res is not None and res.get("homeTeamScore") is not None:
        quarters = []
        for key in ("Leg1", "Leg2", "Leg3", "Leg4", "Overtime1", "Overtime2", "Overtime3"):
            h, a = res.get("homeTeamScore" + key), res.get("guestTeamScore" + key)
            if h is not None or a is not None:
                quarters.append([as_int(h), as_int(a)])
        game["score"] = [as_int(res.get("homeTeamScore")), as_int(res.get("guestTeamScore"))]
        game["quarters"] = quarters
        game["points"] = [as_int(res.get("homeTeamPoints")), as_int(res.get("guestTeamPoints"))]
    return game


def load_season(federation_id, season, league_short):
    holding_id, full_name = find_league_holding(federation_id, season["id"], league_short)
    root = ET.fromstring(fetch("/showLeagueSchedule.do?leagueHoldingId=%s" % holding_id))
    games = [parse_game(g) for g in root.iter("game")]
    games.sort(key=lambda x: (x["date"] or "", x["time"] or ""))
    return {
        "season": season["label"],
        "team": season["team"],
        "league": full_name,
        "leagueHoldingId": holding_id,
        "sourceUrl": BASE + "/showLeagueSchedule.do?leagueHoldingId=%s" % holding_id,
        "games": games,
    }


def main():
    with open(CONFIG, encoding="utf-8") as f:
        cfg = json.load(f)
    out = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "seasons": []}
    for season in cfg["seasons"]:
        data = load_season(cfg["federationId"], season, season["league"])
        out["seasons"].append(data)
        print("%s: %d games" % (data["league"], len(data["games"])))

    # Only rewrite the file when the league data changed, so the scheduled job
    # doesn't commit every run just because the timestamp moved.
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            old = json.load(f)
        if old.get("seasons") == out["seasons"]:
            print("No changes.")
            return
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("Wrote", os.path.relpath(OUT, ROOT))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # keep the old data if basketplan is down
        print("Update failed:", exc, file=sys.stderr)
        sys.exit(1)
