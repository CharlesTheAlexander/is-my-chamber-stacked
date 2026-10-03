#!/usr/bin/env python3
"""Is My Chamber Stacked? Builds the site's static data files from Tabroom's public REST API. stdlib only.

    python3 app.py --crawl          fetch every non-frozen season into cache/ (resumable, polite)
    python3 app.py --freeze         write perfs/{season}.json.gz for completed seasons (never overwrites; delete one to refreeze)
    python3 app.py --export site    build people from frozen + cached seasons, write site/index.html, site/assets/ and site/data/*
    python3 app.py --calibrate      print the chamber-strength distribution behind CHAMBER_THRESHOLDS, write perfs/chambers.json
    python3 app.py --selfcheck      offline asserts
"""
import argparse
import gzip
import http.client
import json
import math
import os
import re
import shutil
import ssl
import statistics
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from itertools import combinations
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
PERFS_DIR = HERE / "perfs"
CHAMBERS_FILE = PERFS_DIR / "chambers.json"
BASE = "https://api.tabroom.com/v1/rest"
USER_AGENT = "IsMyChamberStacked/0.1 (personal Congress-prep tool; low volume)"
MIN_INTERVAL, TIMEOUT = 0.25, 30
CIRCUIT = 228
FIRST_SEASON = 2020
EXTRA_TOURNS = [37602, 39322]
TOC_TID = 36156
OVERRIDES = {TOC_TID: "TOC", 37602: "NSDA", 39322: "NCFL"}
SHORT = {TOC_TID: "TOC", 37602: "NSDA Nats", 39322: "NCFL"}
SHORT_DROP = {"annual", "national", "speech", "debate", "tournament", "invitational", "high", "school", "schools", "hs", "sr", "jr", "e"}
CONNECTORS = {"of", "at", "for", "in", "to", "the", "a", "an", "and", "&", "v", "vs", "de", "la", "on", "by", "with"}
YEAR = re.compile(r"(?:19|20)\d\d|'\d\d|\d+(?:st|nd|rd|th)", re.I)
NAME_TIERS = [
    ("TOC", re.compile(r"^(?:\d{4} )?(?:\d+(?:st|nd|rd|th) )?(?:annual )?tournament of champions(?: \d{4})?$")),
    ("NSDA", re.compile(r"^(?:\d{4} )?(?:nsda national tournament|national speech (?:and|&) debate tournament|nsda nationals?)(?: \d{4})?$")),
    ("NCFL", re.compile(r"^(?:\d{4} )?(?:ncfl )?grand nationals?(?: tournament)?$")),
]
SHARDS = 256
CAL_SEASON, MIN_CHAMBER = 2025, 6
# 20th/45th/70th/90th percentile of chamber_strength over the real 2025-26 circuit-228 prelim chambers, members rated from perfs before each tournament (--calibrate, run 2026-10-03)
CHAMBER_THRESHOLDS = [23.4, 36.7, 46.7, 61.4]
KEY_TESTS = ["Diego Pa-Ortiz", "José O'Brien", "Zoë  Müller", "Mary–Kate Smith Jr.", "D’Angelo Smith", "ANNA_MARIE  LEE",
             "J.R. Smith", "Núñez  Peña", "  Leading Space ", "Łukasz Żółć", "ﬁsh Name", "Ångström‐Lund"]
HASH_TESTS = ["a", "foobar", "diego pa ortiz", "maria annie domingues", "zoe muller", "emily lin"]

_now = datetime.now(timezone.utc)
CURRENT_SEASON = _now.year if _now.month >= 7 else _now.year - 1

TIER_WEIGHT = {"TOC": 3.0, "NSDA": 2.5, "NCFL": 2.0, "T4": 2.0, "T3": 1.6, "T2": 1.2, "T1": 0.9}
DEPTH_PTS = {"P": 0, "O": 2, "Q": 4, "S": 7, "F": 12}
PLACE_BONUS = {1: 12, 2: 8, 3: 6, 4: 4, 5: 3, 6: 2}
PRELIM_MAX = 3
BID_BONUS = 3
LOCAL_WEIGHT = [0.15, 0.45]
SEASON_MULT = {0: 1.0, 1: 0.9, 2: 0.6, 3: 0.35, 4: 0.2, 5: 0.1, 6: 0.05}
TOPK, DECAY, SCALE = 6, 0.7, 45
UNKNOWN_R = 15
SCHOOL_STOP = {"the", "high", "school", "hs", "sr", "senior", "of", "and", "at", "upper", "secondary", "prep", "preparatory",
               "academy", "college", "h", "s"}
INDEP = re.compile(r"\b(?:indep\w*|individual|unaffiliated|home ?schooled?|club|institute|society|debate|speech|forensics?)\b")


def log(msg: str) -> None:
    print(f"{datetime.now():%H:%M:%S} {msg}", flush=True)


def name_key(name: str) -> str:
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[-‐–—_.]", " ", s).replace("'", "").replace("’", "")
    return " ".join(s.split())


def shard_of(key: str) -> int:
    h = 2166136261
    for b in key.encode("utf-8"):
        h = ((h ^ b) * 16777619) & 0xFFFFFFFF
    return h & 0xFF


# ---------------------------------------------------------------- result-set extraction

DEPTHS = "POQSF"
SKIP_EVENT = re.compile(r"\b(ms|middle|jv|junior varsity|novice|nov|round robin|rr)\b", re.I)
SKIP_SET = re.compile(r"consol|\bpo\b|presiding", re.I)
FINAL_PLACE = re.compile(r"^(?:(\d+)(?:st|nd|rd|th)(?:-T(?:ie)?)?|co-champion|finals?)$", re.I)


def stage_of(label: str) -> str | None:
    s = label.lower()
    if SKIP_SET.search(s):
        return None
    if re.search(r"\bsemi|\bsem\b", s):
        return "S"
    if re.search(r"\bq(ua)?rt|\bqtr|\bquarter", s):
        return "Q"
    if re.search(r"\bocta|\bocto|\bdouble", s):
        return "O"
    if re.search(r"\bfinal", s):
        return "F"
    return "P"


def congress_events(index: dict) -> list[dict]:
    return [e for e in index.values()
            if e.get("type") == "congress" and e.get("level") == "open"
            and not SKIP_EVENT.search(e.get("name", "")) and not e.get("abbr", "").upper().endswith("RR")]


def plan(event: dict) -> list[tuple[str, str | None, dict]]:
    """Result sets to fetch as (role, stage, set_stub). Roles: elim, base, final-places, bid."""
    sets = event.get("ResultSets", [])
    bid = next((s for s in sets if s["tag"] in ("circuit", "qualifier")
                and ((s.get("Circuit") or {}).get("id") == CIRCUIT or "toc" in s["label"].lower())), None)
    chambers = [(stage_of(s["label"]), s) for s in sets if s["tag"] == "chamber"]
    elims = [("elim", st, s) for st, s in chambers if st and st != "P"]
    seed = next((s for s in sets if s["tag"] == "seed"), None)
    final = next((s for s in sets if s["tag"] == "final"), None)
    prelims = [s for st, s in chambers if st == "P"]   # every P set: labels are free text (Barkley's final is "Exhib")
    out = list(elims)
    if prelims:
        out += [("base", None, s) for s in prelims]
    elif elims and (seed or final):
        out.append(("base", None, seed or final))
    elif final:
        out.append(("final-places", None, final))
    elif seed:
        out.append(("base", None, seed))
    if bid:
        out.append(("bid", None, bid))
    return out


def infer_tier(n_bids: int) -> str:
    return "T1" if n_bids <= 6 else "T2" if n_bids <= 16 else "T3" if n_bids <= 60 else "T4"


def tier_override(t: dict) -> str | None:
    if t["id"] in OVERRIDES:
        return OVERRIDES[t["id"]]
    key = name_key(t.get("name") or "")
    return next((tier for tier, rx in NAME_TIERS if rx.search(key)), None)


def _rows(data: Any) -> list[dict]:
    return (data[0] if isinstance(data, list) and data else data or {}).get("results", [])


def resolve(plan_rows: list[tuple[str, str | None, dict]], fetched: dict[int, Any]) -> list[tuple[str, str | None, dict]]:
    """Several 'base' sets: the one with most entries is the real base. Any other with < 60% of its entries is a
    mislabelled elim: F if its max roundName beats every elim set and no F set exists, else dropped."""
    bases = [r for r in plan_rows if r[0] == "base"]
    if len(bases) < 2:
        return plan_rows
    n = {r[2]["id"]: len({(x.get("Entry") or {}).get("id") for x in _rows(fetched[r[2]["id"]])}) for r in bases}
    last = lambda r: max((x.get("roundName") or 0 for x in _rows(fetched[r[2]["id"]])), default=0)
    big = max(bases, key=lambda r: n[r[2]["id"]])
    elims = [r for r in plan_rows if r[0] == "elim"]
    out = [r for r in plan_rows if r[0] != "base"] + [big]
    for r in bases:
        if r is not big and n[r[2]["id"]] < 0.6 * n[big[2]["id"]] \
                and not any(e[1] == "F" for e in elims) and all(last(r) > last(e) for e in elims):
            out.append(("elim", "F", r[2]))
    return out


def extract(tier_forced: str | None, plan_rows: list[tuple[str, str | None, dict]], fetched: dict[int, Any]) -> list[dict]:
    """One perf per Entry.id from the fetched sets (set_id -> REST response)."""
    plan_rows = resolve(plan_rows, fetched)
    rows: dict[int, dict] = {}
    n_bids = 0
    for role, stage, stub in plan_rows:
        rs = _rows(fetched[stub["id"]])
        sizes = Counter(r.get("section") for r in rs)
        single_section = len(sizes) == 1 and len({r.get("rank") for r in rs}) > 1
        ranked = sum(bool(FINAL_PLACE.match(str(r.get("place") or ""))) for r in rs)
        everyone_ranked = len(rs) > 12 and ranked >= 0.9 * len(rs)   # ponytail: a <= 12 row set can't be told from a real final
        for r in rs:
            e = r.get("Entry") or {}
            if not e.get("id"):
                continue
            p = rows.setdefault(e["id"], {"eid": e["id"], "name": e.get("name") or "", "school": (r.get("School") or {}).get("name") or "",
                                          "depth": "P", "place": None, "bid": False, "pct": None})
            if role == "elim":
                if DEPTHS.index(stage) > DEPTHS.index(p["depth"]):
                    p["depth"] = stage
                if stage == "F" and single_section:
                    p["place"] = int(r["rank"])
            elif role == "base":
                if stub["tag"] == "chamber" and r.get("rank") and sizes[r.get("section")]:
                    p["pct"] = 1 - (int(r["rank"]) - 1) / sizes[r.get("section")]
                elif r.get("percentile") is not None:
                    p["pct"] = float(r["percentile"]) / 100
            elif role == "final-places":
                pl = str(r.get("place") or "")
                if m := FINAL_PLACE.match(pl):
                    d, place = ("P", None) if everyone_ranked else ("F", int(m.group(1) or r.get("rank") or 0) or None)
                else:
                    d, place = ("S" if re.match(r"sem", pl, re.I) else "Q" if re.match(r"qu|qtr", pl, re.I)
                                else "O" if re.match(r"oct|doub", pl, re.I) else "P"), None
                if DEPTHS.index(d) > DEPTHS.index(p["depth"]):
                    p["depth"] = d
                if d == "F":
                    p["place"] = min(filter(None, (p["place"], place)), default=None)
                if r.get("percentile") is not None:
                    p["pct"] = float(r["percentile"]) / 100
            elif role == "bid":
                p["bid"] = True
                n_bids += 1
    for p in rows.values():
        if p["bid"] and p["depth"] == "P":
            p["depth"] = "Q"
    tier = tier_forced or (infer_tier(n_bids) if n_bids else "local")
    for p in rows.values():
        p["tier"], p["field"] = tier, len(rows)
    return list(rows.values())


def short_name(tid: int, name: str) -> str:
    # ponytail: word-level heuristic, a few odd names stay odd; hand-map them in SHORT if one matters
    if tid in SHORT:
        return SHORT[tid]
    nat = {"TOC": "TOC", "NSDA": "NSDA Nats", "NCFL": "NCFL"}.get(tier_override({"id": tid, "name": name}) or "")
    if nat:
        return nat
    words = [w for w in re.sub(r"\bspeech\s*(?:and|&)\s*debate\b", " ", name, flags=re.I).split() if not YEAR.fullmatch(w)]
    if len(words) > 2 and words[0].lower() in ("the", "a", "an") and words[1].lower() not in ("and", "&"):
        words.pop(0)
    core = [w for w in words if w.lower() not in SHORT_DROP]
    if not core or core[0].lower() in CONNECTORS:
        core = words
    keep = core if len(core) <= 4 and len(" ".join(core)) <= 26 else core[:3]
    cut = len(keep) < len(core)
    while len(keep) > 1 and (keep[-1].lower() in CONNECTORS or cut and len(keep[-1]) == 1 and keep[-1].isalpha() and keep[-2].lower() not in CONNECTORS):
        keep.pop()
    return " ".join(keep).strip(" ,-:;&/(") or name


def season_of(date: str) -> int:
    y, m = int(date[:4]), int(date[5:7])
    return y if m >= 7 else y - 1


def season_label(y: int) -> str:
    return f"{y}-{(y + 1) % 100:02d}"


def perf_records(t: dict, event: dict, perfs: list[dict]) -> list[dict]:
    date, tname = t["start"][:10], t.get("name") or ""
    return [{**p, "key": name_key(p["name"]), "tid": t["id"], "ev": event["id"], "tname": tname, "tourn": short_name(t["id"], tname),
             "date": date, "season": season_of(date)} for p in perfs if p["name"]]


# ---------------------------------------------------------------- scoring

def tier_weight(tier: str, field: int | None) -> float:
    if tier in TIER_WEIGHT:
        return TIER_WEIGHT[tier]
    lo, hi = LOCAL_WEIGHT
    return min(hi, max(lo, lo + (field or 40) / 200))


def perf_points(p: dict, seasons_ago: int) -> float:
    d = p["depth"]
    base = DEPTH_PTS[d] + (PLACE_BONUS.get(p["place"], 0) if d == "F" else 0) + (PRELIM_MAX * p["pct"] if d == "P" and p["pct"] else 0)
    return (base * tier_weight(p["tier"], p["field"]) + (BID_BONUS if p["bid"] else 0)) * SEASON_MULT.get(seasons_ago, 0)


def tier_label(rating: float | None, circuit_share: float) -> str:
    if rating is None:
        return "Mystery Box"
    if rating < 10:
        return "Free Real Estate"
    if circuit_share < 0.25 and rating < 60:
        return "Local Menace"
    return "Final Boss" if rating >= 80 else "TOC-Bound" if rating >= 60 else "Bid Hunter" if rating >= 45 else "Circuit Regular"


def score_person(perfs: list[dict]) -> dict | None:
    if not perfs:
        return None
    scored = sorted(((perf_points(p, CURRENT_SEASON - p["season"]), p) for p in perfs), key=lambda x: -x[0])
    contrib = [pts * DECAY ** i for i, (pts, _) in enumerate(scored[:TOPK])]
    raw = sum(contrib)
    rating = 100 * (1 - math.exp(-raw / SCALE))
    share = sum(c for c, (_, p) in zip(contrib, scored) if p["tier"] != "local") / raw if raw else 0.0
    bids = Counter(p["season"] for p in perfs if p["bid"])
    one = max(bids.values(), default=0)
    auto = any((p["tier"] == "TOC" and p["depth"] in ("F", "S")) or (p["tier"] == "NSDA" and p["depth"] == "F")
               or (p["tier"] == "NCFL" and p["depth"] == "F" and p["place"] is not None and p["place"] <= 6) for p in perfs)
    if auto or one >= 2:
        rating = max(rating, 60.0)
    elif one == 1:
        rating = max(rating, 45.0)
    return {"rating": rating, "circuit_share": share, "bids": bids, "bids_one_season": one, "auto_qual": auto,
            "ranked": scored, "tier": tier_label(rating, share)}


def ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def result_label(p: dict) -> str:
    head = {"F": ordinal(p["place"]) if p["place"] else "Finals", "S": "Semis", "Q": "Quarters", "O": "Octos", "P": "Prelims"}[p["depth"]]
    return f"{head} @ {p['tourn']} '{p['date'][2:4]}"


def badges(perfs: list[dict], sc: dict) -> list[str]:
    out = [f"TOC qualified '{(s + 1) % 100:02d}" for s, n in sorted(sc["bids"].items(), reverse=True) if n >= 2]
    if sc["auto_qual"]:
        out.append("Auto-qual")
    toc = {p["depth"] for p in perfs if p["tier"] == "TOC"}
    if "F" in toc:
        out.append("TOC finalist")
    elif "S" in toc:
        out.append("TOC semifinalist")
    if any(p["tier"] == "NSDA" and p["depth"] == "F" for p in perfs):
        out.append("Nats finalist")
    if any(p["place"] == 1 and p["depth"] == "F" and p["tier"] in ("T1", "T2", "T3", "T4") for p in perfs):
        out.append("Bid champ")
    if sc["bids_one_season"] == 1:
        out.append("Bid holder")
    circuit = [p for p in perfs if p["tier"] != "local"]
    if len(circuit) >= 3 and all(p["depth"] == "P" for p in perfs):
        out.append("Circuit tourist")
    return out


def advancing(n: int) -> int:
    return min(6, max(3, round(n / 3)))


def chamber_strength(ratings: list[float | None], adv: int) -> float:
    rs = sorted((UNKNOWN_R if r is None else r for r in ratings), reverse=True)
    if not rs:
        return 0.0
    top = rs[:adv]
    rest = rs[adv:] or top
    return 0.75 * sum(top) / len(top) + 0.25 * sum(rest) / len(rest)


# ---------------------------------------------------------------- fetcher + cache

OFFLINE = True
REQUESTS = 0
_last_request = 0.0


class Stop(Exception):
    """Tabroom asked us to back off or TLS is broken: abort the whole crawl."""


class FetchError(Exception):
    """One request failed (or, offline, is not cached); nothing is cached."""


def setup_tls() -> None:
    v = ssl.get_default_verify_paths()
    usable = os.environ.get("SSL_CERT_FILE") or (v.cafile and os.path.exists(v.cafile)) or (v.capath and os.path.isdir(v.capath))
    if not usable:
        bundle = next((f for f in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt") if os.path.exists(f)), None)
        if bundle:
            os.environ["SSL_CERT_FILE"] = bundle


def fetch_json(url: str) -> tuple[int, Any]:
    """(status, data): 200 with parsed JSON or 404 with None, at most one request per MIN_INTERVAL."""
    global _last_request, REQUESTS
    time.sleep(max(0.0, MIN_INTERVAL - (time.monotonic() - _last_request)))
    REQUESTS += 1
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return 200, json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return 404, None
        if e.code in (429, 503):
            raise Stop(f"Tabroom answered HTTP {e.code}; stopping, rerun later")
        raise FetchError(f"HTTP {e.code} {url}")
    except urllib.error.URLError as e:
        if isinstance(e.reason, ssl.SSLCertVerificationError):
            raise Stop("HTTPS certificate problem: run '/Applications/Python 3.x/Install Certificates.command'")
        raise FetchError(f"{e.reason} {url}")
    except (OSError, ValueError, http.client.HTTPException) as e:
        raise FetchError(f"{e!r} {url}")
    finally:
        _last_request = time.monotonic()


def cache_read(name: str) -> dict | None:
    try:
        return json.loads((CACHE / f"{name}.json").read_text())
    except (OSError, ValueError):
        return None


def cache_write(name: str, data: Any) -> None:
    tmp = CACHE / f".{name}.tmp"
    tmp.write_text(json.dumps({"fetched_at": time.time(), "data": data}, separators=(",", ":")))
    os.replace(tmp, CACHE / f"{name}.json")


Ttl = Callable[[Any], float | None]
PERMANENT: Ttl = lambda d: None
HALF_DAY: Ttl = lambda d: 12 * 3600.0


def cached(name: str, url: str, ttl: Ttl) -> Any:
    """Cache-or-fetch. ttl(data) is seconds of freshness or None for forever; a cached 404 is forever.
    Offline, any cached copy is fresh and a missing one raises FetchError."""
    hit = cache_read(name)
    if hit is not None:
        limit = None if hit["data"] is None else ttl(hit["data"])
        if OFFLINE or limit is None or time.time() - hit["fetched_at"] < limit:
            return hit["data"]
    if OFFLINE:
        raise FetchError(f"{name} is not in the cache")
    try:
        _, data = fetch_json(url)
    except FetchError as e:
        if hit is None:
            raise
        log(f"using stale cache for {name}: {e}")
        return hit["data"]
    cache_write(name, data)
    return data


def parse_ts(s: str) -> datetime:
    d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def results_ttl(end: datetime) -> Ttl:
    age = datetime.now(timezone.utc) - end
    return lambda d: None if age > timedelta(days=60) or (d and age > timedelta(days=7)) else 12 * 3600.0


# ---------------------------------------------------------------- crawler

def tournaments(seasons: list[int]) -> list[dict]:
    """Every published tournament from every circuit that started in `seasons`, crawl order."""
    found: dict[int, dict] = {}
    for y in seasons:
        off = 0
        while True:
            url = f"{BASE}/tourns?startAfter={y}-07-01T00:00:00Z&startBefore={y + 1}-07-01T00:00:00Z&limit=500&offset={off}&publishedResults=true"
            try:
                page = cached(f"tourns-all-{y}-{off}", url, PERMANENT if y < CURRENT_SEASON else HALF_DAY) or []
            except FetchError as e:
                log(f"season {y} list page {off} failed: {e}")
                break
            found.update({t["id"]: t for t in page if not t.get("hidden")})
            if len(page) < 500:
                break
            off += 500
    for tid in EXTRA_TOURNS:
        if tid not in found:
            try:
                if t := cached(f"tourn-{tid}", f"{BASE}/tourns/{tid}", PERMANENT):
                    found[tid] = t
            except FetchError as e:
                log(f"tourn {tid} metadata failed: {e}")
    now = datetime.now(timezone.utc)
    ts = [t for t in found.values() if t.get("start") and parse_ts(t["start"]) < now and season_of(t["start"][:10]) in seasons]
    first = lambda t: t["id"] in OVERRIDES or t["id"] in EXTRA_TOURNS
    return sorted(ts, key=lambda t: (not first(t), -parse_ts(t["start"]).timestamp(), t["id"]))


def process_tournament(t: dict) -> list[dict]:
    tid = t["id"]
    index = cached(f"results-{tid}", f"{BASE}/tourns/{tid}/results", results_ttl(parse_ts(t.get("end") or t["start"]))) or {}
    tier, perfs = tier_override(t), []
    for ev in congress_events(index):
        pl = plan(ev)
        fetched = {s["id"]: cached(f"set-{s['id']}", f"{BASE}/tourns/{tid}/results/{s['id']}", PERMANENT) for _, _, s in pl}
        perfs += perf_records(t, ev, extract(tier, pl, fetched))
    return perfs


def scan(seasons: list[int]) -> list[dict]:
    """Perfs of every tournament in `seasons`; online this also fills cache/, offline tournaments missing from it are skipped."""
    ts = tournaments(seasons)
    perfs: list[dict] = []
    skipped = 0
    for i, t in enumerate(ts, 1):
        try:
            perfs += process_tournament(t)
        except FetchError as e:
            skipped += 1
            if not OFFLINE:
                log(f"skipped tournament {t['id']} {t.get('name')!r}: {e}")
        if i % 250 == 0:
            log(f"{i}/{len(ts)} tournaments, {len(perfs)} perfs, {REQUESTS} requests")
    log(f"seasons {seasons}: {len(ts)} tournaments, {skipped} skipped, {len(perfs)} perfs, {REQUESTS} requests")
    return perfs


# ---------------------------------------------------------------- frozen seasons

def frozen_path(y: int, d: Path) -> Path:
    return d / f"{season_label(y)}.json.gz"


def write_frozen(y: int, perfs: list[dict], d: Path) -> Path:
    tourns = {str(p["tid"]): [p["tname"], p["date"]] for p in perfs}
    rows = sorted([p["tid"], p["ev"], p["eid"], p["name"], p["school"], p["depth"], p["place"], int(p["bid"]),
                   None if p["pct"] is None else round(p["pct"], 4), p["field"], p["tier"]] for p in perfs)
    body = json.dumps({"season": y, "tourns": tourns, "rows": rows}, separators=(",", ":"), sort_keys=True, ensure_ascii=False)
    d.mkdir(exist_ok=True)
    f = frozen_path(y, d)
    f.write_bytes(gzip.compress(body.encode("utf-8", "replace"), 9, mtime=0))
    return f


def read_frozen(f: Path) -> list[dict]:
    data = json.loads(gzip.decompress(f.read_bytes()))
    out = []
    for tid, ev, eid, name, school, depth, place, bid, pct, field, tier in data["rows"]:
        tname, date = data["tourns"][str(tid)]
        out.append({"eid": eid, "name": name, "school": school, "depth": depth, "place": place, "bid": bool(bid), "pct": pct,
                    "tier": tier, "field": field, "key": name_key(name), "tid": tid, "ev": ev, "tname": tname,
                    "tourn": short_name(tid, tname), "date": date, "season": data["season"]})
    return out


def load_perfs(seasons: list[int], d: Path) -> list[dict]:
    perfs, live = [], []
    for y in seasons:
        f = frozen_path(y, d)
        if f.exists():
            perfs += read_frozen(f)
        else:
            live.append(y)
    return perfs + (scan(live) if live else [])


# ---------------------------------------------------------------- people

def school_tokens(s: str) -> frozenset[str]:
    return frozenset(name_key(s).split()) - SCHOOL_STOP


def overlap(a: frozenset[str], b: frozenset[str]) -> float:
    return len(a & b) / min(len(a), len(b)) if a and b else 0.0


def group_schools(schools: list[str], twins: set[frozenset[str]]) -> dict[str, str]:
    """Union-find over school strings: token overlap >= 0.5 joins, unless the pair is proven to be two people."""
    parent = {s: s for s in schools}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    toks = {s: school_tokens(s) for s in schools}
    for a, b in combinations(sorted(schools), 2):
        if overlap(toks[a], toks[b]) >= 0.5 and frozenset((a, b)) not in twins:
            parent[find(a)] = find(b)
    return {s: find(s) for s in schools}


def cluster(perfs: list[dict]) -> list[list[dict]]:
    """One person per name unless a single event holds two same-name entries from different schools, which proves two
    people: then perfs are split by school overlap, never merging the proven pair directly. Independent/club-style
    entries join the largest real-school cluster."""
    in_event: dict[tuple, dict[int, str]] = {}
    for p in perfs:
        in_event.setdefault((p["tid"], p["ev"]), {})[p["eid"]] = p["school"]
    twins = {frozenset(pair) for d in in_event.values() for pair in combinations(sorted(set(d.values())), 2)}
    if not twins:
        return [perfs]
    schools = {p["school"] for p in perfs}
    indep = {s for s in schools if not s or INDEP.search(name_key(s))}
    real = schools - indep
    root = group_schools(sorted(real or indep), twins)
    groups: dict[str, list[dict]] = {}
    for p in perfs:
        if p["school"] in root:
            groups.setdefault(root[p["school"]], []).append(p)
    out = list(groups.values())
    if real and indep:
        max(out, key=lambda g: (len(g), max(p["date"] for p in g))).extend(p for p in perfs if p["school"] in indep)
    return out


def best_per_event(g: list[dict]) -> list[dict]:
    best: dict[tuple, dict] = {}
    for p in g:
        k = (p["tid"], p["ev"])
        if k not in best or perf_points(p, 0) > perf_points(best[k], 0):
            best[k] = p
    return list(best.values())


def hist_row(p: dict) -> list:
    return [p["date"], p["tid"], p["tourn"], "L" if p["tier"] == "local" else p["tier"], p["depth"],
            p["place"] if p["depth"] == "F" else None, int(p["bid"]), p["field"], season_label(p["season"])]


def person_obj(pid: str, g: list[dict]) -> dict:
    sc = score_person(g)
    schools = list(dict.fromkeys(p["school"] for p in g if p["school"]))
    n_tourn = len({p["tid"] for p in g})
    top, seen = [], set()
    for _, p in sc["ranked"]:
        label = result_label(p)
        venue = label.split(" @ ", 1)[1]
        if p["tid"] in seen or venue in seen:
            continue
        seen |= {p["tid"], venue}
        top.append({"label": label, "tier": p["tier"], **({"bid": True} if p["bid"] else {})})
        if len(top) == 3:
            break
    rows = best_per_event(g)
    return {"pid": pid, "name": g[0]["name"], "school": next((s for s in schools if not INDEP.search(name_key(s))), (schools or [""])[0]),
            "schools": schools, "n": n_tourn, "first": g[-1]["date"], "last": g[0]["date"], "rating": round(sc["rating"], 1),
            "tier": sc["tier"], "confidence": 1 if len(g) < 3 else 2 if len(g) < 8 else 3, "badges": badges(g, sc),
            "bids": {season_label(y): n for y, n in sorted(sc["bids"].items(), reverse=True)},
            "stats": {"tournaments": n_tourn, "breaks": sum(p["depth"] != "P" for p in g),
                      "finals": sum(p["depth"] == "F" for p in g), "wins": sum(p["depth"] == "F" and p["place"] == 1 for p in g)},
            "top": top, "h": [hist_row(p) for p in rows],
            "b": max(range(len(rows)), key=lambda i: perf_points(rows[i], 0))}


def build_people(perfs: list[dict]) -> tuple[dict[str, list[dict]], dict[tuple, str]]:
    """({name_key: [person, ...] most recent first}, {(tid, ev, eid): pid})."""
    by_key: dict[str, list[dict]] = {}
    for p in perfs:
        by_key.setdefault(p["key"], []).append(p)
    people: dict[str, list[dict]] = {}
    pid_of: dict[tuple, str] = {}
    for key in sorted(by_key):
        built = []
        # pids follow each person's first result, which frozen data never changes, so links survive weekly refreshes
        for i, g in enumerate(sorted(cluster(by_key[key]), key=lambda g: min((p["date"], p["tid"], p["ev"], p["eid"]) for p in g))):
            g.sort(key=lambda p: (p["date"], p["tid"], p["ev"], p["eid"]), reverse=True)
            built.append(person_obj(f"{key}#{i}", g))
            for p in g:
                pid_of[(p["tid"], p["ev"], p["eid"])] = f"{key}#{i}"
        people[key] = sorted(built, key=lambda p: (p["last"], p["n"]), reverse=True)
    return people, pid_of


# ---------------------------------------------------------------- export

def dump(path: Path, obj: Any) -> None:
    path.write_bytes(json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8", "replace"))


def season_boards(perfs: list[dict], people: dict[str, list[dict]], pid_of: dict[tuple, str]) -> dict[str, list[dict]]:
    """Top 100 per season by raw season points (perf_points without the recency multiplier)."""
    by_pid = {p["pid"]: p for ps in people.values() for p in ps}
    best: dict[tuple, dict] = {}
    for p in perfs:
        k = (pid_of[(p["tid"], p["ev"], p["eid"])], p["tid"], p["ev"])
        if k not in best or perf_points(p, 0) > perf_points(best[k], 0):
            best[k] = p
    out = {}
    for y in (CURRENT_SEASON, CURRENT_SEASON - 1):
        pts: Counter = Counter()
        top: dict[str, dict] = {}
        for (pid, _, _), p in best.items():
            if p["season"] == y:
                pts[pid] += perf_points(p, 0)
                if pid not in top or perf_points(p, 0) > perf_points(top[pid], 0):
                    top[pid] = p
        rows = sorted(((round(v, 1), pid) for pid, v in pts.items() if v > 0), key=lambda r: (-r[0], r[1]))[:100]
        out[season_label(y)] = [{"pid": pid, "name": by_pid[pid]["name"], "school": by_pid[pid]["school"], "points": v,
                                 "best": result_label(top[pid]), "tier": by_pid[pid]["tier"]} for v, pid in rows]
    return out


def overall_board(people: dict[str, list[dict]]) -> list[dict]:
    recent = (season_label(CURRENT_SEASON), season_label(CURRENT_SEASON - 1))
    ranked = sorted((p for ps in people.values() for p in ps), key=lambda p: (-p["rating"], -p["n"], p["pid"]))[:250]
    return [{"pid": p["pid"], "name": p["name"], "school": p["school"], "rating": p["rating"], "tier": p["tier"], "n": p["n"],
             "bids": sum(p["bids"].get(s, 0) for s in recent)} for p in ranked]


def sample_chamber(perfs: list[dict], people: dict[str, list[dict]], pid_of: dict[tuple, str], tid: int = TOC_TID) -> dict:
    final = [p for p in perfs if p["tid"] == tid and p["depth"] == "F"]
    ev = Counter(p["ev"] for p in final).most_common(1)
    final = sorted((p for p in final if ev and p["ev"] == ev[0][0]), key=lambda p: (p["place"] or 99, p["name"]))
    year = max((p["date"][:4] for p in final), default="")
    rating = {p["pid"]: p["rating"] for ps in people.values() for p in ps}
    by_name = {p["name"]: rating[pid_of[(tid, p["ev"], p["eid"])]] for p in final}
    strength = chamber_strength(list(by_name.values()), advancing(len(final) + 1))   # the demo adds an anonymous "You" seat
    return {"title": f"{year} Tournament of Champions final".strip(), "names": [p["name"] for p in final], "tid": tid,
            "strength": round(strength, 1)}


def read_optout(path: Path = HERE / "optout.txt") -> frozenset[str]:
    """Names (one per line, # comments) whose owners asked to be left out of the site."""
    if not path.exists():
        return frozenset()
    return frozenset(k for line in path.read_text().splitlines() if (k := name_key(line.split("#")[0])))


def export(perfs: list[dict], out: Path, chambers: dict, index_html: Path = HERE / "index.html", assets: Path = HERE / "assets",
           optout: frozenset[str] = frozenset()) -> dict:
    perfs = [p for p in perfs if name_key(p["name"]) not in optout]
    people, pid_of = build_people(perfs)
    shards: list[dict] = [{"n": {}, "fl": {}} for _ in range(SHARDS)]
    for key, ps in people.items():
        shards[shard_of(key)]["n"][key] = ps
        toks = key.split()
        if len(toks) >= 3:
            fl = f"{toks[0]} {toks[-1]}"
            shards[shard_of(fl)]["fl"].setdefault(fl, []).append(key)
    shutil.rmtree(out / "data", ignore_errors=True)
    shutil.rmtree(out / "assets", ignore_errors=True)
    (out / "data" / "p").mkdir(parents=True)
    for i, s in enumerate(shards):
        dump(out / "data" / "p" / f"{i:02x}.json", s)
    dump(out / "data" / "names.json", [[k, ps[0]["name"]] for k, ps in people.items()])
    built = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    dump(out / "data" / "rankings.json", {"built_at": built, "overall": overall_board(people), "seasons": season_boards(perfs, people, pid_of)})
    dump(out / "data" / "chambers.json", {**chambers, "thresholds": CHAMBER_THRESHOLDS})
    dump(out / "data" / "sample.json", sample_chamber(perfs, people, pid_of))
    meta = {"version": 1, "built_at": built,
            "seasons": [season_label(y) for y in range(FIRST_SEASON, CURRENT_SEASON + 1)], "current_season": season_label(CURRENT_SEASON),
            "tournaments": len({p["tid"] for p in perfs}), "people": sum(map(len, people.values())), "perfs": len(perfs),
            "shards": SHARDS, "chamber_thresholds": CHAMBER_THRESHOLDS,
            "key_tests": [[raw, name_key(raw)] for raw in KEY_TESTS], "hash_tests": [[k, f"{shard_of(k):02x}"] for k in HASH_TESTS],
            "scoring": {"weight": TIER_WEIGHT, "depth": DEPTH_PTS, "place": [PLACE_BONUS[i] for i in sorted(PLACE_BONUS)], "bid": BID_BONUS,
                        "prelim_max": PRELIM_MAX, "season_mult": [SEASON_MULT[i] for i in sorted(SEASON_MULT)], "topk": TOPK, "decay": DECAY,
                        "scale": SCALE, "local": LOCAL_WEIGHT},
            "files": {"rankings": "data/rankings.json", "chambers": "data/chambers.json", "sample": "data/sample.json"}}
    dump(out / "data" / "meta.json", meta)
    shutil.copyfile(index_html, out / "index.html")
    if assets.is_dir():
        shutil.copytree(assets, out / "assets")
    else:
        (out / "assets").mkdir()
    return meta


# ---------------------------------------------------------------- calibration

def chamber_strengths(perfs: list[dict]) -> tuple[list[float], int, int]:
    """Strength of every real CAL_SEASON circuit-228 prelim chamber as a user would have pasted it: members are rated only
    from perfs dated before the tournament, counted from CAL_SEASON, with the default bare-name pick. Also returns
    (members rated, members total)."""
    global CURRENT_SEASON
    CURRENT_SEASON = CAL_SEASON
    url = f"{BASE}/tourns?circuit={CIRCUIT}&startAfter={CAL_SEASON}-07-01T00:00:00Z&startBefore={CAL_SEASON + 1}-07-01T00:00:00Z&limit=500&publishedResults=true"
    by_day: dict[str, list[list[str]]] = {}
    for t in cached(f"tourns-{CAL_SEASON}", url, PERMANENT) or []:
        if t.get("hidden"):
            continue
        tid = t["id"]
        for ev in congress_events(cached(f"results-{tid}", f"{BASE}/tourns/{tid}/results", PERMANENT) or {}):
            data = {s["id"]: _rows(cached(f"set-{s['id']}", f"{BASE}/tourns/{tid}/results/{s['id']}", PERMANENT))
                    for r, _, s in plan(ev) if r == "base" and s["tag"] == "chamber"}
            size = {sid: len({(x.get("Entry") or {}).get("id") for x in rows}) for sid, rows in data.items()}
            for sid, rows in data.items():
                if size[sid] < 0.6 * max(size.values()):
                    continue
                chambers: dict[Any, dict[int, str]] = {}
                for x in rows:
                    if (x.get("Entry") or {}).get("id"):
                        chambers.setdefault(x.get("section"), {})[x["Entry"]["id"]] = name_key(x["Entry"].get("name") or "")
                by_day.setdefault(t["start"][:10], []).extend(list(c.values()) for c in chambers.values() if len(c) >= MIN_CHAMBER)
    out: list[float] = []
    rated = total = 0
    for day, chambers in sorted(by_day.items()):
        need = {k for c in chambers for k in c}
        people, _ = build_people([p for p in perfs if p["date"] < day and p["key"] in need])
        for keys in chambers:
            rs = [max(ps, key=lambda p: (p["last"], p["n"]))["rating"] if (ps := people.get(k)) else None for k in keys]
            rated += sum(r is not None for r in rs)
            total += len(rs)
            out.append(chamber_strength(rs, advancing(len(rs))))
    return out, rated, total


def calibrate(perfs: list[dict]) -> None:
    strengths, rated, total = chamber_strengths(perfs)
    if len(strengths) < 100:
        sys.exit(f"only {len(strengths)} chambers found; is the {season_label(CAL_SEASON)} circuit-228 data in cache/?")
    cuts = statistics.quantiles(strengths, n=100, method="inclusive")
    print(f"{len(strengths)} chambers, {rated}/{total} members matched to a rating, min {min(strengths):.1f} max {max(strengths):.1f} mean {statistics.fmean(strengths):.1f}")
    print("percentile: " + "  ".join(f"p{q}={cuts[q - 1]:.1f}" for q in (5, 10, 20, 30, 45, 50, 60, 70, 80, 90, 95, 99)))
    print(f"CHAMBER_THRESHOLDS = {[round(cuts[q - 1], 1) for q in (20, 45, 70, 90)]}")
    dump(CHAMBERS_FILE, {"strengths": sorted(round(x, 1) for x in strengths), "source": f"{len(strengths)} real {season_label(CAL_SEASON)} national-circuit prelim chambers"})
    print(f"wrote {CHAMBERS_FILE.relative_to(HERE)} (commit it: --export reads it, CI has no raw cache for {season_label(CAL_SEASON)})")


def load_chambers() -> dict:
    try:
        return json.loads(CHAMBERS_FILE.read_text())
    except (OSError, ValueError):
        sys.exit(f"{CHAMBERS_FILE.name} missing; run --calibrate once with the {season_label(CAL_SEASON)} cache/ and commit it")


# ---------------------------------------------------------------- selfcheck

def _rs(sid: int, tag: str, label: str, rows: list[dict]) -> list[dict]:
    return [{"id": sid, "tag": tag, "label": label, "results": rows}]


def _row(eid: int, name: str, **kw: Any) -> dict:
    return {"Entry": {"id": eid, "name": name}, "School": {"name": "Sch"}, **kw}


def check_extraction() -> None:
    labels = ["Final Chamber Results", "Finals Chamber Results", "Congress Finals Chamber Results", "Semi  Chamber Results",
              "Sem  Chamber Results", "Semifinal Chamber Results", "Semifinals Chamber Results", "Semis Chamber Results",
              "Qtr  Chamber Results", "Qrtr Chamber Results", "Prelim Chamber Results", "Round  Chamber Results",
              "Congress PM Chamber Results", "R Chamber Results", "Rd Chamber Results", "Exhib Chamber Results",
              "PO Final Chamber Results", "Consolation Final Chamber Results"]
    assert [stage_of(x) for x in labels] == list("FFFSSSSSQQPPPPPP") + [None, None]
    assert [infer_tier(n) for n in (6, 15, 16, 60, 120)] == ["T1", "T2", "T2", "T3", "T4"]
    idx = {"1": {"type": "congress", "level": "open", "name": "Congress", "abbr": "CD"},
           "2": {"type": "congress", "level": "open", "name": "Congressional Debate (MS)", "abbr": "CDMS"},
           "3": {"type": "congress", "level": "open", "name": "Congress", "abbr": "CONRR"},
           "4": {"type": "congress", "level": "jv", "name": "Congress", "abbr": "CDJV"},
           "5": {"type": "debate", "level": "open", "name": "LD", "abbr": "LD"}}
    assert [e["abbr"] for e in congress_events(idx)] == ["CD"]

    stub = lambda i, tag, label, **kw: {"id": i, "tag": tag, "label": label, **kw}
    ev = {"ResultSets": [stub(1, "chamber", "Final Chamber Results"), stub(2, "chamber", "Semi Chamber Results"),
                         stub(3, "seed", "Prelim Seeds"), stub(4, "circuit", "TOC Qualifying Bids", Circuit={"id": 228}),
                         stub(5, "chamber", "Consolation Final Chamber Results"), stub(6, "chamber", "PO Final Chamber Results")]}
    pl = plan(ev)
    assert sorted((r, s["id"]) for r, _, s in pl) == [("base", 3), ("bid", 4), ("elim", 1), ("elim", 2)], pl
    fetched = {
        1: _rs(1, "chamber", "F", [_row(1, "Ann", rank=1, section="1"), _row(2, "Bo", rank=2, section="1"), _row(3, "Cy", rank=3, section="1")]),
        2: _rs(2, "chamber", "S", [_row(1, "Ann", rank=1, section="1"), _row(4, "Di", rank=2, section="1")]),
        3: _rs(3, "seed", "Seeds", [_row(i, n, rank=i, percentile=str(pc)) for i, n, pc in
                                    [(1, "Ann", 90), (2, "Bo", 80), (3, "Cy", 70), (4, "Di", 60), (5, "Ed", 10)]]),
        4: _rs(4, "circuit", "Bids", [_row(1, "Ann", values={}), _row(5, "Ed", values={})])}
    p = {x["name"]: x for x in extract(None, pl, fetched)}
    assert len(p) == 5 and all(x["field"] == 5 and x["tier"] == "T1" for x in p.values()), p
    assert (p["Ann"]["depth"], p["Ann"]["place"], p["Ann"]["bid"]) == ("F", 1, True)
    assert (p["Cy"]["depth"], p["Cy"]["place"]) == ("F", 3) and (p["Di"]["depth"], p["Di"]["place"]) == ("S", None)
    assert (p["Ed"]["depth"], p["Ed"]["bid"]) == ("Q", True), p["Ed"]
    assert abs(p["Di"]["pct"] - 0.6) < 1e-9
    assert extract("TOC", pl, fetched)[0]["tier"] == "TOC"

    fp = {"ResultSets": [stub(9, "final", "Final Places")]}
    pl = plan(fp)
    assert [(r, s["id"]) for r, _, s in pl] == [("final-places", 9)]
    rows = [_row(1, "A", place="1st", percentile="99"), _row(2, "B", place="Semi", percentile="80"), _row(3, "C", place="Prelim", percentile="10")]
    p = {x["name"]: x for x in extract(None, pl, {9: _rs(9, "final", "FP", rows)})}
    assert (p["A"]["depth"], p["A"]["place"], p["B"]["depth"], p["C"]["depth"]) == ("F", 1, "S", "P") and p["A"]["tier"] == "local"
    rows = [_row(1, "A", place="1st", rank=1, roundName=3), _row(2, "B", place="14th-T", rank=15, roundName=3),
            _row(2, "B", place="Co-Champion", rank=14, roundName=3), _row(2, "B", place="Prelim", rank=1, roundName=3),
            _row(3, "C", place="16th-Tie", rank=17, roundName=3), _row(4, "D", place="Prelim", roundName=2)]
    p = {x["name"]: x for x in extract(None, pl, {9: _rs(9, "final", "FP", rows)})}
    assert [(p[k]["depth"], p[k]["place"]) for k in "ABCD"] == [("F", 1), ("F", 14), ("F", 16), ("P", None)], p
    rows = [_row(i, f"N{i}", place=ordinal(i), rank=i, roundName=3, percentile=str(100 - i)) for i in range(1, 16)]
    p = extract(None, pl, {9: _rs(9, "final", "FP", rows)})
    assert {x["depth"] for x in p} == {"P"} and all(x["pct"] for x in p), "a set that ranks every entrant has no finalists"
    pl1 = plan({"ResultSets": [stub(1, "chamber", "Finals Chamber Results"), stub(2, "chamber", "Prelim Chamber Results")]})
    same = lambda i: _rs(i, "chamber", "x", [_row(k, f"M{k}", rank=1, section="1") for k in range(1, 5)])
    assert {x["place"] for x in extract(None, pl1, {1: same(1), 2: same(2)})} == {None}, "all-rank-1 final has no places"

    bk = {"ResultSets": [stub(11, "chamber", "Rd Chamber Results"), stub(12, "chamber", "Semis Chamber Results"),
                         stub(13, "chamber", "Exhib Chamber Results")]}
    pl = plan(bk)
    assert sorted((r, s["id"]) for r, _, s in pl) == [("base", 11), ("base", 13), ("elim", 12)], pl
    names = "abcdef"
    fetched = {
        11: _rs(11, "chamber", "Rd", [_row(i, names[i - 1], rank=i, section="1", roundName=1) for i in range(1, 7)]),
        12: _rs(12, "chamber", "Semis", [_row(i, names[i - 1], rank=i, section="1", roundName=2) for i in range(1, 5)]),
        13: _rs(13, "chamber", "Exhib", [_row(i, names[i - 1], rank=i, section="1", roundName=3) for i in (1, 2)])}
    p = {x["name"]: x for x in extract(None, pl, fetched)}
    assert len(p) == 6 and p["a"]["field"] == 6
    assert (p["a"]["depth"], p["a"]["place"], p["b"]["depth"], p["b"]["place"]) == ("F", 1, "F", 2), p
    assert (p["c"]["depth"], p["e"]["depth"]) == ("S", "P")
    assert short_name(1, "54th Annual Harvard National Speech and Debate Tournament") == "Harvard"
    assert short_name(1, "Barkley Forum for High Schools") == "Barkley Forum" and short_name(36156, "x") == "TOC"
    assert short_name(2, "Tournament of Champions Digital Series") == "Tournament of Champions"
    cases = {"Star Valley Tournament of the Brave": "Star Valley", "Digital Speech and Debate e Championship": "Digital Championship",
             "Tournament of Lights": "Tournament of Lights", "LHSSL State Tournament of Champions": "LHSSL State of Champions",
             "Dallastown End of Summer Practice Rounds": "Dallastown End", "I Have a Dream Tournament": "I Have a Dream",
             "Lewis and Clark Invitational": "Lewis and Clark", "2026 University of Houston Cougar Classic": "University of Houston",
             "UNT John S Gossett Memorial High School Tournament": "UNT John", "A Day of Honor in Othello": "Day of Honor",
             "PCFL 1 at La Salle": "PCFL 1", "Lakeview CFL of Erie": "Lakeview CFL of Erie", "TOC Digital Series": "TOC Digital Series",
             "2021 Tournament of Champions": "TOC", "NSDA Nationals": "NSDA Nats", "NCFL Grand Nationals": "NCFL"}
    for name, want in cases.items():
        assert short_name(1, name) == want, (name, short_name(1, name))
    frozen = sorted(PERFS_DIR.glob("*.json.gz"))
    for f in frozen:
        for tname, _ in json.loads(gzip.decompress(f.read_bytes()))["tourns"].values():
            sn = short_name(1, tname).split()
            assert sn and sn[-1].lower() not in CONNECTORS and (sn[0].lower() not in CONNECTORS or len(sn) > 1) and len(" ".join(sn)) <= 40, (tname, sn)

    tiers = {"53rd Annual Tournament of Champions": "TOC", "2021 Tournament of Champions": "TOC", "National Speech and Debate Tournament": "NSDA",
             "2021 NSDA Nationals": "NSDA", "NCFL Grand Nationals": "NCFL", "Harvard National Speech and Debate Tournament": None,
             "Middle School Tournament of Champions": None, "10th Annual Middle School TOC hosted by UK": None,
             "TOC Digital Speech and Debate Series 1": None, "NYPDL National Tournament of Champions": None,
             "National Speech and Debate Season Opener": None, "NSDA Middle School National Tournament": None,
             "NCFL Middle School National Tournament": None, "LHSSL State Tournament of Champions": None}
    for name, tier in tiers.items():
        assert tier_override({"id": 1, "name": name}) == tier, name
    assert tier_override({"id": 36156, "name": "x"}) == "TOC"


def _pf(tier: str, depth: str, ago: int, place: int | None = None, bid: bool = False, field: int | None = None) -> dict:
    return {"tier": tier, "depth": depth, "place": place, "bid": bid, "field": field, "pct": None, "season": CURRENT_SEASON - ago}


def check_scoring() -> None:
    boss = [_pf("TOC", "F", 1, 3), _pf("T4", "F", 1, 1, True), _pf("NSDA", "F", 1, 8), _pf("T3", "F", 1, 5, True), _pf("T3", "S", 0, bid=True)]
    hunter = [_pf("T3", "S", 1, bid=True), _pf("T2", "F", 1, 4, True), _pf("T1", "F", 1, 9), _pf("local", "F", 0, 1, field=60)]
    local = [_pf("local", "F", 1, 1, field=40), _pf("local", "F", 1, 1, field=40), _pf("local", "F", 0, 2, field=40), _pf("T3", "P", 1)]
    sb, sh, sl = score_person(boss), score_person(hunter), score_person(local)
    assert abs(sb["rating"] - 90.5) < 0.1 and abs(sl["rating"] - 30.4) < 0.1, (sb["rating"], sl["rating"])
    assert (sb["tier"], sh["tier"], sl["tier"]) == ("Final Boss", "TOC-Bound", "Local Menace") and sh["rating"] >= 60
    assert score_person([]) is None and tier_label(None, 1.0) == "Mystery Box"
    assert tier_label(20, 0.8) == "Circuit Regular" and tier_label(5, 1.0) == "Free Real Estate"
    one = score_person([{**_pf("local", "P", 0, field=20), "pct": 0.5}])
    assert one["tier"] == "Free Real Estate" and 0 < one["rating"] < 10, one
    assert score_person([_pf("T1", "P", 0, bid=True)])["rating"] >= 45
    assert score_person([_pf("T1", "P", 0, bid=True), _pf("T2", "P", 0, bid=True)])["rating"] >= 60
    assert score_person([_pf("TOC", "S", 0)])["auto_qual"] and not score_person([_pf("NCFL", "F", 0, 7)])["auto_qual"]
    assert [perf_points(_pf("TOC", "F", a, 1), a) for a in (0, 3, 6, 7)] == [72.0, 25.2, 3.6, 0.0]
    assert chamber_strength([12] * 15, 5) == 12
    chamber = [90.5, 56.6, 52, 40, 33, 30.4, 28, 22, 18, 12, 8, 5, 4.2, None, None]
    assert abs(chamber_strength(chamber, advancing(len(chamber) + 1)) - 44.7) < 0.3
    assert ordinal(1) == "1st" and ordinal(12) == "12th" and ordinal(23) == "23rd"
    lab = result_label({"depth": "F", "place": 1, "bid": True, "tourn": "Harvard", "date": "2026-02-14"})
    assert lab == "1st @ Harvard '26", lab


def check_cache() -> None:
    global CACHE, OFFLINE, fetch_json
    saved = CACHE, OFFLINE, fetch_json
    calls: list[str] = []
    answers: list[Any] = [(404, None), (200, {"a": 1}), FetchError("down")]

    def fake(url: str) -> tuple[int, Any]:
        calls.append(url)
        a = answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a

    with tempfile.TemporaryDirectory() as d:
        CACHE, OFFLINE, fetch_json = Path(d), False, fake
        try:
            assert cached("x", "u1", PERMANENT) is None and cached("x", "u1", PERMANENT) is None and len(calls) == 1
            assert cached("y", "u2", HALF_DAY) == {"a": 1} and cached("y", "u2", HALF_DAY) == {"a": 1} and len(calls) == 2
            assert cached("y", "u2", lambda d: 0.0) == {"a": 1} and len(calls) == 3
            OFFLINE = True
            assert cached("y", "u2", lambda d: 0.0) == {"a": 1} and len(calls) == 3
            try:
                cached("missing", "u3", PERMANENT)
                raise AssertionError("offline miss must raise")
            except FetchError:
                pass
            assert results_ttl(datetime.now(timezone.utc) - timedelta(days=90))({}) is None
            assert results_ttl(datetime.now(timezone.utc) - timedelta(days=10))({}) == 12 * 3600.0
            assert results_ttl(datetime.now(timezone.utc) - timedelta(days=10))({"1": 1}) is None
        finally:
            CACHE, OFFLINE, fetch_json = saved


def check_keys() -> None:
    assert name_key("Diego Pa-Ortiz") == name_key("Diego Pa Ortiz") == "diego pa ortiz"
    assert name_key("José O'Brien") == "jose obrien" and name_key("D’Angelo  Smith") == "dangelo smith"
    assert name_key("Mary–Kate Smith Jr.") == "mary kate smith jr" and name_key("ﬁsh") == "fish"
    assert [shard_of(k) for k in ("", "a", "foobar")] == [0xC5, 0x2C, 0x68]   # FNV-1a 32 vectors 811c9dc5, e40c292c, bf9cf968


def _mp(name: str, school: str, tid: int, eid: int, ev: int = 1, **kw: Any) -> dict:
    return {"key": name_key(name), "name": name, "school": school, "tid": tid, "ev": ev, "eid": eid, "tname": f"T{tid}", "tourn": f"T{tid}",
            "date": f"2026-0{tid}-10", "season": 2025, "tier": "T2", "field": 30, "depth": "Q", "place": None, "bid": False, "pct": 0.5, **kw}


def check_cluster() -> None:
    kumar = [_mp("Pranika Kumar", "Edina High School", 1, 2), _mp("Pranika Kumar", "Kumar Independent", 2, 1),
             _mp("Pranika Kumar", "Edina HS", 3, 4)]
    assert [len(g) for g in cluster(kumar)] == [3], "independent and school variants are one person"
    apart = [_mp("Emily Lin", "Castilleja School", 1, 1), _mp("Emily Lin", "Lynbrook High School", 3, 2)]
    assert [len(g) for g in cluster(apart)] == [2], "different schools without a same-event twin stay one person"
    lin = [_mp("Emily Lin", "Castilleja School", 3, 1), _mp("Emily Lin", "Lynbrook High School", 3, 2)]
    assert sorted(len(g) for g in cluster(lin)) == [1, 1], "two same-name entries in one event are two people"
    twins = [_mp("Sam Lee", "Lincoln High School", 1, 1), _mp("Sam Lee", "Lincoln East High School", 1, 2)]
    assert len(cluster(twins)) == 2, "same-event twins never merge, even with overlapping school tokens"
    assert len(cluster([_mp("Sam Lee", "Lincoln High School", 1, 1), _mp("Sam Lee", "Lincoln East High School", 2, 1)])) == 1
    two = [_mp("Ann Wu", "Alpha Academy", 1, 1), _mp("Ann Wu", "Alpha Academy", 2, 1), _mp("Ann Wu", "Beta Prep", 3, 1),
           _mp("Ann Wu", "Alpha Academy", 3, 2), _mp("Ann Wu", "Wu Indep.", 4, 1)]
    big = max(cluster(two), key=len)
    assert sorted(len(g) for g in cluster(two)) == [1, 4] and any(p["school"] == "Wu Indep." for p in big)
    assert [len(g) for g in cluster([_mp("Solo Kid", "Solo Independent", 1, 1), _mp("Solo Kid", "Other Independent", 2, 1)])] == [2]
    people, pid_of = build_people(apart)
    assert [p["pid"] for p in people["emily lin"]] == ["emily lin#0"] and pid_of[(1, 1, 1)] == "emily lin#0"
    people, pid_of = build_people(lin)
    assert sorted(p["pid"] for p in people["emily lin"]) == ["emily lin#0", "emily lin#1"] and pid_of[(3, 1, 1)] != pid_of[(3, 1, 2)]
    split = lambda *extra: {p["school"]: p["pid"] for p in build_people(lin + list(extra))[0]["emily lin"]}
    assert split() == split(_mp("Emily Lin", "Castilleja School", 5, 1)), "a new result must not move a pid to another person"


def check_freeze_and_export() -> None:
    perfs = [_mp("Maria Annie Domingues", "Some School", 1, 7, depth="F", place=1, bid=True), _mp("Zoë Müller", "Kumar Independent", 2, 1),
             _mp("Zoë Müller", "Edina High School", 3, 2, pct=None), _mp("Diego Pa-Ortiz", "Archbishop Mitty", 1, 8, tier="local")]
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        f = write_frozen(2025, perfs, d / "perfs")
        assert f.name == "2025-26.json.gz"
        first = f.read_bytes()
        assert write_frozen(2025, list(reversed(perfs)), d / "perfs").read_bytes() == first, "frozen files must be deterministic"
        key = lambda p: (p["tid"], p["ev"], p["eid"])
        assert sorted(read_frozen(f), key=key) == sorted(perfs, key=key)
        assert len(load_perfs([2025], d / "perfs")) == 4

        out = d / "site"
        meta = export(read_frozen(f), out, {"strengths": [10.0, 20.0, 30.0], "source": "3 real test chambers"})
        assert json.loads((out / "data" / "meta.json").read_text()) == meta
        assert meta["version"] == 1 and meta["shards"] == 256 and meta["people"] == 3 and meta["perfs"] == 4 and meta["tournaments"] == 3
        assert meta["files"] == {"rankings": "data/rankings.json", "chambers": "data/chambers.json", "sample": "data/sample.json"}
        assert all((out / meta["files"][k]).is_file() for k in meta["files"]) and (out / "assets").is_dir()
        assert len(meta["chamber_thresholds"]) == 4 and meta["chamber_thresholds"] == sorted(meta["chamber_thresholds"])
        assert all(name_key(raw) == k for raw, k in meta["key_tests"]) and len(meta["key_tests"]) >= 12 and len(meta["hash_tests"]) >= 6
        assert meta["seasons"][0] == "2020-21" and meta["current_season"] == season_label(CURRENT_SEASON)
        files = sorted((out / "data" / "p").iterdir())
        assert [x.name for x in files] == [f"{i:02x}.json" for i in range(256)]
        loaded = {x.name[:2]: json.loads(x.read_text()) for x in files}
        placed = {k: s for s, d2 in loaded.items() for k in d2["n"]}
        assert sorted(placed) == ["diego pa ortiz", "maria annie domingues", "zoe muller"]
        assert all(int(placed[k], 16) == shard_of(k) for k in placed)
        fl = f"{shard_of('maria domingues'):02x}"
        assert loaded[fl]["fl"] == {"maria domingues": ["maria annie domingues"]}
        mp = loaded[placed["maria annie domingues"]]["n"]["maria annie domingues"][0]
        assert mp["pid"] == "maria annie domingues#0" and mp["school"] == "Some School" and mp["bids"] == {"2025-26": 1}
        assert mp["top"][0] == {"label": "1st @ T1 '26", "tier": "T2", "bid": True} and mp["stats"]["wins"] == 1 and 1 <= mp["confidence"] <= 3
        zoe = loaded[placed["zoe muller"]]["n"]["zoe muller"]
        assert len(zoe) == 1 and zoe[0]["name"] == "Zoë Müller" and zoe[0]["schools"] == ["Edina High School", "Kumar Independent"]
        names = json.loads((out / "data" / "names.json").read_text())
        assert names == [["diego pa ortiz", "Diego Pa-Ortiz"], ["maria annie domingues", "Maria Annie Domingues"], ["zoe muller", "Zoë Müller"]]
        assert (out / "index.html").read_bytes() == (HERE / "index.html").read_bytes()


def check_v2_export() -> None:
    ly = CURRENT_SEASON - 1
    day = lambda m: f"{CURRENT_SEASON}-0{m}-10"
    mk = lambda name, school, tid, eid, **kw: _mp(name, school, tid, eid, season=ly, date=day(tid), **kw)
    toc = [mk(f"Final {i}", "Sch", TOC_TID, i, tier="TOC", depth="F", place=i, field=170, tname="Tournament of Champions", tourn="TOC")
           for i in (3, 1, 2)] + [mk("Final 1", "Sch", TOC_TID, 9, ev=2, tier="TOC", depth="Q", tname="Tournament of Champions", tourn="TOC")]
    star = [mk("Star Player", "Sch", 1, 1, tourn="Swing", depth="F", place=1, bid=True, tier="T3", field=100),
            mk("Star Player", "Sch", 1, 2, tourn="Swing", depth="S", tier="T3", field=100),
            mk("Star Player", "Sch", 2, 1, tourn="Swing", depth="F", place=2, tier="T3", field=100),
            mk("Star Player", "Sch", 3, 1, tourn="Local Cup", depth="F", place=4, tier="local", field=20),
            mk("Star Player", "Sch", 4, 1, tourn="Swing 2", depth="O", tier="T2", field=50),
            {**mk("Star Player", "Sch", 5, 1, tourn="Old", depth="F", place=1, tier="T3", field=100), "date": f"{ly}-02-10", "season": ly - 1}]
    weak = [mk("Weak Kid", "Sch", 1, 7, depth="P", pct=0.5, field=100)]
    perfs = toc + star + weak
    chambers = {"strengths": [12.3, 40.1], "source": "2 real test chambers"}
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "site"
        (Path(d) / "assets").mkdir()
        (Path(d) / "assets" / "core.js").write_text("x")
        export(perfs, out, chambers, assets=Path(d) / "assets")
        assert (out / "assets" / "core.js").read_text() == "x"
        people, pid_of = build_people(perfs)
        star_p = people["star player"][0]
        h = star_p["h"]
        assert [r[1] for r in h] == [4, 3, 2, 1, 5] and h[3] == [day(1), 1, "Swing", "T3", "F", 1, 1, 100, season_label(ly)], h
        assert h[1][3] == "L" and h[1][5] == 4 and h[0][4] == "O" and h[0][5] is None and h[4][8] == season_label(ly - 1)
        assert all(len(r) == 9 and r[4] in "POQSF" and r[6] in (0, 1) for r in h) and [r[0] for r in h] == sorted((r[0] for r in h), reverse=True)
        labels = [t["label"] for t in star_p["top"]]
        venues = [l.split(" @ ")[1] for l in labels]
        assert len(venues) == len(set(venues)) == 3 and sum(v.startswith("Swing '") for v in venues) == 1, labels
        assert len(people["final 1"][0]["h"]) == 2 and [r[1] for r in people["final 1"][0]["h"]] == [TOC_TID, TOC_TID]
        assert len(best_per_event([p for p in toc if p["name"] == "Final 1"])) == 2

        data = lambda n: json.loads((out / "data" / n).read_text())
        rk = data("rankings.json")
        assert rk["built_at"] == data("meta.json")["built_at"] and len(rk["overall"]) <= 250
        assert [r["rating"] for r in rk["overall"]] == sorted((r["rating"] for r in rk["overall"]), reverse=True)
        assert rk["overall"][0]["pid"] == "star player#0" and rk["overall"][0]["bids"] == 1 and rk["overall"][0]["n"] == 5
        assert set(rk["overall"][0]) == {"pid", "name", "school", "rating", "tier", "n", "bids"}
        cur, last = (season_label(y) for y in (CURRENT_SEASON, ly))
        assert list(rk["seasons"]) == [cur, last] and rk["seasons"][cur] == []
        board = rk["seasons"][last]
        assert [r["points"] for r in board] == sorted((r["points"] for r in board), reverse=True)
        row = next(r for r in board if r["pid"] == "star player#0")
        assert set(row) == {"pid", "name", "school", "points", "best", "tier"} and row["best"].startswith("1st @ Swing")
        want = sum(perf_points(p, 0) for p in best_per_event([p for p in star if p["season"] == ly]))
        assert abs(row["points"] - want) < 0.06 and want > perf_points(star[0], 1), "season points carry no recency multiplier"
        assert "weak kid#0" in {r["pid"] for r in board}

        ch = data("chambers.json")
        assert ch == {"strengths": [12.3, 40.1], "thresholds": CHAMBER_THRESHOLDS, "source": "2 real test chambers"}
        sm = data("sample.json")
        assert sm == {"title": f"{CURRENT_SEASON} Tournament of Champions final", "names": ["Final 1", "Final 2", "Final 3"], "tid": TOC_TID,
                      "strength": round(chamber_strength([people[f"final {i}"][0]["rating"] for i in (1, 2, 3)], advancing(4)), 1)}, sm
        assert star_p["h"][star_p["b"]][1] == 1 and data("meta.json")["scoring"]["place"] == [12, 8, 6, 4, 3, 2]
        (Path(d) / "optout.txt").write_text("Star Player  # asked to be removed\n\n")
        export(perfs, out, chambers, assets=Path(d) / "assets", optout=read_optout(Path(d) / "optout.txt"))
        assert "star player" not in {k for k, _ in data("names.json")} and all(r["pid"] != "star player#0" for r in data("rankings.json")["overall"])
    if CHAMBERS_FILE.exists():
        real = json.loads(CHAMBERS_FILE.read_text())
        st = real["strengths"]
        assert len(st) >= 100 and st == sorted(st) and real["source"].startswith(f"{len(st)} real ")
        cuts = statistics.quantiles(st, n=100, method="inclusive")
        assert all(abs(cuts[q - 1] - t) < 0.2 for q, t in zip((20, 45, 70, 90), CHAMBER_THRESHOLDS)), "perfs/chambers.json disagrees with CHAMBER_THRESHOLDS"


def selfcheck() -> None:
    for fn in (check_keys, check_extraction, check_scoring, check_cache, check_cluster, check_freeze_and_export, check_v2_export):
        fn()
    print("selfcheck OK")


def main() -> None:
    global OFFLINE
    ap = argparse.ArgumentParser(description="Is My Chamber Stacked? static data builder")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--crawl", action="store_true")
    g.add_argument("--freeze", action="store_true")
    g.add_argument("--export", metavar="DIR")
    g.add_argument("--calibrate", action="store_true")
    g.add_argument("--selfcheck", action="store_true")
    args = ap.parse_args()
    if args.selfcheck:
        return selfcheck()
    seasons = list(range(FIRST_SEASON, CURRENT_SEASON + 1))
    if args.crawl:
        setup_tls()
        OFFLINE = False
        CACHE.mkdir(exist_ok=True)
        try:
            scan([y for y in seasons if not frozen_path(y, PERFS_DIR).exists()])
        except Stop as e:
            sys.exit(f"crawl stopped: {e}")
    elif args.freeze:
        for y in seasons[:-1]:
            if frozen_path(y, PERFS_DIR).exists():
                log(f"{frozen_path(y, PERFS_DIR).name} exists, kept")
            elif perfs := scan([y]):
                log(f"froze {write_frozen(y, perfs, PERFS_DIR)}")
            else:
                sys.exit(f"no perfs for {season_label(y)}; run --crawl first")
    elif args.calibrate:
        calibrate(load_perfs(seasons, PERFS_DIR))
    else:
        meta = export(load_perfs(seasons, PERFS_DIR), Path(args.export), load_chambers(), optout=read_optout())
        log(f"exported {meta['tournaments']} tournaments, {meta['people']} people, {meta['perfs']} perfs to {args.export}")


if __name__ == "__main__":
    main()
