#!/usr/bin/env python3
"""Test server for the hub: serves the site and fakes the attendance Apps Script.

    python3 tests/mock_server.py            # then open http://localhost:8767/tests/run.html

/att behaves like scripts/attendance.gs (same checks and replies), but can be
made slow or failing from the tests through /att/_control:
    ?delay=2.5       seconds before each reply (Google often takes 2-4 s)
    ?fail=1          every save fails (0 = off)
    ?hiccups=2       the next 2 requests get Google's HTML error page instead of data
    ?reset=1         forget all answers and away periods
    POST trainings   replace data/Trainings.csv with the posted CSV (empty = real file)
config.js is served with attendanceUrl pointing at /att.
"""
import csv
import datetime
import http.server
import io
import json
import os
import re
import time
import urllib.parse

HUB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("PORT", "8767"))
S = {"answers": {}, "away": [], "delay": 0.0, "fail": False, "trainings": None, "posts": 0, "hiccups": 0}


def roster():
    with open(os.path.join(HUB, "data", "Players.csv"), encoding="utf-8") as f:
        return [r["name"] for r in csv.DictReader(f)
                if r["name"] and not re.match(r"^(no|n|false|0|inactive)$", r.get("active", ""), re.I)
                and "coach" not in r.get("role", "").lower()]


def today():
    return datetime.date.today().isoformat()


def list_data():
    t = today()
    answers = {sid: dict(p) for sid, p in S["answers"].items() if p.get("_date", "9999") >= t}
    for p in answers.values():
        p.pop("_date", None)
    return {"ok": True, "answers": answers, "away": [w for w in S["away"] if w["to"] >= t]}


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=HUB, **k)

    def log_message(self, *a):
        pass

    def reply(self, body, ctype="application/json"):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def hiccup(self):
        """Answer like Google does now and then: an HTML error page, not JSON."""
        if S["hiccups"] <= 0:
            return False
        S["hiccups"] -= 1
        self.reply(b"<!DOCTYPE html><html><body>Sorry, unable to open the file at this time.</body></html>", "text/html")
        return True

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        if url.path == "/att/_control":
            if "delay" in q:
                S["delay"] = float(q["delay"])
            if "fail" in q:
                S["fail"] = q["fail"] == "1"
            if "hiccups" in q:
                S["hiccups"] = int(q["hiccups"])
            if q.get("reset") == "1":
                S["answers"], S["away"], S["posts"] = {}, [], 0
            return self.reply({"ok": True, "delay": S["delay"], "fail": S["fail"], "posts": S["posts"], **list_data()})
        if url.path == "/att":
            time.sleep(S["delay"])
            if self.hiccup():
                return
            return self.reply(list_data())
        if url.path == "/config.js":
            s = open(os.path.join(HUB, "config.js"), encoding="utf-8").read()
            s = re.sub(r'attendanceUrl: "[^"]*"', 'attendanceUrl: "/att"', s)
            return self.reply(s.encode(), "text/javascript")
        if url.path == "/data/Trainings.csv" and S["trainings"]:
            return self.reply(S["trainings"].encode(), "text/csv")
        return super().do_GET()

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8")
        if url.path == "/att/_control":
            S["trainings"] = raw or None
            return self.reply({"ok": True})
        time.sleep(S["delay"])
        if self.hiccup():
            return
        S["posts"] += 1
        try:
            body = json.loads(raw)
        except ValueError:
            return self.reply({"ok": False, "error": "Bad request"})
        items = body.get("items", []) if body.get("a") == "batch" else [body]
        errors = [e for e in (self.apply(b) for b in items) if e]
        out = list_data()
        if errors:
            out.update(ok=len(items) > len(errors), error=errors[0], errors=errors)
        return self.reply(out)

    def apply(self, b):
        """One change, checked like scripts/attendance.gs. Returns an error text or None."""
        if S["fail"]:
            return "Test failure"
        if b.get("player") not in roster():
            return "Unknown player"
        if b.get("a") == "set":
            if not re.match(r"^(T\d{4}-\d{2}-\d{2}|G\d+)$", b.get("session", "")):
                return "Bad session"
            if b.get("date", "") < today():
                return "This session is over"
            if b.get("status") not in ("in", "out"):
                return "Bad status"
            S["answers"].setdefault(b["session"], {"_date": b["date"]})[b["player"]] = b["status"]
        elif b.get("a") == "away":
            if not b.get("from") or not b.get("to") or b["to"] < b["from"]:
                return "Check the dates"
            w = {"player": b["player"], "from": b["from"], "to": b["to"]}
            if w not in S["away"]:
                S["away"].append(w)
        elif b.get("a") == "unaway":
            S["away"] = [w for w in S["away"] if not (w["player"] == b["player"] and w["from"] == b["from"] and w["to"] == b["to"])]
        else:
            return "Unknown action"
        return None


if __name__ == "__main__":
    print("Hub test server on http://localhost:%d/tests/run.html" % PORT, flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
