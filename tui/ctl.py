#!/usr/bin/env python3
"""ctl — the TUI for evidence-mcp.

Top:    nav menus — Log ((b)ottom, (t)op, (c)lear), Admin ((u)pdate, (q)uit); host badge
        Space pauses the view / jumps back to the end; scrolling back pauses too
        Drag to select text: it is copied on release (OSC 52); URLs are hyperlinks (OSC 8)
        Double-click selects (and copies) that one line, not the whole pane
Middle: <library>/logs/evidence.log, followed live (tail -F), coloured per field;
        (m)ark appends "==== mark <time> ====" between blank lines, (e)rase
        (pressed twice) truncates the file
        (verify lines: verdict green / red / yellow for pass / fail / unverifiable,
        basis coloured like a level, score in blue, "verdict=" / "basis=" / "score=" dropped);
        the date and the word "tier" are not shown; the client column (who made the
        call: today the server's host name) is hidden with FH_TUI_SHOW_CLIENT=false
        FH_TUI_PULL=1 (default 0 = off): the same pull at the start of every rescan,
        quiet unless something changed or failed; one pull at a time per checkout (a lock
        in .git), a second TUI on the same checkout skips its cycle — for a TUI that
        runs unattended from a clone (e.g. in a container)
        FH_TUI_PORT (default 0 = none): GET /status on 0.0.0.0:PORT answers the JSON
        snapshot the last scan built (status ok/degraded, problems, counts, log activity over
        the last hour, the verify model's health), for a dashboard or a monitor; the
        log's "!!" alerts are problems too, one per host and kind, until that kind has
        worked again on that host or FH_TUI_ALERT_HOURS (default 24) passed
Bottom: status bar — the library path; library counts (entries by level,
        retracted), rescanned every STATUS_SECS (default 60; a scan reads every
        meta file, so keep it rare once the library is in the thousands)

The TUI never writes to the library; only (m)ark and (e)rase write the log. Settings and the
library are resolved from the caller's working directory, as the server does
(src/env.ts, src/layout.ts): .env is FH_ENV, else ./.env, else
<library>/.env; the library is FH_EVIDENCE_DIR, else /evidence when it exists,
else ./evidence. The environment wins over the file. Started from a project's
root (`npm run --prefix <this repo> tui`), the TUI shows that project's library.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault("ESCDELAY", "2000")  # arrow keys arrive as escape sequences; a short ESCDELAY splits them under load

from rich.highlighter import Highlighter  # noqa: E402
from rich.style import Style  # noqa: E402
from rich.text import Text  # noqa: E402
from textual import events  # noqa: E402
from textual.app import App, ComposeResult  # noqa: E402
from textual.binding import Binding  # noqa: E402
from textual.containers import Horizontal, Vertical  # noqa: E402
from textual.geometry import Offset  # noqa: E402
from textual.selection import Selection  # noqa: E402
from textual.widgets import Input, Log, Select, Static  # noqa: E402

NULL = getattr(Select, "NULL", getattr(Select, "BLANK", None))  # the "no selection" sentinel

TUI_VERSION = 172   # plain counter: bump on every change to tui/
REPO_ROOT = Path(__file__).resolve().parents[1]   # this checkout: git pull, the TUI's own version and files
CTL_PATH = Path(__file__).resolve()
CWD = Path.cwd()                                   # the caller's project: its .env and its library (run.sh keeps it)
TAIL_LINES = 1000        # how much history is shown at start
POLL_SECS = 2.0          # how often the log file is checked: each new batch scrolls and repaints the whole log pane
                         # (~28 KB of terminal output at 200x60), so lines are gathered, not shown one by one —
                         # over a slow or relayed SSH link, per-line repaints showed as visible drawing (2026-11-13)
DISK_FULL_PCT = 90       # the volume's fill level turns red from here
RESCAN_MIN_SECS = 30     # a rescan triggered by the log at most this often (the timer still runs every STATUS_SECS)
MAX_LINES = 5000         # Log widget scrollback
HELD_MAX_LINES = 50000   # scrolled back or paused, nothing is dropped up to this many


def _dotenv_file(f: Path, key: str) -> str | None:
    """One key from a .env file (KEY=value, quotes and comments allowed)."""
    if not f.is_file():
        return None
    for raw in f.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:]
        k, _, v = line.partition("=")
        if k.strip() != key:
            continue
        v = v.strip()
        if v[:1] in "\"'" and v[-1:] == v[:1]:
            v = v[1:-1]
        else:
            v = re.sub(r"\s+#.*$", "", v)   # an inline comment, as the server drops it (src/env-load.ts)
        return v or None
    return None


def _default_library() -> Path:
    """Without FH_EVIDENCE_DIR: /evidence when it exists (the Docker volume), else ./evidence — as src/layout.ts."""
    return Path("/evidence") if Path("/evidence").is_dir() else CWD / "evidence"


def _env_file() -> Path:
    """The .env the server would load from this working directory — as src/env.ts:
    FH_ENV, else ./.env, else <library>/.env with the library from the environment."""
    named = os.environ.get("FH_ENV", "").strip()
    if named:
        return Path(named).expanduser()
    if (CWD / ".env").is_file():
        return CWD / ".env"
    lib = os.environ.get("FH_EVIDENCE_DIR", "").strip()
    return (Path(lib).expanduser() if lib else _default_library()) / ".env"


ENV_FILE = _env_file()


def _dotenv(key: str) -> str | None:
    """A setting: the environment, then ENV_FILE."""
    return os.environ.get(key) or _dotenv_file(ENV_FILE, key)


FH_EVIDENCE_DIR = Path(_dotenv("FH_EVIDENCE_DIR") or _default_library()).expanduser().resolve()
# <library>/logs/evidence.log since 2026-11-13; before, <library>/evidence.log —
# read from there while a server of an older version still writes it (_poll moves
# over once the new file appears).
LOG_FILE_NEW = FH_EVIDENCE_DIR / "logs" / "evidence.log"
LOG_FILE_OLD = FH_EVIDENCE_DIR / "evidence.log"
LOG_FILE = LOG_FILE_NEW if LOG_FILE_NEW.is_file() or not LOG_FILE_OLD.is_file() else LOG_FILE_OLD
STATUS_SECS = max(5, int(_dotenv("FH_TUI_STATUS_SECS") or 60))
STATUS_PORT = int(_dotenv("FH_TUI_PORT") or 0)       # /status endpoint on 0.0.0.0; 0 = none
PULL = (_dotenv("FH_TUI_PULL") or "").lower() in ("1", "true", "yes", "on")   # git pull at the start of each rescan
# The client column: who made the call (today the server's host name; with a
# shared server, the user). Hidden with FH_TUI_SHOW_CLIENT=false where there is
# only one client and it only takes room.
SHOW_CLIENT = (_dotenv("FH_TUI_SHOW_CLIENT") or "true").strip().lower() not in ("0", "false", "no", "off")
PULL_BUSY = "another TUI is pulling this checkout — skipped"
BIND_RETRY_SECS = 300    # a port that could not be bound is tried again this often
LOG_TAIL_BYTES = 4 << 20  # how much of evidence.log the last-hour counts read
ALERT_HOURS = max(1, float(_dotenv("FH_TUI_ALERT_HOURS") or 24))   # a "!!" alert not seen again, nor cleared, for this long leaves /status
try:
    _pkg = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    PACKAGE_VERSION = _pkg.get("version")
    PLAYWRIGHT_VERSION = (_pkg.get("dependencies") or {}).get("playwright-core")   # exact pin: the ws:// browser servers must run it (#19)
except Exception:
    PACKAGE_VERSION = None
    PLAYWRIGHT_VERSION = None
ERASE_SECS = 3.0         # e twice within this many seconds erases evidence.log

# Colours: one per field, kept apart from each other and from the outcomes.
C_TIME = "#98e024"       # green
# One colour per client, in order of first appearance (several servers may log
# into one library): blue first, then hues clear of the outcome colours.
C_CLIENTS = ("#5fa8ff", "#ff8700", "#00d7af", "#d75fff", "#afd700", "#ff875f", "#87d7ff", "#d7af5f")
C_TOOL = "#56d4dd"       # cyan
C_ID = ("#c397d8", "#ff5fff")   # violet / magenta, alternating per run of one ID
C_TIER = "#fea62b"       # amber: an action refused with an error
C_SOURCE = "#5f87d7"     # steel blue: a source name — pubmed, pmc, unpaywall, crossref, a browser stage
C_OK = "#98e024"         # green
C_FAIL = "#ff5f5f"       # red
C_WARN = "#ffd75f"       # yellow: abstract-only outcomes
C_MUTE = "#6c6c6c"       # dim grey: skipped / exists / non-events
C_URL = "#5fa8ff"

DATE = re.compile(r"^\d{4}-\d\d-\d\d (?=\d\d:\d\d:\d\d )")
LINE = re.compile(r"^(?P<ts>(?:\d{4}-\d\d-\d\d )?\d\d:\d\d:\d\d) (?P<client>\S+) (?P<tool>\S+) +(?P<id>\S+) +(?P<msg>.*)$")
# A line as shown with the client column hidden (FH_TUI_SHOW_CLIENT=false).
LINE_NO_CLIENT = re.compile(r"^(?P<ts>(?:\d{4}-\d\d-\d\d )?\d\d:\d\d:\d\d) (?P<client>)(?P<tool>\S+) +(?P<id>\S+) +(?P<msg>.*)$")
# Columns padded for display: time client tool id word … — tool to 7 ("version"),
# the ID to 13 ("pmid:" + 8 digits, so 7-digit IDs align), the first word of the message (tier name, done, exists) to 9 ("unpaywall").
COLS = re.compile(r"^(\S+ \S+ )(\S+) (\S+) +(\S+)(?: (?=\S)|$)")   # " +": the verify line right-aligns its time after the ID
TOOL_WIDTH, ID_WIDTH, WORD_WIDTH = 7, 13, 18   # word 18: "done", "exists" line up with a verify line's "unverifiable 00.7s" so full_text / abstract share a column
# "tier <name> …" lines are shown without the word "tier" (see LibLog): the
# amber name carries it. So a tier line is <name> followed by a tier outcome.
TIER = re.compile(r"^(?P<name>[a-z][a-z0-9_-]*) +(?P<rest>(?:ok\b|failed\b|skipped\b|located\b|fetched\b|try\b|aborted\b|abandoned\b|redirect\b|pdf link\b|http upgraded\b|https?://|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/|\d+ text-mining).*)$")   # a URL with or without its scheme
TIER_WORD = re.compile(r"^(\S+ \S+ \S+ \S+ +(?:\d+\.\ds +)?)(?:tier |verdict=)(?=\S)")
# A URL in a log line: with its scheme, or — as the server writes them since
# 2026-11-13 — without "https://": a host name with a dot, then a path.
URL = re.compile(r"https?://\S+|(?<![\w@/.:-])(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/\S*")


def href(u: str) -> str:
    """A URL as a link: https:// put back when the log left it out."""
    return u if u.startswith(("http://", "https://")) else "https://" + u
URL_MAX = 40   # on screen a longer URL keeps its first 39 characters and "…": "https://figshare.com/articles/journal_c…"


def short_url(u: str) -> str:
    """A long URL shortened for the screen, still starting as it did (so it is
    still found as a URL) and without spaces; the file keeps it whole."""
    if len(u) <= URL_MAX:
        return u
    return u[:URL_MAX - 1] + "…"
HTTP = re.compile(r"HTTP [45]\d\d(?: [A-Z_]+)?")
LEVEL = re.compile(r"(?<![-\w])(full_text|abstract|title|missing)\b")   # "level=" is dropped on screen; the word is coloured
RETRIEVED = re.compile(r"retrieved_by=\S+")
# Both line formats: the current one, time first, and the earlier one that
# starts with the verdict (lines written before 2026-11-05 stay in the log).
VERDICT = re.compile(r"^(?:(?P<secs>\d+\.\ds) +)?(?:verdict=)?(?P<verdict>pass|fail|na|backed|not_backed|unverifiable|error)\b(?: +(?P<secs2>\d+\.\ds))?")
VERDICT_COLOUR = {"pass": C_OK, "fail": C_FAIL, "na": C_WARN, "backed": C_OK, "not_backed": C_FAIL, "unverifiable": C_WARN}   # old words: lines before 2026-11-05


# First words of a successful message (the colour convention): done, fetched, searched … — green.
OK_WORDS = {"library", "added", "done", "exists", "fetched", "refreshed", "searched", "cached", "articles", "record", "results", "section", "query", "outline", "ok"}


STAGE_STEP = re.compile(r"(?:^| )(ok|failed) +(fetch-proxy \S+|fetch|(?:playwright|chrome|browser) \S+|brightdata|zenrows|zyte)\b")


# The model called the MCP wrongly: a malformed ID, a URL as ID, a claim the
# input checks refuse. "Errors only" shows these; any other failed call is a fail.
MISUSE = re.compile(r"invalid id|type not supported|claim (?:empty|too short|is a fragment|names a source)|compound claim")


def misuse(line: str) -> bool:
    """An error, for "Errors only": a failed call the model got wrong (MISUSE)."""
    return failed_call(line) and bool(MISUSE.search(line))


def hard_fail(line: str) -> bool:
    """A fail, for "Fails": a correct call that failed in the end — a 404, a
    403, a timeout, a service down, a record not in the library — or a claim
    the paper does not back (verify's verdict fail, red like the others)."""
    return (failed_call(line) and not MISUSE.search(line)) or verdict_fail(line)


def verdict_fail(line: str) -> bool:
    """A verification that ran and found the claim not backed: "verdict=fail …"
    ("not_backed" before 2026-11-05). Not unverifiable (amber: only the abstract was read)."""
    m = LINE.match(line)
    if not m or m.group("tool") != "verify":
        return False
    v = VERDICT.match(m.group("msg"))
    return bool(v) and v.group("verdict") in ("fail", "not_backed")


def failed_call(line: str) -> bool:
    """A call that failed in the end ("failed …", "error …"). Not an alert
    ("!!": the deployment itself, "!! Alerts only" shows those), not a failed
    step (one source in the cascade, one stage of a fetch: amber), and not a
    "cached failure" (a stored failure served again, already shown)."""
    m = LINE.match(line)
    if not m:
        return False
    msg, tool = m.group("msg"), m.group("tool")
    if msg.startswith("!! ") or msg.startswith("cached"):
        return False
    if TIER.match(msg) or (tool == "fetch" and STAGE_STEP.search(msg)):
        return False
    # A verification that could not run: "00.0s error claim too short …" ("verdict=error" before 0.2.30) — a refused claim, about the content.
    if tool == "verify" and re.match(r"\d+\.\ds +(?:verdict=)?error\b", msg):
        return True
    return msg.startswith("error") or msg.startswith("failed")


def alert(line: str) -> bool:
    """An alert ("!!"): a service refused the deployment itself (a rejected
    token, a Playwright version mismatch, the verify model failing) or a note
    of the TUI's own. The Alerts only filter shows these."""
    m = LINE.match(line)
    return m.group("msg").startswith("!! ") if m else line.startswith("!!")


class LogHighlighter(Highlighter):
    """Field colours for evidence.log lines; anything else is left alone."""

    def __init__(self) -> None:
        super().__init__()
        # ID -> 0/1, set by LibLog as lines come in: consecutive lines of one ID
        # share a colour, the next ID gets the other one, so one add reads as a block.
        self.parity: dict[str, int] = {}
        self.client_colour: dict[str, str] = {}   # client -> colour, assigned by LibLog
        self.full_url: dict[str, str] = {}      # shortened URL on screen -> the whole one, for the link and the click (LibLog)

    def highlight(self, text) -> None:
        plain = text.plain
        m = (LINE if SHOW_CLIENT else LINE_NO_CLIENT).match(plain)
        if not m:
            if plain.startswith("!!"):
                text.stylize(C_FAIL)
            elif plain.startswith("==== mark "):
                text.stylize(Style(color=C_URL, bold=True))
            return
        text.stylize(C_TIME, m.start("ts"), m.end("ts"))
        text.stylize(self.client_colour.get(m.group("client"), C_CLIENTS[0]), m.start("client"), m.end("client"))
        text.stylize(Style(color=C_TOOL, bold=True), m.start("tool"), m.end("tool"))
        if m.group("id") != "-":
            text.stylize(C_ID[self.parity.get(m.group("id"), 0)], m.start("id"), m.end("id"))
        base = m.start("msg")
        msg = m.group("msg")
        final_fail = False   # red is for outcomes: a call that failed in the end; a failed step (a source, a stage) is amber
        if msg.startswith("!! "):               # an alert: a service refused the deployment itself
            text.stylize(C_FAIL, base, base + len(msg))
            return
        if m.group("tool") == "fetch":         # fetch: grey by default; the outcome words below take their colours over it
            text.stylize(C_MUTE, base, base + len(msg))
        t = TIER.match(msg)
        if t:
            text.stylize(C_SOURCE, base + t.start("name"), base + t.end("name"))
            rest = t.group("rest")
            off = base + t.start("rest")
            if rest.startswith("ok") or rest.endswith(" ok") or re.search(r" ok (fetch-proxy [\w.@-]+|fetch|(?:playwright|chrome|browser) [\w.@-]+|brightdata|zenrows|zyte)$", rest):
                text.stylize(C_OK, off, base + len(msg))
            elif rest.startswith("failed") or " failed" in rest:   # one source or stage failed: a step, amber — the add's outcome is its "done" line
                i = rest.find("failed")
                text.stylize(C_TIER, off + i, base + len(msg))
            elif rest.startswith("skipped") or re.search(r" skipped ((?:fetch-proxy|playwright|chrome|browser) \S+|brightdata|zenrows|zyte):", rest):   # a stage skipped for a host's wall: a non-event, grey
                text.stylize(C_MUTE, off, base + len(msg))
            elif rest.startswith("located") or "text-mining links" in rest:
                text.stylize(C_MUTE, off, base + len(msg))
            elif rest.startswith("fetched"):          # pubmed fetched level=abstract [retracted] [no-abstract] entry=…
                text.stylize(C_MUTE, off, base + len(msg))   # the word green, the level coloured, the rest (doi, pmcid, entry) grey
                text.stylize(C_OK, off, off + len("fetched"))
                lv = LEVEL.search(rest)
                if lv:
                    text.stylize(C_WARN if lv.group(1) == "abstract" else C_FAIL if lv.group(1) == "title" else C_OK, off + lv.start(), off + lv.end())
                for flag in ("retracted", "no-abstract"):
                    i = rest.find(" " + flag + " ")
                    if i >= 0:
                        text.stylize(C_FAIL, off + i + 1, off + i + 1 + len(flag))
                e = rest.find("entry=")
                if e >= 0:
                    text.stylize(C_MUTE, off + e, base + len(msg))
        elif msg.startswith("done"):
            dt = re.match(r"done +(\d+\.\ds)", msg)
            if dt:
                text.stylize(C_MUTE, base + dt.start(1), base + dt.end(1))
            lv = LEVEL.search(msg)
            if lv:
                text.stylize(C_OK if lv.group(1) == "full_text" else C_FAIL if lv.group(1) == "title" else C_WARN, base + lv.start(), base + lv.end())
            rb = RETRIEVED.search(msg)
            if rb:
                text.stylize(C_SOURCE, base + rb.start(), base + rb.end())
        elif VERDICT.match(msg):                       # verify: 2.1s pass basis=… score=… | claim ("verdict=" dropped, like "tier")
            v = VERDICT.match(msg)
            if (pv := re.search(r" (perplexity|google)(?= )", msg.split(" | ")[0] + " ")):   # the provider, grey
                text.stylize(C_MUTE, base + pv.start() + 1, base + pv.end())
            if (c := re.search(r" cached(?= )", msg.split(" | ")[0] + " ")):   # the verdict came from the entry's verify.jsonl, no model call
                text.stylize(C_OK, base + c.start() + 1, base + c.end())
            if v:
                for g in ("secs", "secs2"):
                    if v.group(g):
                        text.stylize(C_MUTE, base + v.start(g), base + v.end(g))
                text.stylize(VERDICT_COLOUR.get(v.group("verdict"), C_FAIL), base + v.start("verdict"), base + v.end("verdict"))
            b = re.search(r"\b(full_text|abstract) +(\d\.\d+)", msg)   # basis, then the score in blue
            if b:
                text.stylize(C_OK if b.group(1) == "full_text" else C_WARN, base + b.start(1), base + b.end(1))
                text.stylize(C_URL, base + b.start(2), base + b.end(2))
            c = msg.find(" | ")
            if c >= 0:
                text.stylize(C_MUTE, base + c, base + len(msg))
        elif msg.startswith("exists") or msg.startswith("missing"):
            text.stylize(C_MUTE, base, base + len(msg))
            if msg.startswith("exists"):          # the entry is there: the word in green, the rest grey
                text.stylize(C_OK, base, base + len("exists"))
            elif "adding first" in msg:          # read/verify "missing adding first": a step, amber
                text.stylize(C_TIER, base, base + len("missing"))
            else:                                 # missing (status): the answer, red
                text.stylize(C_FAIL, base, base + len("missing"))
            lv = LEVEL.search(msg)
            if lv and msg.startswith("exists"):
                text.stylize(C_OK if lv.group(1) == "full_text" else C_FAIL if lv.group(1) == "title" else C_WARN, base + lv.start(), base + lv.end())
        elif m.group("tool") in ("search", "pubmed") and re.match(r"(searched|cached|articles)\b", msg):   # search / batch: the keyword green, not bold, the rest grey — time included
            text.stylize(C_MUTE, base, base + len(msg))
            w = re.match(r"\S+", msg).group(0)
            text.stylize(C_OK, base, base + len(w))
        elif msg.startswith("cached failure"):      # fetch: a stored failure, served again — an outcome, red
            text.stylize(C_FAIL, base, base + len(msg))
            final_fail = True
        elif msg.startswith("cached"):              # fetch: the page came from disk — the cache hit in green, the rest grey
            text.stylize(C_MUTE, base, base + len(msg))
            text.stylize(C_OK, base, base + len("cached"))
        elif m.group("tool") == "fetch" and (o := STAGE_STEP.search(msg)):   # one stage's outcome: a step — failed amber, the fetch's outcome is its last line
            text.stylize(C_OK if o.group(1) == "ok" else C_TIER, base + o.start(1), base + o.end(2))
        elif msg.startswith("error") or msg.startswith("failed"):   # the call's outcome: red
            text.stylize(C_FAIL, base, base + len(msg))
            final_fail = True
        elif m.group("tool") == "fetch" and msg.startswith("shell"):   # fetch: no stage rendered a script shell — served as is, a degraded answer: amber, the rest grey
            text.stylize(C_MUTE, base, base + len(msg))
            text.stylize(C_TIER, base, base + len("shell"))
        elif m.group("tool") == "fetch" and msg.startswith("skipped"):   # fetch: a stage skipped for the host's wall — grey
            text.stylize(C_MUTE, base, base + len(msg))
        elif m.group("tool") == "fetch" and msg.startswith("fetched"):   # fetch: the page was downloaded this time — the word green, the rest grey, as cached
            text.stylize(C_MUTE, base, base + len(msg))
            text.stylize(C_OK, base, base + len("fetched"))
        elif msg.startswith("fetched"):
            lv = LEVEL.search(msg)
            if lv:
                text.stylize(C_WARN if lv.group(1) == "abstract" else C_FAIL if lv.group(1) == "title" else C_OK, base + lv.start(), base + lv.end())
        # One convention for the message's first word: green when the call returned
        # something and the line reports no failure; red / yellow stay with the
        # branches above (errors, failures, abstract-only levels, verdicts).
        first = re.match(r"\S+", msg)
        said = re.sub(r'"[^"]*"|\(missing: [^)]*\)', '""', msg.split(" | ")[0])   # quoted terms, a query's unused terms "(missing: …)" and the claim after " | " are the caller's words, not an outcome
        if first and not re.search(r"\b(error|failed|failure|not found|missing)\b", said) and (
                first.group(0) in OK_WORDS):
            if m.group("tool") in ("read", "trials"):   # read / trial lines: like fetch and search — the rest grey
                text.stylize(C_MUTE, base + first.end(), base + len(msg))
            text.stylize(C_OK, base, base + first.end())
        elif first and first.group(0) in OK_WORDS and re.search(r"\b(error|not found)\b", said):
            # "record error: not a trial ID", 'section "Corrected" not found': the call was refused, not broken —
            # the word amber; on read / trial lines the rest grey
            if m.group("tool") in ("read", "trials"):
                text.stylize(C_MUTE, base + first.end(), base + len(msg))
            text.stylize(C_TIER, base, base + first.end())
        for u in URL.finditer(msg):
            # link= makes it an OSC 8 hyperlink: clickable in terminals that support it
            text.stylize(Style(color=C_URL, bold=False, link=href(self.full_url.get(u.group(0), u.group(0)))), base + u.start(), base + u.end())
        for h in HTTP.finditer(msg):   # red only on an outcome line; in a step amber like the step
            text.stylize(C_FAIL if final_fail else C_TIER, base + h.start(), base + h.end())


class LibLog(Log):
    """The log pane: field colours; the date, the word "tier" and "verdict="
    dropped from each line (display only — the file keeps its bytes)."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._cap = self.max_lines   # the normal scrollback; raised while held (write_lines)
        self.highlighter = LogHighlighter()
        self._last_id = None
        self._parity = 0

    def _display(self, line: str) -> str:
        if not DATE.match(line):              # a mark, pull output, a note: not a log record, shown as written
            return line
        line = TIER_WORD.sub(r"\1", DATE.sub("", line))
        m = COLS.match(line)
        if m:
            ts, client = m.group(1).split()[:2]
            cc = self.highlighter.client_colour
            if client not in cc:
                cc[client] = C_CLIENTS[len(cc) % len(C_CLIENTS)]
            tool, ident, word = m.group(2), m.group(3), m.group(4)
            # A set ID is 36 characters: shown as its first 3 with an ellipsis, so
            # label lines fit the ID column ("dailymed:bcd…" is 13, the column's width).
            full_ident = ident
            if (ident.startswith("dailymed:") or ident.startswith("doi:")) and len(ident) > 13:
                ident = ident[:12] + "…"
            elif len(ident) > ID_WIDTH:          # anything else too wide (a url: ID): cut to the column, scheme and www. dropped
                ident = re.sub(r"^(url:)?(?:https?://)?(?:www\.)?", r"\1", ident)
                ident = ident if len(ident) <= ID_WIDTH else ident[:ID_WIDTH - 1] + "…"
            if full_ident != self._last_id:
                self._parity ^= 1
                self._last_id = full_ident
            self.highlighter.parity[ident] = self._parity
            rest = line[m.end():]
            # A verify line's first word is its time: right-aligned to "13.7s", one space
            # after; "basis=" and "score=" are dropped on screen — the colours carry them.
            # "level=" goes the same way on every line: full_text green, abstract yellow.
            rest = rest.replace("level=", "")
            word = word.replace("level=", "")          # "status … level=missing": the word is the whole message
            if re.fullmatch(r"\d+\.\ds", word):
                # On screen the verdict comes first, then the time: "pass  02.8s full_text 0.999"
                # (the file keeps the time first). 12 + 1 + 5 + 1 = 19, the same column for the basis.
                rest = rest.replace("basis=", "").replace("score=", "", 1).replace("provider=", "", 1)
                vm = re.match(r"(?:verdict=)?(pass|fail|na|error|backed|not_backed|unverifiable) *", rest)
                if vm:
                    col = f"{vm.group(1):<12} {word:>5}"
                    rest = rest[vm.end():]
                else:
                    col = f"{word:>5}"
            elif (tm := re.match(r"(\d+\.\ds):?(?= |$)", rest)):   # "failed 64.6s: …" (fetch) carries a colon
                # "done 08.3s level=…", "searched 00.6s rows=…", "fetched 00.1s html …", "articles 00.6s …":
                # the duration in one column beside the word, the rest keeps its place
                col = f"{word:<12} {tm.group(1):>5}"
                rest = rest[tm.end():].lstrip()
            elif tool in ("startup", "version", "info", "get_version"):
                col = f"{'':<{WORD_WIDTH}} {word}"   # a one-line message, not an action: no word of its own, the text in the details column
            else:
                col = f"{word:<{WORD_WIDTH}}"
            line = f"{m.group(1) if SHOW_CLIENT else ts + ' '}{tool:<{TOOL_WIDTH}} {ident:<{ID_WIDTH}} " + (f"{col} {rest}" if rest else word)
        return line   # URLs whole (2026-11-13): they end the line, the window cuts them off

    def _short(self, m: re.Match) -> str:
        u = m.group(0)
        s = short_url(u)
        if s != u:
            full = self.highlighter.full_url
            if len(full) > HELD_MAX_LINES:   # bounded: the oldest half goes
                for k in list(full)[: len(full) // 2]:
                    del full[k]
            full[s] = u
        return s

    def write_lines(self, lines, *args, **kwargs):
        shown = [self._display(ln) for ln in lines]
        # Scrolled back, the view must hold still. Past max_lines Textual drops
        # the oldest lines but keeps scroll_y, so every new line shifted the
        # text under a fixed position: the view crept on as if it followed.
        # Move scroll_y up by what was dropped, so the same lines stay in view.
        # Near the top of the scrollback that is not enough: the line in view is
        # the one dropped, the view cannot move further up and slides forward.
        # So while held, nothing is dropped (up to HELD_MAX_LINES); following
        # again, the next write trims back to the normal cap.
        held = not self.auto_scroll or self._anchor_released
        y = self.scroll_y
        new = sum(len(ln.splitlines()) for ln in shown)
        if self._cap:
            self.max_lines = min(HELD_MAX_LINES, max(self._cap, len(self._lines) + new)) if held else self._cap
        dropped = max(0, len(self._lines) + new - self.max_lines) if self.max_lines else 0
        super().write_lines(shown, *args, **kwargs)
        if held and dropped:
            self.scroll_to(y=max(0, y - dropped), animate=False, immediate=True)
        # Textual's Log, once max_lines is reached, prunes the oldest lines but
        # repaints neither the visible rows (their content shifted) nor via
        # scroll_end (already at the end, the virtual height unchanged): the pane
        # froze until a mouse move or resize. A full repaint of the visible rows.
        self.refresh()
        return self

    def _row_col(self, event: events.Click) -> tuple[int, int] | None:
        offset = event.get_content_offset(self)
        if offset is None:
            return None
        row = offset.y + int(self.scroll_offset.y)
        col = offset.x + int(self.scroll_offset.x)
        return (row, col) if 0 <= row < len(self.lines) else None

    async def _on_click(self, event: events.Click) -> None:
        """One handler for both (Textual dispatches `_on_click` OR `on_click`
        per class, not both). Single click on a URL opens it (xdg-open / the OS
        browser) — done here, not left to OSC 8: with mouse reporting on, most
        terminals do not act on hyperlinks themselves; a drag (selection) is not
        a click. Double- or triple-click selects the one line under the pointer
        (copied on mouse-up like a drag) instead of Textual's whole widget."""
        if event.button != 1:
            await super()._on_click(event)
            return
        rc = self._row_col(event)
        if event.chain in (2, 3):
            if rc is not None:
                row = rc[0]
                self.screen.selections = {self: Selection.from_offsets(Offset(0, row), Offset(len(self.lines[row]), row))}
            event.prevent_default()   # Widget._on_click (select-all) would still run otherwise: dispatch walks the whole MRO
            event.stop()
            return
        if event.chain == 1 and rc is not None:
            row, col = rc
            for u in URL.finditer(self.lines[row]):
                if u.start() <= col < u.end():
                    self.app.open_url(href(self.highlighter.full_url.get(u.group(0), u.group(0)).rstrip(".,;)")))
                    event.stop()
                    return
        await super()._on_click(event)

    def write_line(self, line, *args, **kwargs):
        return super().write_line(self._display(line), *args, **kwargs)


BUILTIN_TIERS = ["pmc", "europepmc", "tdm", "unpaywall", "openalex", "core"]


def active_tiers() -> list[str]:
    """The source sequence as the server resolves it (src/config.ts): FH_TIERS
    verbatim, else the built-in order plus proxy when its URL is set."""
    listed = _dotenv("FH_TIERS")
    if listed:
        return [t.strip() for t in listed.split(",") if t.strip()]
    return BUILTIN_TIERS + (["proxy"] if _dotenv("FH_PROXY_URL") else [])


# The decision-model providers (src/verify/perplexity.ts, google.ts).
# In the server's order: perplexity last, it takes any URL the others do not claim.
VERIFY_PROVIDERS = {
    "google": {"url": "https://generativelanguage.googleapis.com", "host": "generativelanguage.googleapis.com", "key": ("AIza", "AQ."), "model": "gemini-decision-1", "model_prefix": "gemini-"},
    "openai": {"url": "https://api.openai.com", "host": "api.openai.com", "key": ("sk-",), "model": "gpt-6-luna", "model_prefix": "gpt-"},
    "perplexity": {"url": "https://api.perplexity.ai", "host": "api.perplexity.ai", "key": ("pplx-",), "model": "pplx-decider-flash-v1.2", "model_prefix": "pplx-"},
}


UNLOCK_EVERY = 15 * 60   # a live unlocker check costs a request: at most every 15 minutes per unlocker
_unlock_last: dict = {}   # name -> last result
UNLOCKERS = (("zenrows", "FH_ZENROWS_API_KEY"), ("zyte", "FH_ZYTE_API_KEY"), ("brightdata", "FH_BRIGHTDATA_API_KEY"))   # src/unlock.ts order


def unlocker_order() -> list[str]:
    """The unlockers that take part, as the server resolves them (src/unlock.ts):
    every one with a key."""
    return [n for n, k in UNLOCKERS if _dotenv(k)]


def _unlock_request(name: str):
    """One request for example.com through an unlocker: (urllib request, how to read the body)."""
    import urllib.request, base64
    if name == "zenrows":
        from urllib.parse import quote
        return urllib.request.Request(f"https://api.zenrows.com/v1/?apikey={quote(_dotenv('FH_ZENROWS_API_KEY') or '')}&url={quote('https://example.com/')}&mode=auto", headers={"User-Agent": "evidence-mcp-tui"}), lambda b, h: b
    if name == "zyte":
        auth = base64.b64encode(((_dotenv("FH_ZYTE_API_KEY") or "") + ":").encode()).decode()
        body = json.dumps({"url": "https://example.com/", "httpResponseBody": True}).encode()
        return urllib.request.Request("https://api.zyte.com/v1/extract", data=body, headers={"Authorization": f"Basic {auth}", "Content-Type": "application/json", "User-Agent": "evidence-mcp-tui"}), \
            lambda b, h: base64.b64decode(json.loads(b or b"{}").get("httpResponseBody") or "")
    zone = _dotenv("FH_BRIGHTDATA_ZONE") or "mcp_unlocker"
    body = json.dumps({"zone": zone, "url": "https://example.com/", "format": "raw"}).encode()
    return urllib.request.Request("https://api.brightdata.com/request", data=body, headers={"Authorization": f"Bearer {_dotenv('FH_BRIGHTDATA_API_KEY')}", "Content-Type": "application/json", "User-Agent": "evidence-mcp-tui"}), lambda b, h: b


def check_unlocker(name: str) -> dict:
    """Whether one unlocker answers: one request for example.com, timed, as fh_info
    does (src/unlock.ts) — at most every UNLOCK_EVERY seconds, since each is billed;
    in between the last result stands, with the time it was taken."""
    import urllib.error
    last = _unlock_last.get(name)
    if last and time.time() - last.get("at", 0) < UNLOCK_EVERY:
        return last
    req, read = _unlock_request(name)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            refused = r.headers.get("x-brd-error")   # Bright Data: an IP on the zone's denylist answers 200, empty, the reason in headers
            why = r.headers.get("x-brd-err-msg") or refused
            got = read(raw, r.headers)
        if refused:
            res = {"provider": name, "ok": False, "error": f"refused: {why[:90]}"}
        else:
            ok = b"Example Domain" in got
            res = {"provider": name, "ok": ok, "error": None if ok else f"unexpected answer ({len(got)} bytes)" if got else "empty answer"}
    except urllib.error.HTTPError as e:
        why = e.headers.get("x-brd-err-msg") or ""
        if not why:
            try:
                j = json.loads(e.read() or b"{}"); why = j.get("title") or j.get("detail") or ""
            except Exception:
                why = ""
        res = {"provider": name, "ok": False, "error": f"HTTP {e.code}{': ' + str(why)[:70] if why else ''}"}
    except Exception as e:
        res = {"provider": name, "ok": False, "error": "timeout" if "timed out" in str(e) else str(e)[:60]}
    res.update(secs=time.time() - t0, at=time.time())
    _unlock_last[name] = res
    return res


def own_stages() -> list[tuple[str, str, int]]:
    """Our own stage hosts, as the server reads them (src/fetchproxy.ts, src/browser.ts):
    (name, host, port) — the fetch proxy, the Playwright servers, the Chromes."""
    out = []
    def hp(v: str, port: int) -> tuple[str, int]:
        v = re.sub(r"^[a-z]+://", "", v.strip()).split("/")[0]
        h, _, p = v.rpartition(":") if v.count(":") == 1 else (v, "", "")
        return (h or v), int(p) if p.isdigit() else port
    if (v := _dotenv("FH_FETCH_PROXY")):
        h, p = hp(v, 8888); out.append((f"fetch-proxy {h}", h, p))
    for kind, var, port in (("playwright", "FH_PLAYWRIGHT_", 8932), ("chrome", "FH_CHROME_", 9222)):
        for i in range(1, 10):
            if (v := _dotenv(f"{var}{i}")):
                h, p = hp(v, port); out.append((f"{kind} {h}", h, p))
    return out


def check_stages() -> list[dict]:
    """Whether each of our own stage hosts answers: one TCP connect each (src/hosts.ts),
    free, so on every scan."""
    import socket
    res = []
    for name, host, port in own_stages():
        t0 = time.time()
        try:
            with socket.create_connection((host, port), timeout=3):
                res.append({"name": name, "up": True, "secs": time.time() - t0, "error": None})
        except Exception as e:
            res.append({"name": name, "up": False, "secs": time.time() - t0, "error": "no answer within 3 s" if isinstance(e, socket.timeout) else (getattr(e, "strerror", None) or str(e))[:40]})
    return res


def check_unlockers() -> list[dict]:
    return [check_unlocker(n) for n in unlocker_order()]


def check_verify() -> dict:
    """The decision model behind fh_verify_claim, as FH_VERIFY_* name
    it, and whether it answers: one tiny Decisions API request (a one-line
    state, one yes/no question — a hundred tokens hosted), timed. Runs with
    the library scan, so once a minute."""
    import urllib.request, urllib.error
    # As the server resolves it (src/verify/config.ts): FH_VERIFY_PROVIDER picks a
    # section (FH_VERIFY_<PROVIDER>_MODEL/_URL/_API_KEY, the plain FH_VERIFY_* for
    # what it leaves empty); no switch: the one filled section, else the key's
    # prefix, the URL's host, perplexity. Empty URL and model: the provider's own.
    def field(prov: str, f: str) -> str:
        return (_dotenv(f"FH_VERIFY_{prov.upper()}_{f}") or "") if prov else ""
    name = (_dotenv("FH_VERIFY_PROVIDER") or "").strip().lower()
    if not name:
        filled = [n for n in VERIFY_PROVIDERS if field(n, "URL") or field(n, "API_KEY")]
        if len(filled) > 1:
            return {"configured": True, "provider": name, "model": "?", "host": "?", "ok": False, "secs": 0.0, "error": "set FH_VERIFY_PROVIDER: several sections"}
        name = filled[0] if filled else ""
    key = field(name, "API_KEY") or _dotenv("FH_VERIFY_API_KEY") or ""
    base = re.sub(r"/(v1beta|v1)(/decisions)?$|/decisions$", "", (field(name, "URL") or _dotenv("FH_VERIFY_URL") or "").rstrip("/"))
    if not base and not key:
        return {"configured": False}
    if not name:
        name = next((n for n, p in VERIFY_PROVIDERS.items() if key and key.startswith(p["key"])), "")
    if not name:
        name = next((n for n, p in VERIFY_PROVIDERS.items() if base and re.sub(r"^https?://", "", base).split(":")[0].split("/")[0] == p["host"]), "perplexity")
    prov = VERIFY_PROVIDERS.get(name)
    if not prov:
        return {"configured": True, "provider": name, "model": "?", "host": name, "ok": False, "secs": 0.0, "error": f"unknown provider {name}"}
    base = base or prov["url"]
    model = field(name, "MODEL") or _dotenv("FH_VERIFY_MODEL") or ""
    if not model.startswith(prov["model_prefix"]):
        model = prov["model"]
    host = re.sub(r"^https?://", "", base)
    q = {"q": {"type": "noul", "instructions": "Is the sky blue?"}}
    headers = {"Content-Type": "application/json", "User-Agent": "evidence-mcp-tui"}
    if name == "google":
        body = json.dumps({"model": model, "input": "The sky is blue.", "questions": q}).encode()
        path = "/v1beta/decisions"
        if key:
            headers["x-goog-api-key"] = key
    elif name == "openai":
        body = json.dumps({"model": model, "input": "The sky is blue.", "questions": [{"type": "predicate", "name": "q", "instructions": "Is the sky blue?"}]}).encode()
        path = "/v1/decisions"
    else:
        body = json.dumps({"model": model, "state": "The sky is blue.", "questions": q}).encode()
        path = "/v1/decisions"
    if key and name != "google":
        headers["Authorization"] = f"Bearer {key}"
    t0 = time.time()
    try:
        with urllib.request.urlopen(urllib.request.Request(f"{base}{path}", data=body, headers=headers), timeout=15) as r:
            ok = "answers" in json.loads(r.read().decode("utf-8", "replace"))
        return {"configured": True, "provider": name, "model": model, "host": host, "ok": ok, "secs": time.time() - t0, "error": None if ok else "no answer"}
    except urllib.error.HTTPError as e:
        return {"configured": True, "provider": name, "model": model, "host": host, "ok": False, "secs": time.time() - t0, "error": f"HTTP {e.code}"}
    except Exception as e:
        return {"configured": True, "provider": name, "model": model, "host": host, "ok": False, "secs": time.time() - t0, "error": "timeout" if "timed out" in str(e) else str(e)[:60]}


def human(n: int) -> str:
    """1.9 GB, 312.4 MB, 48.0 KB — decimal units, as a disk or a file manager states them."""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1000 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1000
    return f"{n:.1f} TB"


STAMP = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (\S+) (\S+) +(\S+) +(.*)$")


class Alerts:
    """The log's "!!" alerts as /status problems (#44): one per host and kind,
    with its newest message verbatim, a count and the last time. An alert
    clears when the same kind has worked since on that host (the stage's "ok",
    a verify with a verdict, a restart without it), or after ALERT_HOURS
    without a repeat. Fed every log line, from the start-up read and each poll."""

    STAGE = re.compile(r"^((?:fetch-proxy|playwright|chrome|browser) \S+|brightdata|zenrows|zyte): ")
    OK = re.compile(r"(?:^| )ok ((?:fetch-proxy|playwright|chrome|browser) \S+|brightdata|zenrows|zyte)\b")
    VERIFY_ERR = re.compile(r"^\d+\.\d+s (?:verdict=)?error +(.*?)(?: \| .*)?$")   # "error …" since 0.2.30, "verdict=error …" before

    def __init__(self) -> None:
        self.open: dict[tuple[str, str], dict] = {}   # (host, kind) → {message, count, first, last}

    @classmethod
    def kind(cls, tool: str, msg: str) -> tuple[str, str]:
        """The alert's kind (what clears it) and its message without what varies per call."""
        if tool == "verify":
            v = cls.VERIFY_ERR.match(msg)
            return "verify", f"verify model: {v.group(1) if v else msg}"
        r = cls.STAGE.match(msg)
        if r:
            return r.group(1).replace("browser ", "playwright ", 1), msg
        return f"{tool}:{msg}", msg

    def feed(self, line: str) -> None:
        m = STAMP.match(line)
        if not m:
            return
        host, tool, msg = m.group(2), m.group(3), m.group(5)
        if msg.startswith("!! "):
            try:
                ts = time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))
            except ValueError:
                return
            kind, text = self.kind(tool, msg[3:])
            a = self.open.setdefault((host, kind), {"message": text, "count": 0, "first": ts, "last": ts})
            a.update(message=text, last=ts); a["count"] += 1
            return
        if not self.open:
            return
        if tool == "startup":   # a restart: what it does not say again is fixed
            for k in [k for k in self.open if k[0] == host and k[1].startswith("startup:")]:
                del self.open[k]
            return
        cleared = None
        if tool == "verify" and " verdict=" in msg and " verdict=error" not in msg:
            cleared = "verify"
        else:
            o = self.OK.search(msg)
            if o:
                cleared = o.group(1).replace("browser ", "playwright ", 1)
        if cleared:
            self.open.pop((host, cleared), None)

    def problems(self, now: float) -> list[str]:
        for k in [k for k, a in self.open.items() if now - a["last"] > ALERT_HOURS * 3600]:
            del self.open[k]
        out = []
        for (host, _), a in sorted(self.open.items(), key=lambda kv: -kv[1]["last"]):
            n = f" ×{a['count']}" if a["count"] > 1 else ""
            out.append(f"{host}: !! {a['message']} ({time.strftime('%Y-%m-%d %H:%M', time.localtime(a['last']))}{n})")
        return out


def log_stats(now: float) -> dict:
    """evidence.log for /status: when the last line was written, and over the
    last hour the adds that ran a cascade (done), the adds that ended in an
    error line, the verify calls, and the "!!" alerts. Reads the file's tail only."""
    out = {"last_line_at": None, "age_secs": None, "adds": 0, "failed": 0, "verify": 0, "fetches": 0, "cached": 0, "alerts": 0}
    if not LOG_FILE.is_file():
        return out
    try:
        size = LOG_FILE.stat().st_size
        with LOG_FILE.open("rb") as f:
            f.seek(max(0, size - LOG_TAIL_BYTES))
            tail = f.read().decode("utf-8", errors="replace")
    except OSError:
        return out
    since = now - 3600
    for line in tail.splitlines():
        m = STAMP.match(line)
        if not m:
            continue
        try:
            ts = time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))
        except ValueError:
            continue
        out["last_line_at"] = int(ts)
        tool, msg = m.group(3), m.group(5)
        if ts < since:
            continue
        if msg.startswith("!! "):
            out["alerts"] += 1
        if tool == "add" and msg.startswith("done"):
            out["adds"] += 1
        elif tool == "add" and msg.startswith("error"):
            out["failed"] += 1
        elif tool == "verify":
            out["verify"] += 1
        elif tool == "fetch" and (msg.startswith("fetched") or msg.startswith("cached") or msg.startswith("failed")):
            out["fetches"] += 1                   # one line per fh_fetch_url call; the stage lines are not counted
            out["cached"] += msg.startswith("cached")
    if out["last_line_at"] is not None:
        out["age_secs"] = max(0, int(now - out["last_line_at"]))
    return out


class _StatusHandler(BaseHTTPRequestHandler):
    """GET /status (or /): the JSON snapshot the scan last built. The scan
    swaps the snapshot in as one bytes object; this thread only reads it."""
    app: "Ctl | None" = None

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] not in ("/", "/status"):
            self.send_error(404)
            return
        body = getattr(self.app, "_status_json", b"{}")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")   # a dashboard reading /status is usually a page on another origin
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:
        pass   # stderr is the TUI's terminal


def scan_library(lib: Path) -> dict:
    """Entry counts from the meta files: <type>/<L1>/<L2>/<n>/<type>-<n>-meta.md.
    Reads every meta file, so it is called on a timer, not per log line."""
    out = {"entries": 0, "by_level": {}, "by_type": {}, "retracted": 0, "no_abstract": 0, "types": {}, "bytes": 0}
    if not lib.is_dir():
        return out
    for typ in (d for d in lib.iterdir() if d.is_dir()):
        for l1 in (d for d in typ.iterdir() if d.is_dir()):
            for l2 in (d for d in l1.iterdir() if d.is_dir()):
                for ent in (d for d in l2.iterdir() if d.is_dir()):
                    meta = ent / f"{typ.name}-{ent.name}-meta.md"
                    if not meta.is_file():
                        continue
                    try:
                        # The whole frontmatter: a long coi or funding line can push
                        # level: past any fixed byte count (67 entries past 4000).
                        text = meta.read_text(encoding="utf-8", errors="replace")
                        end = text.find("\n---", 4)
                        head = text[: end if end > 0 else len(text)]
                    except OSError:
                        continue
                    lv = re.search(r"^level: (\S+)", head, re.M)
                    level = lv.group(1) if lv else "unknown"
                    out["entries"] += 1
                    out["by_level"][level] = out["by_level"].get(level, 0) + 1
                    out["by_type"][typ.name] = out["by_type"].get(typ.name, 0) + 1
                    t = out["types"].setdefault(typ.name, {"entries": 0, "full_text": 0, "abstract": 0, "no_abstract": 0, "retracted": 0, "bytes": 0})
                    t["entries"] += 1
                    try:                                   # the entry's files on disk (0.1 s for 28,000 files)
                        size = sum(f.lstat().st_size for f in ent.iterdir() if f.is_file())
                    except OSError:
                        size = 0
                    t["bytes"] += size
                    out["bytes"] += size
                    if level in ("full_text", "abstract"):
                        t[level] += 1
                    retracted = bool(re.search(r"^retracted: (yes|true)", head, re.M))
                    no_abstract = bool(re.search(r"^has_abstract: (no|false)", head, re.M))   # absent = has one
                    out["retracted"] += retracted
                    out["no_abstract"] += no_abstract
                    t["retracted"] += retracted
                    t["no_abstract"] += no_abstract
    # verify/<2>/<4>/<key>.json: one file per cached verdict (fh_verify_claim)
    vdir = lib / "verify"
    out["verdicts"] = sum(1 for _ in vdir.glob("*/*/*.json")) if vdir.is_dir() else 0
    # search/<2>/<4>/<key>.json: one file per cached registry search (fh_clinicaltrials_search_studies)
    sdir = lib / "search"
    out["searches"] = sum(1 for _ in sdir.glob("*/*/*.json")) if sdir.is_dir() else 0
    out["servers"] = read_servers(lib)
    return out


def read_servers(lib: Path, stale_secs: int = 20 * 60) -> list[dict]:
    """The servers alive on this library: <library>/.servers/<host>-<pid>.json, one per
    process, rewritten on every cache hit or miss and every 5 min as a heartbeat,
    removed on exit (src/stats.ts). A file older than stale_secs is a server that is
    gone; servers delete those when they start, the TUI only skips them (read-only)."""
    out: list[dict] = []
    d = lib / ".servers"
    if not d.is_dir():
        return out
    for f in d.glob("*.json"):
        try:
            if time.time() - f.stat().st_mtime > stale_secs:
                continue
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
    return out


def _local_hhmm(iso: str) -> str:
    """An ISO-8601 UTC time (src/stats.ts writes new Date().toISOString()) as local HH:MM."""
    try:
        from datetime import datetime, timezone
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%H:%M")
    except ValueError:
        return "?"


class FilterClear(Static):
    """The ✕ after the filter field: a click clears the filter."""

    def on_click(self, event: events.Click) -> None:
        event.stop()
        self.app.action_filter_clear()


class FailsToggle(Static):
    """"Fails only" after the filter: a click shows only the hard failures (red outcomes), again all."""

    def on_click(self, event: events.Click) -> None:
        event.stop()
        self.app.action_fails_toggle()


class ErrorsToggle(Static):
    """"Errors only": a click shows only the calls the model got wrong, again all."""

    def on_click(self, event: events.Click) -> None:
        event.stop()
        self.app.action_errors_toggle()


class AlertsToggle(Static):
    """"Alerts only": a click shows only the "!!" alerts, again all."""

    def on_click(self, event: events.Click) -> None:
        event.stop()
        self.app.action_alerts_toggle()


class Ctl(App):
    CSS = """
    Screen  { background: ansi_default; }
    #nav    { height: 1; background: transparent; padding: 0; }
    #nav-spacer { width: 1fr; }
    #log-select   { width: 7;  height: 1; margin: 0 1 0 1; }
    #admin-select { width: 9;  height: 1; margin: 0 1 0 1; }
    #log-select > SelectCurrent, #admin-select > SelectCurrent {
        height: 1; border: none; padding: 0 1; background: transparent;
    }
    #log-select #label, #admin-select #label { text-style: bold; color: $text; }
    #log-select:focus > SelectCurrent, #admin-select:focus > SelectCurrent {
        background: $accent; color: black; text-style: bold;
    }
    #log-select:focus #label, #log-select:focus .arrow,
    #admin-select:focus #label, #admin-select:focus .arrow { color: black; }
    /* longest entry + 2 border + 2 padding + slack, else entries wrap */
    #log-select SelectOverlay, #admin-select SelectOverlay { width: 16; }
    #filter { width: 19; height: 1; border: none; padding: 0 1; margin: 0 0 0 1; background: $boost; }
    #filter:focus { background: $accent 30%; }
    #filter-clear { width: 3; height: 1; content-align: center middle; color: #6c6c6c; }
    #filter-clear:hover { color: $text; text-style: bold; }
    #errors { width: auto; height: 1; padding: 0 1; margin: 0; color: #6c6c6c; }
    #errors:hover { color: $text; }
    #errors.on { background: #ff5f5f; color: black; text-style: bold; }
    #fails { width: auto; height: 1; padding: 0 1; margin: 0; color: #6c6c6c; }
    #fails:hover { color: $text; }
    #fails.on { background: #ff5f5f; color: black; text-style: bold; }
    #alerts { width: auto; height: 1; padding: 0 1; margin: 0; color: #6c6c6c; }
    #alerts:hover { color: $text; }
    #alerts.on { background: #ff5f5f; color: black; text-style: bold; }
    #host   { width: auto; height: 1; padding: 0 1; margin-right: 1; background: #5fa8ff; color: black; text-style: bold; }
    #output {
        height: 1fr;
        background: transparent;
        border: solid $primary;
        overflow-x: hidden;
        scrollbar-background: transparent;
        scrollbar-color: $primary;
        scrollbar-size: 1 1;
    }
    #status-bar { height: 14; background: transparent; }
    #status-divider { width: 1fr; height: 1; padding: 0 1; color: #4e4e4e; background: transparent; text-wrap: nowrap; text-overflow: clip; }
    #status-row-1, #status-row-verify, #status-row-unlocker, #status-row-proxy, #status-row-playwright, #status-row-chrome, #status-row-2, #status-row-3, #status-row-doi, #status-row-4, #status-row-5, #status-row-url, #status-row-verdicts, #status-row-search { height: 1; background: transparent; }
    #row-verify, #row-unlock, #row-proxy, #row-playwright, #row-chrome { width: 1fr; height: 1; padding: 0 1; background: transparent; text-wrap: nowrap; text-overflow: ellipsis; }
    #row-doi { width: 1fr; height: 1; padding: 0 1; background: transparent; text-wrap: nowrap; text-overflow: ellipsis; }
    #row-pmid, #row-dailymed { width: 1fr; height: 1; padding: 0 1; background: transparent; text-wrap: nowrap; text-overflow: ellipsis; }
    #row-nct, #row-url, #row-verdicts, #row-search { width: 1fr; height: 1; padding: 0 1; background: transparent; text-wrap: nowrap; text-overflow: ellipsis; }
    #status  { width: 1fr;  height: 1; padding: 0 1; background: transparent; text-wrap: nowrap; text-overflow: ellipsis; }
    #status.alert { color: #ff5f5f; }
    #status.idle  { color: #6c6c6c; }
    #scan    { width: auto; height: 1; padding: 0 2 0 0; color: #6c6c6c; background: transparent; text-wrap: nowrap; }
    #endpoint { width: auto; height: 1; padding: 0; color: #6c6c6c; background: transparent; text-wrap: nowrap; }
    #endpoint.alert { color: #ff5f5f; }
    #row2-spacer { width: 1fr; height: 1; background: transparent; }
    #ver     { width: auto; height: 1; padding: 0 1 0 0; color: #5fa8ff; background: transparent; text-wrap: nowrap; }
    .sep     { width: auto; height: 1; color: #6c6c6c; background: transparent; text-wrap: nowrap; }
    #sep-endpoint { display: none; }
    #mcps    { width: auto; height: 1; padding: 0; color: #6c6c6c; background: transparent; text-wrap: nowrap; }
    """

    BINDINGS = [
        Binding("left", "nav(-1)", "prev menu", priority=True, show=False),
        Binding("right", "nav(1)", "next menu", priority=True, show=False),
        Binding("space", "pause", "pause/follow", priority=True),
        Binding("b", "log_bottom", "bottom", priority=True),
        Binding("end", "log_bottom", "bottom", priority=True, show=False),
        Binding("t", "log_top", "top", priority=True),
        Binding("home", "log_top", "top", priority=True, show=False),
        Binding("pageup", "log_page(-1)", "page up", priority=True, show=False),
        Binding("pagedown", "log_page(1)", "page down", priority=True, show=False),
        Binding("c", "clear", "clear", priority=True),
        Binding("m", "mark", "mark", priority=True),      # a marker line into evidence.log, to find a test run later
        Binding("e", "erase", "erase", priority=True),    # truncate evidence.log (press twice)
        Binding("r", "refresh", "refresh", priority=True, show=False),  # rescan now; no menu entry, the timer covers it
        Binding("u", "update", "update", priority=True),
        Binding("q", "quit", "quit", priority=True),
        Binding("ctrl+c", "copy", "copy", priority=True, show=False),   # copy the selection (auto-copied on mouse-up anyway)
        Binding("slash", "filter_focus", "filter", priority=True),     # / : into the filter field
        Binding("f", "filter_focus", "filter", priority=True, show=False),
        Binding("escape", "filter_clear", "clear filter", show=False),
        Binding("question_mark", "errors_toggle", "errors only", priority=True),    # ? : only the calls the model got wrong
        Binding("exclamation_mark", "fails_toggle", "fails only", priority=True),   # ! : only the hard failures
        Binding("a", "alerts_toggle", "alerts only", priority=True),                # a : only the "!!" alerts
    ]

    # While the filter field has focus, the one-key commands are typing.
    TYPING_OFF = {"nav", "pause", "log_bottom", "log_top", "clear", "mark", "erase", "refresh", "update", "quit", "filter_focus", "fails_toggle", "alerts_toggle", "errors_toggle"}

    def check_action(self, action: str, parameters: tuple) -> bool | None:
        if action in self.TYPING_OFF and isinstance(self.focused, Input):
            return False
        return True

    def __init__(self) -> None:
        super().__init__(ansi_color=True)
        self._pos = 0            # bytes of the log consumed
        self._lines = 0          # lines shown since start
        self._last_ts = ""       # timestamp of the last log line
        self._scanning = False
        self._last_scan_start = 0.0   # when the last scan began (log-triggered rescans wait RESCAN_MIN_SECS)
        self._lib_size = ""          # the library's size, shown on the storage row
        self._disk: tuple[int, int] | None = None   # the volume's fill level (percent, total bytes), shown there too
        self._status_note = ""       # a note shown on the location row instead of the path
        self._updating = False
        self._paused = False     # Space: hold the view even when it is at the end
        self._erase_armed = 0.0  # e pressed once: the second press within ERASE_SECS erases
        self.restart = False     # set when the TUI's own files changed (restart in __main__)
        self._loaded_hash = self._self_hash()   # tui/ as this process loaded it
        self._last_scan: dict | None = None     # the last scan's result, for /status
        self._alerts = Alerts()                 # the log's "!!" lines, for /status problems
        self._status_json = b'{"status":"degraded","problems":["no scan yet"]}'
        self._status_server: ThreadingHTTPServer | None = None
        self._status_err: str | None = None
        self._pull: dict = {"enabled": PULL, "last_at": None, "result": None}   # for /status: unchanged | changed | failed | skipped
        self._raw: deque[str] = deque(maxlen=HELD_MAX_LINES)   # every line read, as in the file: what the filter searches
        self._filter = ""        # the filter field, lower-cased; "" = every line
        self._matches = 0        # lines shown under the filter
        self._errors = False     # the Errors only toggle: only the calls the model got wrong
        self._fails = False      # the Fails only toggle: only correct calls that failed
        self._alerts_only = False  # the !! Alerts only toggle: only "!!" lines; takes turns with Fails only

    def compose(self) -> ComposeResult:
        with Horizontal(id="nav"):
            yield Select([("(b)ottom", "log_bottom"), ("(t)op", "log_top"), ("(c)lear", "clear"), ("(m)ark", "mark"), ("(e)rase", "erase")],
                         id="log-select", prompt="Log", allow_blank=True)
            yield Select([("(u)pdate", "update"), ("(q)uit", "quit")],
                         id="admin-select", prompt="Admin", allow_blank=True)
            yield Input(placeholder="Filter", id="filter")
            yield FilterClear("✕", id="filter-clear")
            yield FailsToggle("Fails", id="fails")
            yield ErrorsToggle("Errors", id="errors")
            yield AlertsToggle("Alerts", id="alerts")
            yield Static(id="nav-spacer")
            yield Static(socket.gethostname().split(".")[0], id="host")
        yield LibLog(id="output", highlight=True, max_lines=MAX_LINES, auto_scroll=True)
        with Vertical(id="status-bar"):
            with Horizontal(id="status-row-fh_verify_claim"):   # the decision model behind fh_verify_claim, and whether it answers
                yield Static("decider  …", id="row-verify")
                # The TUI's own status, at the right end of the first line under the log:
                # the /status port, how many MCP servers run on this library, the
                # countdown — light grey — and the TUI's version in blue.
                yield Static("", id="endpoint")
                yield Static("  ·  ", id="sep-endpoint", classes="sep")   # shown with the port
                yield Static("", id="mcps")
                yield Static("  ·  ", classes="sep")
                yield Static("", id="scan")
                yield Static(f"v{TUI_VERSION}", id="ver")
            with Horizontal(id="status-row-proxy"):   # our own stage hosts, one line per kind, and whether each answers
                yield Static("proxy     …", id="row-proxy")
            with Horizontal(id="status-row-playwright"):
                yield Static("playwright …", id="row-playwright")
            with Horizontal(id="status-row-chrome"):
                yield Static("chrome    …", id="row-chrome")
            with Horizontal(id="status-row-unlocker"):   # stage 3, after the three own-stage lines: the unlockers, and whether each answers
                yield Static("unlocker …", id="row-unlock")
            with Horizontal(id="status-row-1"):   # where the library is and its size — with the health lines, above the divider
                yield Static(f"location {FH_EVIDENCE_DIR}", id="status")
            # A divider: the health lines and storage above, the library's counts below.
            yield Static("─" * 500, id="status-divider")
            with Horizontal(id="status-row-3"):   # one row per entry type
                yield Static("", id="row-pmid")
            with Horizontal(id="status-row-doi"):
                yield Static("", id="row-doi")
            with Horizontal(id="status-row-4"):
                yield Static("", id="row-nct")
            with Horizontal(id="status-row-5"):
                yield Static("", id="row-dailymed")
            with Horizontal(id="status-row-url"):
                yield Static("", id="row-url")
            with Horizontal(id="status-row-verdicts"):
                yield Static("", id="row-verdicts")
            with Horizontal(id="status-row-search"):   # … version in the lower right corner
                yield Static("", id="row-search")

    def on_mount(self) -> None:
        self.title = "evidence-mcp"
        self.query_one("#log-select", Select).focus()
        self._load_tail()
        self._log().anchor()   # pinned to the end through new lines, a resize (tmux attach) and a scrollbar appearing — until the user scrolls up
        self.set_interval(POLL_SECS, self._poll)
        self._next_scan = time.monotonic() + STATUS_SECS
        self.set_interval(1.0, self._tick)
        self.set_interval(10.0, self._check_self)   # a changed tui/ restarts the TUI
        self._start_scan()
        if STATUS_PORT:
            self._start_status_server()
            self.set_interval(BIND_RETRY_SECS, self._start_status_server)

    # ---- log following ---------------------------------------------------

    def _log(self) -> Log:
        return self.query_one("#output", Log)

    def _set_status(self, note: str = "", alert: bool = False) -> None:
        """The storage row (above the counts): the library's size and where it is (the full path is in
        fh_info), replaced by a note while the view is not following the log
        (grey) or something is off (red) — the row's right side holds the counts."""
        w = self.query_one("#status", Static)
        self._status_note = note
        if note:
            w.update(note)
        else:
            # "storage    <path> 23.4 MB": labelled like the health lines above it, the
            # size after the path in dark grey, like their milliseconds.
            t = Text(); t.append(f"{'storage':<10} ", style=C_TOOL)
            t.append(str(FH_EVIDENCE_DIR))
            if self._lib_size:
                num, _, unit = self._lib_size.partition(" ")
                t.append(f" {num}", style=C_OK).append(f" {unit}", style=C_MUTE)
            if self._disk:
                # The volume the library is on: how full, green — red from DISK_FULL_PCT on.
                pct, total = self._disk
                t.append(" · disk ", style=C_MUTE).append(f"{pct}%", style=C_FAIL if pct >= DISK_FULL_PCT else C_OK).append(f" of {human(total)}", style=C_MUTE)
            w.update(t)
        w.set_class(bool(note) and alert, "alert")
        w.set_class(bool(note) and not alert, "idle")

    def _refresh_follow(self) -> None:
        """Status note from the follow state: paused (Space), scrolled back (mouse/PageUp
        released the anchor; scrolling to the end restores it), or following."""
        if not LOG_FILE.is_file():
            return
        if self._filtering():
            kinds = "errors" if self._errors else "fails" if self._fails else "alerts" if self._alerts_only else ""
            what = " and ".join(([f"“{self._filter}”"] if self._filter else []) + ([kinds] if kinds else []))
            self._set_status(f"filter {what} — {self._matches} of {len(self._raw)} lines" + (", paused" if self._paused else ", scrolled back" if not self._following() else ""))
        elif self._paused:
            self._set_status("paused — Space or b to follow")
        elif not self._following():
            self._set_status("scrolled back — Space or b to follow")
        else:
            self._set_status()

    def _load_tail(self) -> None:
        if not LOG_FILE.is_file():
            self._set_status("no evidence.log yet, waiting", alert=True)
            return
        data = LOG_FILE.read_bytes()
        self._pos = len(data)
        lines = data.decode("utf-8", errors="replace").splitlines()
        for ln in lines:
            self._alerts.feed(ln)
        self._raw.extend(lines[-HELD_MAX_LINES:])
        shown = lines[-TAIL_LINES:]
        if shown:
            self._log().write_lines(shown)
            self._lines += len(shown)
            self._last_ts = shown[-1][:19]
        self._set_status()

    def _poll(self) -> None:
        global LOG_FILE
        if LOG_FILE == LOG_FILE_OLD and LOG_FILE_NEW.is_file():   # a newer server moved the log into logs/
            LOG_FILE = LOG_FILE_NEW
            self._pos = 0
        if not LOG_FILE.is_file():
            return
        try:
            size = LOG_FILE.stat().st_size
        except OSError:
            return
        if size < self._pos:            # truncated or rotated: start over
            self._pos = 0
            self._log().write_line("!! evidence.log was truncated — reading from the start")
            self._set_status()
        if size == self._pos:
            return
        with LOG_FILE.open("rb") as f:
            f.seek(self._pos)
            chunk = f.read(size - self._pos)
        # keep a partial trailing line for the next poll
        nl = chunk.rfind(b"\n")
        if nl < 0:
            return
        self._pos += nl + 1
        lines = chunk[: nl].decode("utf-8", errors="replace").splitlines()
        if not lines:
            return
        for ln in lines:
            self._alerts.feed(ln)
        self._raw.extend(lines)
        shown = [ln for ln in lines if self._match(ln)]
        self._matches += len(shown) if self._filtering() else 0
        if shown:
            self._log().write_lines(shown)
        if self._following():
            self._log().scroll_end(animate=False, immediate=True)
        self._lines += len(lines)
        self._last_ts = lines[-1][:19]
        # An add that finished changes the counts: rescan soon — but at most every
        # RESCAN_MIN_SECS: on a busy library a "done" or "fetched" line comes every
        # second, and each rescan reads every meta file and asks the decider (#67).
        if any(" done level=" in ln or " fetched " in ln for ln in lines) and time.monotonic() - self._last_scan_start >= RESCAN_MIN_SECS:
            self.set_timer(2.0, self._start_scan)

    # ---- library counts --------------------------------------------------

    def _tick(self) -> None:
        """Once a second: the countdown, and the rescan when it reaches zero."""
        self._refresh_follow()
        left = int(round(self._next_scan - time.monotonic()))
        if left <= 0 and not self._scanning:
            self._start_scan()
            left = STATUS_SECS
        # The countdown in steps of 5 s: each change repaints the status line.
        self.query_one("#scan", Static).update(
            "scanning…" if self._scanning else f"rescan in {max(5 * ((left + 4) // 5), 0)}s")

    def _start_scan(self) -> None:
        if self._scanning:
            return
        self._next_scan = time.monotonic() + STATUS_SECS
        self._last_scan_start = time.monotonic()
        self._scanning = True
        self.run_worker(self._scan, thread=True, exclusive=True, group="scan")

    def _scan(self) -> None:
        if PULL and not self._updating:
            self._pull_in_cycle()
        t0 = time.time()
        try:
            res = scan_library(FH_EVIDENCE_DIR)
        except Exception as e:  # pragma: no cover
            res = {"error": str(e)}
        res["took"] = time.time() - t0
        try:   # the volume the library is on: one statvfs, free
            du = shutil.disk_usage(FH_EVIDENCE_DIR)
            res["disk"] = {"pct": round(100 * du.used / du.total) if du.total else 0, "total": du.total, "free": du.free}
        except OSError:
            res["disk"] = None
        try:
            res["verify"] = check_verify()
        except Exception as e:  # pragma: no cover
            res["verify"] = {"configured": True, "ok": False, "error": str(e)[:60]}
        try:
            res["unlockers"] = check_unlockers()
        except Exception as e:  # pragma: no cover
            res["unlockers"] = [{"provider": "?", "ok": False, "error": str(e)[:60]}]
        try:
            res["stages"] = check_stages()
        except Exception as e:  # pragma: no cover
            res["stages"] = [{"name": "?", "up": False, "error": str(e)[:60]}]
        res["log"] = log_stats(time.time())
        self.call_from_thread(self._show_scan, res)

    def _show_scan(self, res: dict) -> None:
        self._scanning = False
        self._last_scan = res
        self._publish_status()
        if "error" in res:
            self._set_status(f"scan failed: {res['error']}", alert=True)
            return
        vr = res.get("verify") or {}
        w = Text(); w.append(f"{'decider':<10} ", style=C_TOOL)
        if not vr.get("configured"):
            w.append("not configured", style=C_MUTE)
            if vr.get("error"):
                w.append(f" · {vr['error']}", style=C_FAIL)
        else:
            # "perplexity healthy 258 ms": the provider, its state, the time (the model is in fh_info).
            w.append(vr.get("provider") or "?").append(" ")
            if vr.get("ok"):
                w.append("up", style=C_OK)
            else:
                w.append(vr.get("error") or "down", style=C_FAIL)
            if vr.get("secs") is not None:
                w.append(f" {vr['secs'] * 1000:.0f} ms", style=C_MUTE)
        self.query_one("#row-verify", Static).update(w)
        # The unlocker below the decider: the live check (at most every 15 minutes, it
        # costs a request) — and an open alert from the log wins, e.g. an HTTP 407 when
        # a download hit an IP Bright Data does not allow.
        urs = res.get("unlockers") or []
        # A live check that worked clears an older alert of that unlocker: the
        # refusal (an IP not allowed, a used-up quota) was fixed since (2026-11-13:
        # a cleared denylist still showed the morning's 407 for hours).
        for ur in urs:
            if ur.get("ok") and ur.get("at"):
                for key in [k for k, a in self._alerts.open.items() if k[1] == ur.get("provider") and a["last"] < ur["at"]]:
                    self._alerts.open.pop(key, None)
        u = Text(); u.append(f"{'unlocker':<10} ", style=C_TOOL)
        if not urs:
            u.append("not configured", style=C_MUTE)
        for i, ur in enumerate(urs):
            if i:
                u.append("  ·  ", style=C_MUTE)
            name = ur.get("provider", "?")
            u.append(name).append(" ")
            alert = next((a for (h, k), a in self._alerts.open.items() if k == name), None)
            if alert:
                u.append(alert["message"].replace(f"{name}: ", "", 1)[:60], style=C_FAIL)
            elif ur.get("ok"):
                u.append("up", style=C_OK)
            else:
                u.append((ur.get("error") or "down")[:60], style=C_FAIL)
            if ur.get("secs") is not None:
                u.append(f" {ur['secs'] * 1000:.0f} ms", style=C_MUTE)
        self.query_one("#row-unlock", Static).update(u)
        # Our own stage hosts below, one line per kind: up or down, checked on every scan (free).
        sts = res.get("stages") or []
        for kind, label, row in (("fetch-proxy", "proxy", "#row-proxy"), ("playwright", "playwright", "#row-playwright"), ("chrome", "chrome", "#row-chrome")):
            g = Text(); g.append(f"{label:<10} ", style=C_TOOL)
            mine = [st for st in sts if st.get("name", "").startswith(kind + " ")]
            if not mine:
                g.append("not configured", style=C_MUTE)
            for i, st in enumerate(mine):
                if i:
                    g.append("  ·  ", style=C_MUTE)
                g.append(st["name"][len(kind) + 1:]).append(" ")
                if st.get("up"):
                    g.append("up", style=C_OK)
                else:
                    g.append((st.get("error") or "down")[:40], style=C_FAIL)
                if st.get("secs") is not None:
                    g.append(f" {st['secs'] * 1000:.0f} ms", style=C_MUTE)
            self.query_one(row, Static).update(g)
        # One grid for every row below the decider line, no separators: label (9),
        # count (5, blue), unit (14), then segments of a 5-wide number and a word
        # padded to 10 — so abstracts, hits, the size all start in the same column.
        BLUE = Style(color=C_URL, bold=True)
        def row(label: str, count: int, unit: str) -> Text:
            r = Text(); r.append(f"{label:<9}", style=C_TOOL); r.append(str(count).rjust(5), style=BLUE); r.append(f" {unit:<14}")
            return r
        def seg(r: Text, n: object, word: str, style: object = None) -> Text:
            r.append("  ").append(str(n).rjust(5), style=style if word != "" else BLUE).append(f" {word:<10}", style=style)
            return r
        types = res.get("types", {})
        # The size on the location row (no total line: the rows below count per type).
        self._lib_size = human(res.get("bytes", 0))
        d = res.get("disk")
        self._disk = (d["pct"], d["total"]) if d else None
        if not self._status_note:
            self._set_status()
        # papers, by pmid: and by doi: (PubMed does not index them): abstracts (entries that have
        # one — title-only records don't), full texts, title-only, retracted
        def papers(label: str, key: str) -> Text:
            p = types.get(key, {"entries": 0, "full_text": 0, "abstract": 0, "no_abstract": 0, "retracted": 0})
            r = row(label, p["entries"], "papers")
            seg(r, p["entries"] - p["no_abstract"], "abstracts", C_WARN)
            seg(r, p["full_text"], "full_text", C_OK)
            if p["no_abstract"]:
                seg(r, p["no_abstract"], "title-only", C_MUTE)
            if p["retracted"]:
                seg(r, p["retracted"], "retracted", C_FAIL)
            return r
        self.query_one("#row-pmid", Static).update(papers("pmid", "pmid"))
        self.query_one("#row-doi", Static).update(papers("doi", "doi"))
        self.query_one("#row-dailymed", Static).update(row("dailymed", types.get("dailymed", {"entries": 0})["entries"], "drug labels"))
        self.query_one("#row-nct", Static).update(row("nct", types.get("nct", {"entries": 0})["entries"], "trials"))
        # the cache rows: hits and misses summed over the servers alive on this library (src/stats.ts)
        sv = res.get("servers") or []
        def cache_row(label: str, count: int, unit: str, kind: str) -> Text:
            r = row(label, count, unit)
            # no server alive: the counters are nobody's — grey, like the "no server running" note
            seg(r, sum(x.get(kind, {}).get("hits", 0) for x in sv), "hits", C_OK if sv else C_MUTE)
            seg(r, sum(x.get(kind, {}).get("misses", 0) for x in sv), "misses", C_WARN if sv else C_MUTE)
            return r
        u = types.get("url", {"entries": 0, "full_text": 0})   # web pages (fh_fetch_url); fetches that failed are level title
        r = cache_row("url", u["entries"], "web pages", "fetch")
        if u["entries"] - u["full_text"]:
            seg(r, u["entries"] - u["full_text"], "failed", C_FAIL)
        self.query_one("#row-url", Static).update(r)
        r = cache_row("verify", res.get("verdicts", 0), "claims cached", "verify")
        self.query_one("#row-verdicts", Static).update(r)
        # How many MCP servers run on this library (their .servers/ files): the hits and misses above are summed over them.
        m = Text()
        if sv:
            m.append(str(len(sv)), style=C_OK).append(f" MCP{'s' if len(sv) != 1 else ''}")
        else:
            m.append("no MCP running")
        self.query_one("#mcps", Static).update(m)
        self.query_one("#row-search", Static).update(cache_row("search", res.get("searches", 0), "queries cached", "search"))

    # ---- actions -----------------------------------------------------------

    async def on_select_changed(self, event: Select.Changed) -> None:
        # Menus, not fields: run the entry and clear the selection again.
        # Select.NULL (Textual >= 1), Select.BLANK before that.
        value = event.value
        if value is None or isinstance(value, type(NULL)):
            return
        event.select.clear()
        await self.run_action(str(value))

    def action_nav(self, direction: int) -> None:
        """Left/right: move focus between the nav menus (wraps)."""
        menus = list(self.query("#nav Select"))
        if not menus:
            return
        try:
            i = menus.index(self.focused)
        except ValueError:
            i = -1 if direction > 0 else 0
        menus[(i + direction) % len(menus)].focus()

    def _following(self) -> bool:
        """The view follows the log: anchored and not released by a scroll up, not paused."""
        log = self._log()
        return not self._paused and log.is_anchored and not log._anchor_released

    def action_log_bottom(self) -> None:
        self._paused = False
        log = self._log()
        log.auto_scroll = True
        log.anchor()
        self._refresh_follow()

    def action_pause(self) -> None:
        """Space: pause the view where it is; again (or b) to jump to the end and follow."""
        if self._paused or not self._following():
            self.action_log_bottom()
        else:
            self._paused = True
            self._log().auto_scroll = False
            self._log().release_anchor()
            self._refresh_follow()

    def action_log_top(self) -> None:
        log = self._log()
        log.auto_scroll = False
        log.release_anchor()
        log.scroll_home(animate=False)
        self._refresh_follow()

    def action_log_page(self, direction: int) -> None:
        log = self._log()
        if direction < 0:
            log.auto_scroll = False
            log.release_anchor()
            log.scroll_page_up(animate=False)
        else:
            log.scroll_page_down(animate=False)
            if log.scroll_y >= log.max_scroll_y and not self._paused:
                log.auto_scroll = True
                log.anchor()
        self._refresh_follow()

    def action_clear(self) -> None:
        self._log().clear()
        self._raw.clear()
        self._matches = 0
        self._lines = 0

    # ---- filter ---------------------------------------------------------------

    def _filtering(self) -> bool:
        return bool(self._filter) or self._errors or self._fails or self._alerts_only

    def _match(self, line: str) -> bool:
        if self._filter and self._filter not in line.lower():
            return False
        if self._errors:
            return misuse(line)
        if self._fails:
            return hard_fail(line)
        if self._alerts_only:
            return alert(line)
        return True

    def _apply_filter(self) -> None:
        """Rebuild the pane from the lines read: those that hold the filter text
        (case-insensitive, the whole line as in the file — the full URL, the
        date), or the last TAIL_LINES without a filter; then follow the end."""
        log = self._log()
        log.clear()
        log._last_id, log._parity = None, 0
        if self._filtering():
            shown = [ln for ln in self._raw if self._match(ln)]
            self._matches = len(shown)
        else:
            shown = list(self._raw)[-TAIL_LINES:]
            self._matches = 0
        if shown:
            log.write_lines(shown)
        self.action_log_bottom()

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "filter":
            self._filter = event.value.strip().lower()
            self._apply_filter()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "filter":   # Enter: back to the menus, the filter stays
            self.query_one("#log-select", Select).focus()

    def _set_only(self, errors: bool = False, fails: bool = False, alerts: bool = False) -> None:
        """The three kinds take turns: at most one toggle on."""
        self._errors, self._fails, self._alerts_only = errors, fails, alerts
        self.query_one("#errors", Static).set_class(errors, "on")
        self.query_one("#fails", Static).set_class(fails, "on")
        self.query_one("#alerts", Static).set_class(alerts, "on")

    def action_errors_toggle(self) -> None:
        self._set_only(errors=not self._errors)
        self._apply_filter()

    def action_fails_toggle(self) -> None:
        self._set_only(fails=not self._fails)
        self._apply_filter()

    def action_alerts_toggle(self) -> None:
        self._set_only(alerts=not self._alerts_only)
        self._apply_filter()

    def action_filter_focus(self) -> None:
        self.query_one("#filter", Input).focus()

    def action_filter_clear(self) -> None:
        """✕ / Esc: the text and both toggles off."""
        f = self.query_one("#filter", Input)
        toggled = self._errors or self._fails or self._alerts_only
        self._set_only()
        if toggled and not f.value:
            self._apply_filter()
        if f.value:
            f.value = ""   # Input.Changed rebuilds the pane
        if isinstance(self.focused, Input):
            self.query_one("#log-select", Select).focus()

    def action_mark(self) -> None:
        """Append a marker to evidence.log: blank line, "==== mark <time> ====", blank
        line — so a test run can be found in the file and seen in the pane."""
        try:
            with LOG_FILE.open("a", encoding="utf-8") as f:
                f.write(f"\n==== mark {time.strftime('%Y-%m-%d %H:%M:%S')} ====\n\n")
        except OSError as e:
            self.notify(f"mark failed: {e}", severity="error")

    def action_erase(self) -> None:
        """Truncate evidence.log. Two presses within ERASE_SECS: the first arms, the
        second erases — one stray key must not wipe the file."""
        now = time.monotonic()
        if now - self._erase_armed > ERASE_SECS:
            self._erase_armed = now
            self.notify(f"erase evidence.log: press e again within {ERASE_SECS:.0f} s", timeout=ERASE_SECS)
            return
        self._erase_armed = 0.0
        try:
            LOG_FILE.write_bytes(b"")
        except OSError as e:
            self.notify(f"erase failed: {e}", severity="error")
            return
        self._pos = 0
        self._alerts = Alerts()   # erased by hand: its alerts with it (a rotation keeps them)
        self._log().clear()
        self._raw.clear()
        self._matches = 0
        self._lines = 0
        self.notify("evidence.log erased", timeout=2.0)

    def action_refresh(self) -> None:
        self._start_scan()

    # ---- clipboard: drag to select, released = copied ------------------------

    def _copy_selection(self) -> bool:
        text = self.screen.get_selected_text()
        if not text:
            return False
        self.copy_to_clipboard(text)          # OSC 52: the terminal puts it on the system clipboard
        n = text.count("\n") + 1
        self.notify(f"copied {n} line{'s' if n != 1 else ''}", timeout=1.5)
        return True

    def on_mouse_up(self, event: events.MouseUp) -> None:
        # Textual's own selection (drag in the log) is final by now; copy it
        # without a key, like a terminal's primary selection.
        self.call_after_refresh(self._copy_selection)

    def action_copy(self) -> None:
        self._copy_selection()

    # ---- /status endpoint (FH_TUI_PORT) ----------------------------

    def _start_status_server(self) -> None:
        if STATUS_PORT and self._status_server is None:
            self.run_worker(self._ensure_status_server, thread=True, exclusive=True, group="status-http")

    def _ensure_status_server(self) -> None:
        """Bind 0.0.0.0:PORT (the container publishes the port, the host's
        firewall decides who reaches it), serve on a daemon thread; a failed
        bind is noted in red and tried again every BIND_RETRY_SECS."""
        try:
            _StatusHandler.app = self
            srv = ThreadingHTTPServer(("0.0.0.0", STATUS_PORT), _StatusHandler)
            srv.daemon_threads = True
        except OSError as e:
            err = f"cannot bind :{STATUS_PORT}: {e.strerror or e}"
            if err != self._status_err:
                self._status_err = err
                self.call_from_thread(self._show_endpoint, f"port {STATUS_PORT} off — {e.strerror or e}", True)
                self.call_from_thread(self._log().write_line, f"!! status endpoint off: {err} — retrying every {BIND_RETRY_SECS // 60} min")
            return
        threading.Thread(target=srv.serve_forever, name="status-http", daemon=True).start()
        self._status_server, self._status_err = srv, None
        self.call_from_thread(self._show_endpoint, f"port {STATUS_PORT}", False)
        self.call_from_thread(self._log().write_line, f"─── status endpoint: http://0.0.0.0:{STATUS_PORT}/status ───")

    def _show_endpoint(self, text: str, alert: bool) -> None:
        w = self.query_one("#endpoint", Static)
        w.update(text)
        w.set_class(alert, "alert")
        self.query_one("#sep-endpoint", Static).display = bool(text)

    def _publish_status(self) -> None:
        """Rebuild the JSON snapshot (event loop; the HTTP thread only reads it)."""
        try:
            self._status_json = json.dumps(self._status_snapshot(), separators=(",", ":")).encode()
        except Exception as e:  # pragma: no cover
            self._status_json = json.dumps({"status": "degraded", "problems": [f"snapshot failed: {e}"]}).encode()

    def _status_snapshot(self) -> dict:
        now = time.time()
        res = self._last_scan or {}
        problems: list[str] = []
        if not res:
            problems.append("no scan yet")
        if not LOG_FILE.is_file():
            problems.append("evidence.log missing")
        if "error" in res:
            problems.append(f"scan failed: {res['error']}")
        vr = res.get("verify") or {}
        urs = res.get("unlockers") or []
        if vr.get("configured") and not vr.get("ok"):
            problems.append(f"verify model: {vr.get('error') or 'no answer'}")
        problems += [f"unlocker {ur.get('provider')}: {ur.get('error') or 'no answer'}" for ur in urs if not ur.get("ok")]
        sts = res.get("stages") or []
        problems += [f"stage {st.get('name')}: {st.get('error') or 'down'}" for st in sts if not st.get("up")]
        dk = res.get("disk")
        if dk and dk["pct"] >= DISK_FULL_PCT:
            problems.append(f"disk {dk['pct']}% full ({human(dk['free'])} free)")
        problems += self._alerts.problems(now)
        types, levels = res.get("types", {}), res.get("by_level", {})
        entries = {"total": res.get("entries", 0)}
        entries.update({t: types.get(t, {}).get("entries", 0) for t in ("pmid", "doi", "dailymed", "nct", "url")})
        # title-only entries carry level "abstract" with has_abstract false (as fh_info counts them)
        entries.update({"abstract": levels.get("abstract", 0) - res.get("no_abstract", 0), "full_text": levels.get("full_text", 0),
                        "title": res.get("no_abstract", 0), "retracted": res.get("retracted", 0)})
        return {
            "status": "degraded" if problems else "ok",
            "problems": problems,
            "generated_at": int(now),
            "stale_after": STATUS_SECS * 2,
            "host": socket.gethostname().split(".")[0],
            "tui_version": TUI_VERSION,
            "package_version": PACKAGE_VERSION,
            "playwright": PLAYWRIGHT_VERSION,
            "library": {"dir": str(FH_EVIDENCE_DIR), "size_bytes": res.get("bytes", 0), "entries": entries,
                        "disk": {"used_pct": dk["pct"], "total_bytes": dk["total"], "free_bytes": dk["free"]} if dk else None},
            "tiers": active_tiers(),
            "pull": dict(self._pull),
            "log": res.get("log") or log_stats(now),
            "fetches": {"stored": types.get("url", {}).get("entries", 0),
                        "hits": sum(s.get("fetch", {}).get("hits", 0) for s in res.get("servers") or []),
                        "misses": sum(s.get("fetch", {}).get("misses", 0) for s in res.get("servers") or [])},
            "searches": {"stored": res.get("searches", 0),
                         "hits": sum(s.get("search", {}).get("hits", 0) for s in res.get("servers") or []),
                         "misses": sum(s.get("search", {}).get("misses", 0) for s in res.get("servers") or [])},
            "verdicts": {"stored": res.get("verdicts", 0),
                         "hits": sum(s.get("verify", {}).get("hits", 0) for s in res.get("servers") or []),
                         "misses": sum(s.get("verify", {}).get("misses", 0) for s in res.get("servers") or []),
                         "servers": len(res.get("servers") or []),
                         "since": min((s.get("started", "") for s in res.get("servers") or []), default=None)},
            "verify": {"configured": bool(vr.get("configured")), "ok": bool(vr.get("ok")), "model": vr.get("model"), "host": vr.get("host"),
                       "ms": round(vr["secs"] * 1000) if vr.get("secs") is not None else None, "error": vr.get("error")},
            "unlockers": [{"provider": ur.get("provider"), "ok": bool(ur.get("ok")), "ms": round(ur["secs"] * 1000) if ur.get("secs") is not None else None,
                           "error": ur.get("error"), "checked": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ur["at"])) if ur.get("at") else None} for ur in urs],
            "stages": [{"name": st.get("name"), "up": bool(st.get("up")), "ms": round(st["secs"] * 1000) if st.get("secs") is not None else None, "error": st.get("error")} for st in sts],
        }

    # ---- pull with the rescan (FH_TUI_PULL) ---------------------------

    def _pull_in_cycle(self) -> None:
        """On the scan thread, before the scan: the same pull as (u)pdate. The
        log pane hears of it only when something changed or failed; another
        container's lock on a shared checkout skips this cycle. A changed tui/
        then restarts the TUI (_after_update)."""
        out, ok = self._git_pull()
        text = "\n".join(out)
        if not ok and (PULL_BUSY in text or "multiple branches" in text or (".lock" in text and ("File exists" in text or "Unable to create" in text))):
            result = "skipped"   # another pull on this checkout; the next cycle pulls
        elif not ok:
            result = "failed"
        elif all(ln.startswith("Already up to date") or ln.startswith("Current branch") for ln in out):
            result = "unchanged"
        else:
            result = "changed"
        self._pull = {"enabled": True, "last_at": int(time.time()), "result": result}
        if result in ("changed", "failed"):
            self.call_from_thread(self._after_update, out, ok, True)

    # ---- (u)pdate: git pull, restart when the TUI itself changed ------------

    @staticmethod
    def _self_hash() -> str:
        h = hashlib.sha256()
        for f in (CTL_PATH, CTL_PATH.with_name("run.sh"), CTL_PATH.with_name("requirements.txt")):
            h.update(f.read_bytes() if f.is_file() else b"")
        return h.hexdigest()

    def action_update(self) -> None:
        if self._updating:
            return
        self._updating = True
        self._log().write_line("─── update: git pull ───")
        self.run_worker(self._update, thread=True, exclusive=True, group="update")

    def _check_self(self) -> None:
        """tui/ changed on disk (a pull, or a commit in this checkout): restart."""
        if not self.restart and not self._updating and self._self_hash() != self._loaded_hash:
            self._restart("TUI files changed — restarting")

    def _restart(self, why: str) -> None:
        self.restart = True
        self._log().write_line(f"    {why}")
        self.set_timer(0.8, self.exit)

    @staticmethod
    def _git_pull() -> tuple[list[str], bool]:
        """One pull at a time per checkout: two TUIs (e.g. two containers) may share one
        clone, and two pulls at once leave two merge lines in FETCH_HEAD ("Cannot
        rebase onto multiple branches"). The lock is a file in .git, so it works
        across containers on one host; the loser reports PULL_BUSY and skips."""
        try:
            with open(REPO_ROOT / ".git" / "fh-tui-pull.lock", "w") as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError:
                    return [PULL_BUSY], False
                r = subprocess.run(["git", "pull", "--rebase", "--autostash"], cwd=REPO_ROOT,
                                   capture_output=True, text=True, timeout=120, env={**os.environ, "LC_ALL": "C"})
                return (r.stdout + r.stderr).strip().splitlines() or ["(no output)"], r.returncode == 0
        except Exception as e:
            return [f"git pull failed: {e}"], False

    def _update(self) -> None:
        out, ok = self._git_pull()
        self.call_from_thread(self._after_update, out, ok, False)

    def _after_update(self, out: list[str], ok: bool, quiet: bool = False) -> None:
        """quiet: the pull came with the rescan, and something changed or failed."""
        self._updating = False
        log = self._log()
        if quiet:
            log.write_line("─── pull ───" if ok else "!! pull failed")
        log.write_lines([("    " if ok else "!! ") + ln for ln in out])
        if not ok:
            return
        # Against the files as LOADED, not as they were before the pull: in the
        # dev checkout the change arrives by commit, and the pull says "up to date".
        if self._self_hash() != self._loaded_hash:
            self._restart("TUI files changed — restarting")
        elif not quiet:
            log.write_line("    TUI unchanged (a changed server needs `npm run build` and an MCP reload)")
        if not quiet:
            self._start_scan()      # (u)pdate also refreshes the counts: a wiped or filled library shows at once, not at the next timer tick


if __name__ == "__main__":
    app = Ctl()
    app.run()
    if app.restart:
        # Same interpreter (the venv's), fresh process: Textual has restored the
        # terminal by now. run.sh is not re-run, so a changed requirements.txt
        # needs a manual restart.
        os.execv(sys.executable, [sys.executable, str(CTL_PATH)] + sys.argv[1:])
