"use strict";
/* Home page, the paste -> confirm -> report flow, and shared read-only reports (#/report?r=...). */
(() => {
const { el, nameKey } = CS;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

const CHAMBER_BLURB = {
  "Open Season": "Bring a snack. This one's yours to lose.",
  "Manageable": "A few real names. Mostly vibes.",
  "Spicy": "Some people in here have actually read the docket.",
  "Stacked": "A semis chamber wearing a prelim costume.",
  "Group of Death": "Who scheduled this. Seriously.",
};
const CHAMBER_LABELS = Object.keys(CHAMBER_BLURB);
const chamberLight = label => label === "Stacked" || label === "Group of Death" ? "red" : label === "Spicy" ? "amber" : "green";
const TIER_BLURB = Object.fromEntries(CS.TIERS.map(t => [t.name, t.blurb]));
const TIER_COLOR = Object.fromEntries(CS.TIERS.map(t => [t.name, t.color]));
const TIER_ORDER = CS.TIERS.map(t => t.name);
const FRIED = [
  ["Raw", "You're the problem in this room."],
  ["Lightly Toasted", "Speak early, speak often."],
  ["Golden Brown", "Very breakable. Bring your best authorship."],
  ["Crispy", "You'll need a PO-level session."],
  ["Deep Fried", "Pray for a friendly parli."],
  ["Charcoal", "Character-building chamber."],
];
const LEVELS = [["Novice", 5], ["Local", 18], ["Circuit", 35], ["Bid", 50], ["TOC", 70]];
const LIGHT = { "Problem": "red", "Coin flip": "amber", "You've got this": "green" };
const SOURCE = {
  history: "from your Tabroom history",
  override: "from the level you picked",
  assumed: "assumed, because we couldn't find you on Tabroom",
};
const SOURCE_RO = {
  history: "from their Tabroom history",
  override: "from the level they picked",
  assumed: "assumed, because we couldn't find them on Tabroom",
};
const MAX_SHARE = 40, MAX_LINK = 16000;

let known = null;
async function loadNames() {
  const names = await CS.names();
  known ||= new Set(names.map(r => r[0]));
  return names;
}

/* Paste parsing (port of app.py parse_paste) */
const PARTICLES = new Set(["de", "del", "della", "di", "da", "dos", "das", "du", "van", "von", "der", "den", "la", "le", "bin", "ibn", "al", "el", "y"]);
const NOISE = /^(ch\.?|chamber|location|judges?|entries|session\b.*|start time.*|rooms with.*|judges with gavels.*|.*\bround \d+$|chamber \d+|room\b.*)$/i;
const ROOM = /^[A-Z]{1,5}[ -]?\d{1,4}[A-Z]?$/;
const SCHOOL_CODE = /^[A-Z]{2,4}$/;
const PO = /\s*(?:[-–—]\s*)?(?:\(\s*[Pp][Oo]\s*\)|\bP\.?O\.?\b|[Pp]residing [Oo]fficer)\s*/g;
const words = s => s.split(/\s+/).filter(Boolean);

function splitRun(tokens, dict) {
  const n = tokens.length;
  const solve = sortedRun => {
    const memo = new Map();
    const best = (i, prev) => {
      if (i === n) return [0, []];
      const mk = `${i}|${prev}`;
      if (memo.has(mk)) return memo.get(mk);
      let out = null;
      for (const [k, base] of [[2, 0], [3, 3], [1, 8], [4, 9]]) {
        if (i + k > n) continue;
        const name = tokens.slice(i, i + k).join(" "), key = nameKey(name);
        let cost = base - (dict.has(key) ? 10 : 0);
        if (k >= 2 && PARTICLES.has(tokens[i + k - 1].toLowerCase())) cost += 6;
        if (k === 3 && PARTICLES.has(tokens[i + 1].toLowerCase())) cost -= 2;
        if (sortedRun && key < prev) cost += 7;
        const sub = best(i + k, key);
        if (!out || cost + sub[0] < out[0]) out = [cost + sub[0], [name, ...sub[1]]];
      }
      memo.set(mk, out);
      return out;
    };
    return best(0, "")[1];
  };
  if (!n) return [];
  const names = solve(true), keys = names.map(nameKey);
  return keys.slice(1).filter((b, j) => keys[j] <= b).length >= 0.85 * (keys.length - 1) ? names : solve(false);
}

function parseItem(raw) {
  let s = raw.replace(/^\s*(?:\d{1,3}[.)]|[-*•·])\s+/, "").trim(), school = null, code = null, m;
  const po = s.search(PO) >= 0;
  s = s.replace(PO, " ").replace(/^[ -]+|[ -]+$/g, "");
  if ((m = s.match(/^(.*?)\s*\((.+)\)\s*$/)) || (m = s.match(/^(.*?)\s+[-–—|]\s+(.+)$/))) [, s, school] = m;
  else if ((m = s.match(/^([^,\s]+),\s*([^,\s]+)$/))) s = `${m[2]} ${m[1]}`;
  let toks = words(s);
  if (toks.length >= 3 && SCHOOL_CODE.test(toks[0])) [code, ...toks] = toks;
  if (!toks.length || toks.length > 5 || !/\p{L}/u.test(s)) return null;
  return { name: toks.join(" "), school, school_code: code, po };
}

function parsePaste(text, dict) {
  text = text.normalize("NFKC").replace(/\u00a0/g, " ").replace(/\u200b/g, "");
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).map(l => l.trimEnd());
  const isRun = c => words(c).length >= 8 && !/[,()|–—]|\s-\s/.test(c) && !NOISE.test(c);
  const schematic = lines.some(ln => ln.split("\t").some(c => isRun(c.trim())));
  const chambers = [], ignored = [];
  let cur = [];
  for (const ln of lines) {
    let cells = ln.split("\t").map(c => c.trim());
    if (/^\d{1,3}$/.test(cells[0]) && (cells.length > 1 || schematic)) {
      if (cur.length) chambers.push(cur);
      cur = [];
      cells = cells.slice(1);
    }
    if (!schematic && cells.length === 2 && cells[1] && !ROOM.test(cells[1])) cells = [`${cells[0]} (${cells[1]})`];
    for (const c of cells) {
      if (!c || NOISE.test(c) || ROOM.test(c)) continue;
      if (schematic && isRun(c)) {
        const toks = words(c);
        const parts = toks.filter(t => SCHOOL_CODE.test(t)).length >= 2 && SCHOOL_CODE.test(toks[0])
          ? c.split(/\s(?=[A-Z]{2,4}\s)/) : splitRun(toks, dict);
        cur.push(...parts.map(parseItem).filter(Boolean));
      } else if (schematic) ignored.push(c);
      else for (const piece of c.split(",").length > 2 ? c.split(",") : [c]) {
        const e = parseItem(piece);
        if (e) cur.push(e);
        else if (piece.trim()) ignored.push(piece.trim());
      }
    }
  }
  if (cur.length) chambers.push(cur);
  const seen = new Set();
  const out = chambers.map(ch => ch.filter(e => { const k = nameKey(e.name); return !seen.has(k) && seen.add(k); }));
  return { chambers: out.filter(c => c.length), ignored: ignored.slice(0, 50) };
}

/* Matching (port of app.py match_entry) */
const SCHOOL_STOP = new Set(["the", "high", "school", "hs", "sr", "senior", "of", "and", "at", "upper", "secondary", "prep", "preparatory", "academy", "college", "h", "s"]);
const schoolTokens = s => new Set(words(nameKey(s)).filter(t => !SCHOOL_STOP.has(t)));
const overlap = (a, b) => a.size && b.size ? [...a].filter(t => b.has(t)).length / Math.min(a.size, b.size) : 0;
const bestOverlap = (school, p) => Math.max(0, ...(p.schools || []).map(x => overlap(schoolTokens(school), schoolTokens(x))));
const recency = p => [p.last, p.n];
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1; return 0; };
const maxBy = (xs, f) => xs.reduce((m, x) => cmp(f(x), f(m)) > 0 ? x : m);
const keyOf = pid => pid.slice(0, pid.lastIndexOf("#"));

async function matchEntry(e) {
  const key = nameKey(e.name), school = e.school || null, forced = e.pid;
  const out = { match: "none", pid: null, ambiguous: false, school_mismatch: false, candidates: [], suggestions: [] };
  let ps = [], how = "none", person = null;
  if (forced !== "none") {
    ps = await CS.lookupName(e.name);
    how = ps.some(p => keyOf(p.pid) === key) ? "exact" : "first-last";
  }
  out.candidates = ps.map(p => ({ pid: p.pid, school: p.school || "", n: p.n, last: p.last }));
  if (forced && forced !== "none") person = await CS.person(forced);
  if (person) Object.assign(out, { match: ps.some(p => p.pid === forced) ? how : "picked", pid: forced });
  else if (ps.length) {
    if (school) {
      person = maxBy(ps, p => [bestOverlap(school, p), ...recency(p)]);
      out.school_mismatch = bestOverlap(school, person) < 0.5;
    } else {
      person = maxBy(ps, recency);
      out.ambiguous = ps.length > 1;
    }
    Object.assign(out, { match: how, pid: person.pid });
  }
  if (!out.pid && key) {
    const names = await loadNames();
    for (const [k] of CS.closeMatches(key, names).filter(([k]) => k !== key).slice(0, 3)) {
      const ks = await CS.people(k);
      if (!ks.length) continue;
      const p = maxBy(ks, recency);
      out.suggestions.push({ pid: p.pid, name: p.name, school: p.school || "" });
    }
  }
  return [out, person];
}

/* Chamber math (port of app.py api_report) */
const UNKNOWN_R = 15, SD_KNOWN = 15, SD_UNKNOWN = 22, SIMS = 5000, SEED = 7, P_FLOOR = 0.03, P_CEIL = 0.95;
const advancing = n => clamp(Math.round(n / 3), 3, 6);
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

function chamberStrength(ratings, adv) {
  const rs = ratings.map(r => r ?? UNKNOWN_R).sort((a, b) => b - a);
  if (!rs.length) return 0;
  const top = rs.slice(0, adv), rest = rs.slice(adv);
  return 0.75 * mean(top) + 0.25 * mean(rest.length ? rest : top);
}

function mulberry32(a) {
  return () => {
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function simulate(mu, sd, others, adv) {
  const rand = mulberry32(SEED);
  const gauss = (m, s) => m + s * Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const field = others.map(r => r == null ? [UNKNOWN_R, SD_UNKNOWN] : [r, SD_KNOWN]);
  let hits = 0, total = 0;
  for (let s = 0; s < SIMS; s++) {
    const x = gauss(mu, sd);
    let ahead = 0;
    for (const [m, d] of field) ahead += gauss(m, d) > x;
    hits += ahead < adv;
    total += ahead;
  }
  return [clamp(hits / SIMS, P_FLOOR, P_CEIL), 1 + total / SIMS];
}

const friedLabel = f => [[95, "Charcoal"], [85, "Deep Fried"], [70, "Crispy"], [50, "Golden Brown"], [25, "Lightly Toasted"], [0, "Raw"]].find(([c]) => f >= c)[1];
const threatVs = (r, rMe) => (d => d > 15 ? "Problem" : d >= -15 ? "Coin flip" : "You've got this")((r ?? UNKNOWN_R) - rMe);
function chamberLabel(s, [t1, t2, t3, t4]) {
  return s < t1 ? "Open Season" : s < t2 ? "Manageable" : s < t3 ? "Spicy" : s < t4 ? "Stacked" : "Group of Death";
}

/* st = { entries: [{name, school, po, pid}], me: index|null, meRating: number|null } */
async function buildReport(st, advIn) {
  const meta = await CS.meta();
  const entries = st.entries.map(e => ({ ...e, name: words(e.name).join(" ").slice(0, 80) }));
  const matched = await Promise.all(entries.map(matchEntry));
  const rows = entries.map((e, i) => {
    const [m, p] = matched[i];
    return {
      i, name: e.name, school: e.school || p?.school || null, po: !!e.po, is_me: false, matched_name: p?.name ?? null, pin: e.pid ?? null,
      schools: p?.schools || [], ...m, rating: p ? p.rating : null, tier: p?.tier || "Mystery Box", confidence: p?.confidence || 0,
      threat: null, badges: p?.badges || [], bids: p?.bids || {}, stats: p?.stats || {}, top: p?.top || [],
    };
  });
  const n = rows.length, adv = clamp(advIn >= 1 ? advIn : advancing(n), 1, Math.max(1, n - 1)), me = st.me;
  const others = rows.filter(r => r.i !== me).map(r => r.rating);
  const strength = chamberStrength(others, adv);
  const found = rows.filter(r => r.rating != null).length;
  let meBlock = null;
  if (me != null) {
    const mine = rows[me];
    const [rMe, sd, source] = st.meRating != null ? [st.meRating, SD_KNOWN, "override"]
      : mine.rating != null ? [mine.rating, SD_KNOWN, "history"] : [UNKNOWN_R, SD_UNKNOWN, "assumed"];
    const [pBreak, avgFinish] = simulate(rMe, sd, others, adv);
    const fried = Math.round(100 * (1 - pBreak));
    meBlock = { i: me, name: mine.name, rating: rMe, source, p_break: pBreak, fried, label: friedLabel(fried), avg_finish: avgFinish };
    mine.is_me = true;
    for (const r of rows) if (r.i !== me) r.threat = threatVs(r.rating, rMe);
  }
  rows.sort((a, b) => (b.rating ?? UNKNOWN_R) - (a.rating ?? UNKNOWN_R) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    chamber: { n, adv, strength, label: chamberLabel(strength, meta.chamber_thresholds), known: found, unknown: n - found,
               tiers: Object.fromEntries(TIER_ORDER.map(t => [t, rows.filter(r => r.tier === t).length])) },
    me: meBlock, competitors: rows,
  };
}

/* Share links: #/report?r=<base64url JSON {n: names, m: me index, a: spots that break, p: {index: pid}, l: picked level}> */
const b64url = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function encodeShare(st, adv) {
  const n = st.entries.map(e => words(e.name).join(" ").slice(0, 80));
  const resolved = new Map((st.report?.competitors || []).map(c => [c.i, c.pid]));
  const p = Object.fromEntries(st.entries.flatMap((e, i) => (e.pid || e.school && resolved.get(i)) ? [[i, e.pid || resolved.get(i)]] : []));
  const o = { n, m: st.me, a: adv, p };
  if (st.meRating != null) o.l = st.meRating;
  return b64url(new TextEncoder().encode(JSON.stringify(o)));
}
function decodeShare(r) {
  if (typeof r !== "string" || r.length > MAX_LINK || !/^[A-Za-z0-9_-]+$/.test(r)) return null;
  let o;
  try {
    const bin = atob(r.replace(/-/g, "+").replace(/_/g, "/"));
    o = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  } catch { return null; }
  if (!o || typeof o !== "object" || !Array.isArray(o.n) || o.n.length < 2 || o.n.length > MAX_SHARE) return null;
  const n = o.n.map(x => typeof x === "string" ? words(x).join(" ").slice(0, 80) : "");
  if (n.some(x => !x)) return null;
  const idx = v => Number.isInteger(v) && v >= 0 && v < n.length;
  if (o.m != null && !idx(o.m)) return null;
  if (o.a != null && !(Number.isInteger(o.a) && o.a >= 1 && o.a < n.length)) return null;
  if (o.p != null && (typeof o.p !== "object" || Array.isArray(o.p))) return null;
  const p = {};
  for (const [k, v] of Object.entries(o.p || {})) {
    if (!/^\d{1,2}$/.test(k) || !idx(+k) || typeof v !== "string" || !v || v.length > 200) return null;
    p[+k] = v;
  }
  return { n, m: o.m ?? null, a: o.a ?? null, p, l: LEVELS.some(([, v]) => v === o.l) ? o.l : null };
}

/* Report rendering. Every string from Tabroom, the paste or a share link goes through esc() or textContent. */
const REPORT_HTML = `
  <section class="rsec" aria-labelledby="rate-h">
    <div class="rhead">
      <h2 id="rate-h" tabindex="-1">Chamber rating</h2>
      <div class="tools">
        <button type="button" class="btn-line" data-share>Share this report</button>
        <button type="button" class="btn-line" data-print>Print / save as PDF</button>
      </div>
    </div>
    <div class="share" data-r="share" hidden>
      <label for="share-url">Share link</label>
      <div class="share-row"><input id="share-url" readonly spellcheck="false"><button type="button" class="btn-line" data-copy>Copy</button></div>
    </div>
    <p class="share-msg" data-r="msg" role="status"></p>
    <div class="board" data-r="board"></div>
    <p class="note sample-note" data-r="foot" hidden></p>
    <div data-r="dist"></div>
  </section>
  <section class="rsec" aria-labelledby="fried-h">
    <h2 id="fried-h">How fried you are</h2>
    <div data-r="fried"></div>
  </section>
  <section class="rsec" aria-labelledby="hl-h">
    <h2 id="hl-h">Individual highlights</h2>
    <p class="sub">Everyone we found on Tabroom, most dangerous first.<span class="noprint"> Click a name for their full record.</span></p>
    <div class="ledger" data-r="ledger"></div>
  </section>`;

addEventListener("beforeprint", () => document.querySelectorAll("details.more").forEach(d => { d.open = true; }));

function reportRefs(root, ro) {
  root.innerHTML = REPORT_HTML;
  const R = { root, ro, last: null };
  for (const x of root.querySelectorAll("[data-r]")) R[x.dataset.r] = x;
  if (ro) {
    root.querySelector("[data-share]").remove();
    root.querySelector("#fried-h").textContent = "How fried they are";
  }
  root.querySelector("[data-print]").addEventListener("click", () => print());
  return R;
}

function vote(x, ro) {
  if (x.is_me) return { l: "me", t: ro ? "Shared this" : "You" };
  if (x.rating == null) return { l: "unlit", t: "Unknown" };
  const t = x.threat || (d => d > 15 ? "Problem" : d >= -15 ? "Coin flip" : "You've got this")(x.rating - 15);
  return { l: LIGHT[t], t };
}
const round = x => Math.round(x);
const lookupHref = pid => `#/lookup?pid=${encodeURIComponent(pid)}`;
const nameHTML = x => x.pid && x.rating != null ? `<a class="who-link" href="${esc(lookupHref(x.pid))}">${esc(x.name)}</a>` : esc(x.name);

function renderReport(r, R) {
  R.root.hidden = false;
  R.last = r;
  R.share && (R.share.hidden = true);
  R.msg.textContent = "";
  R.foot.hidden = true;
  R.board.innerHTML = boardHTML(r, R.ro);
  R.fried.innerHTML = friedHTML(r, R.ro);
  const more = R.ledger.querySelector("details.more")?.open;
  R.ledger.innerHTML = ledgerHTML(r, R.ro);
  if (more) R.ledger.querySelector("details.more").open = true;
  CS.chambers().then(ch => { if (R.last === r) R.dist.replaceChildren(distFigure(r.chamber.strength, ch)); }, () => R.dist.replaceChildren());
}

function boardHTML(r, ro) {
  const c = r.chamber, comps = r.competitors, votes = comps.map(x => vote(x, ro));
  const yeas = c.label === "Stacked" || c.label === "Group of Death";
  const tally = [["red", "Problem"], ["amber", "Coin flip"], ["green", "You've got this"], ["unlit", "Unknown"]]
    .map(([l, t]) => [l, t, votes.filter(v => v.l === l).length]);
  const tiers = TIER_ORDER.filter(t => c.tiers?.[t]);
  const mixText = tiers.map(t => `${c.tiers[t]} ${t}`).join(", ");
  return `
    <div class="board-top">
      <div>
        <span class="led led-xl" data-ghost="88" aria-hidden="true"><span>${round(c.strength)}</span></span>
        <p class="led-cap"><span class="sr">Strength ${round(c.strength)} </span>Chamber strength, out of 100</p>
      </div>
      <div>
        <p class="verdict-line">${yeas ? "The yeas have it." : "The nays have it."}</p>
        <p class="verdict-label"><span class="light" data-l="${chamberLight(c.label)}"></span>${esc(c.label)}</p>
        <p class="blurb">${esc(CHAMBER_BLURB[c.label] || "")}</p>
      </div>
      <dl class="tally" aria-label="Lights on the board">
        ${tally.map(([l, t, n]) => `<div><dt><span class="light" data-l="${l}"></span>${t}</dt><dd>${n}</dd></div>`).join("")}
      </dl>
    </div>
    <div class="mix">
      <div class="tierbar" role="img" aria-label="Tier mix: ${esc(mixText)}">
        ${tiers.map(t => `<i style="flex-grow:${c.tiers[t]};background:var(${TIER_COLOR[t]})"></i>`).join("")}
      </div>
      <ul class="legend" aria-hidden="true">
        ${tiers.map(t => `<li><i style="background:var(${TIER_COLOR[t]})"></i>${esc(t)} <b>${c.tiers[t]}</b></li>`).join("")}
      </ul>
      <p class="found">${c.known} of ${c.n} found on Tabroom. <span>${c.adv} spots break.</span></p>
    </div>
    <div class="roster-head" aria-hidden="true"><span></span><span>Competitor</span><span>Vote</span><span>Tier</span><span>Rating</span></div>
    <ol class="roster" aria-label="Roster, strongest first">
      ${comps.map((x, k) => {
        const v = votes[k], school = x.school || x.schools?.[0];
        return `<li class="row${x.is_me ? " is-me" : ""}" style="--i:${k}">
          <span class="light" data-l="${v.l}"></span>
          <span class="who"><span class="nm">${nameHTML(x)}${x.po ? ` <span class="tag">PO</span>` : ""}</span>${school ? `<span class="sch">${esc(school)}</span>` : ""}</span>
          <span class="meta"><span class="vote">${esc(v.t)}</span><span class="tier">${esc(x.tier)}</span></span>
          <span class="rate">${x.rating == null
            ? `<span class="bar"></span><span class="num" aria-label="Rating unknown">?</span>`
            : `<span class="bar"><i style="width:${clamp(x.rating, 0, 100)}%"></i></span><span class="num"><span class="sr">Rating </span>${round(x.rating)}</span>`}</span>
        </li>`;
      }).join("")}
    </ol>
    ${r.me ? "" : `<p class="board-note">${ro
      ? "Nobody is marked as the person who shared this, so the lights compare everyone to an unknown debater."
      : "Nobody is marked as you, so the lights compare everyone to an unknown debater. Mark yourself above to make them personal."}</p>`}`;
}

function friedHTML(r, ro) {
  const m = r.me;
  if (!m) return `<p class="prompt">${ro
    ? "Whoever shared this didn't mark themselves, so there are no break odds here. Check your own chamber to get yours."
    : "Mark yourself in the chamber list above (the circle next to your name) to see your break odds."}</p>`;
  const step = Math.max(0, FRIED.findIndex(([s]) => m.label.startsWith(s)));
  const n = r.chamber.n;
  return `
    <div class="fried-top">
      <div class="readout">
        <span class="led led-lg" data-ghost="88" aria-hidden="true"><span>${m.fried}</span></span>
        <p class="led-cap"><span class="sr">Fried score ${m.fried} </span>Fried, out of 100</p>
      </div>
      <div>
        <p class="fried-label">${esc(m.label)}</p>
        <p class="fried-blurb">${esc(FRIED[step][1])}</p>
      </div>
    </div>
    <ol class="doneness" aria-label="Doneness scale">
      ${FRIED.map(([s], i) => `<li style="--d:var(--d${i + 1})"${i === step ? ` aria-current="step"` : ""}>${s}${i === step ? `<span class="here">${ro ? "They're here" : "You're here"}</span>` : ""}</li>`).join("")}
    </ol>
    <dl class="figs">
      <div><dt>Break odds</dt><dd>${round(m.p_break * 100)}%</dd></div>
      <div><dt>Average finish</dt><dd>${m.avg_finish.toFixed(1)} <small>of ${n}</small></dd></div>
    </dl>
    <p class="my-rating">${ro ? `Rating for ${esc(m.name)}` : "Your rating"}: <strong>${round(m.rating)}</strong>, ${(ro ? SOURCE_RO : SOURCE)[m.source] || m.source}.</p>
    ${m.source === "history" || ro ? "" : `
      <fieldset class="levels">
        <legend>What level are you, roughly?</legend>
        ${LEVELS.map(([t, v]) => `<label><input type="radio" name="lvl" value="${v}" data-k="lvl-${v}"${m.source === "override" && m.rating === v ? " checked" : ""}><span>${t} <small>${v}</small></span></label>`).join("")}
      </fieldset>`}`;
}

const SHOWN = 5;
function ledgerHTML(r, ro) {
  const found = r.competitors.filter(x => x.rating != null);
  const myst = r.competitors.filter(x => x.rating == null);
  const shown = [], rest = [];
  found.forEach((x, k) => (k < SHOWN || x.is_me ? shown : rest).push(x));
  return shown.map(x => entryHTML(x, ro)).join("") +
    (rest.length ? `<details class="more"><summary>Show the other ${rest.length} competitor${rest.length === 1 ? "" : "s"}</summary>${rest.map(x => entryHTML(x, ro)).join("")}</details>` : "") +
    (myst.length ? mysteryHTML(myst, ro) : "") ||
    `<p class="note" style="padding:1rem 0">Nobody in this chamber is on Tabroom yet.</p>`;
}

function entryHTML(x, ro) {
  const v = vote(x, ro), conf = x.confidence ?? 0;
  const notes = [];
  if (x.ambiguous) notes.push(ro ? "More than one person on Tabroom has this name." : "More than one person on Tabroom has this name. Pick the right one.");
  if (x.school_mismatch) notes.push("Tabroom has this name at a different school. Make sure it's them.");
  if (x.match === "first-last") notes.push("Matched on first and last name only.");
  const bids = Object.entries(x.bids || {}).filter(([, n]) => n).map(([s, n]) => `${n} in ${s}`).join(", ");
  const st = x.stats || {};
  const pick = !ro && (x.ambiguous || x.school_mismatch || x.pin) && x.candidates?.length > 1;
  return `
    <article class="entry">
      <div class="entry-side">
        <h3>${nameHTML(x)}${x.is_me ? ` <span class="tag tag-me">${ro ? "Shared this" : "You"}</span>` : ""}${x.po ? ` <span class="tag">PO</span>` : ""}</h3>
        ${x.school || x.schools?.[0] ? `<p class="school">${esc(x.school || x.schools[0])}</p>` : ""}
        <p class="entry-vote"><span class="light" data-l="${v.l}"></span>${esc(v.t)}</p>
        <p class="score">${round(x.rating)} <small>rating</small></p>
      </div>
      <div class="entry-main">
        <p class="entry-tier"><strong>${esc(x.tier)}.</strong> ${esc(TIER_BLURB[x.tier] || "")}</p>
        ${notes.length ? `<p class="note">${esc(notes.join(" "))}</p>` : ""}
        ${x.top?.length ? `<ol class="results" aria-label="Best results">${x.top.slice(0, 3).map(t =>
          `<li><span class="res">${esc(t.label)}</span>${t.bid ? `<span class="tag">Bid</span>` : ""}<span class="lvl">${esc(t.tier === "local" ? "Local" : t.tier)}</span></li>`).join("")}</ol>` : ""}
        ${x.badges?.length ? `<ul class="badges" aria-label="Badges">${x.badges.map(b => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
        <dl class="stats">
          <div><dt>Tournaments</dt><dd>${esc(st.tournaments ?? 0)}</dd></div>
          <div><dt>Breaks</dt><dd>${esc(st.breaks ?? 0)}</dd></div>
          <div><dt>Finals</dt><dd>${esc(st.finals ?? 0)}</dd></div>
          <div><dt>Wins</dt><dd>${esc(st.wins ?? 0)}</dd></div>
          ${bids ? `<div><dt>Bids</dt><dd>${esc(bids)}</dd></div>` : ""}
          <div><dt>Confidence</dt><dd><span class="dots" role="img" aria-label="Confidence ${esc(conf)} of 3">${[1, 2, 3].map(d => `<i${d <= conf ? ` class="on"` : ""}></i>`).join("")}</span></dd></div>
        </dl>
        ${x.schools?.length > 1 || (x.schools?.[0] && x.schools[0] !== (x.school || x.schools[0])) ? `<p class="schools">Schools on Tabroom: ${x.schools.map(esc).join("; ")}</p>` : ""}
        ${ro ? "" : `<p class="fix">
          ${pick ? `<label>Which ${esc(x.name)}?
            <select data-pick="${x.i}" data-k="pick-${x.i}">
              ${x.candidates.map(c => `<option value="${esc(c.pid)}"${c.pid === x.pid ? " selected" : ""}>${esc(c.school)}, ${esc(c.n)} results, last ${esc(c.last)}</option>`).join("")}
              <option value="none">None of these</option>
            </select></label>` : ""}
          <button type="button" class="linkbtn" data-notme="${x.i}" data-k="notme-${x.i}" aria-label="${x.is_me ? "Not me" : `Not ${esc(x.name)}`}">${x.is_me ? "Not me" : "Not them"}</button>
        </p>`}
      </div>
    </article>`;
}

function mysteryHTML(myst, ro) {
  return `
    <article class="entry">
      <div class="entry-side">
        <h3>Mystery Boxes</h3>
        <p class="entry-vote"><span class="light" data-l="unlit"></span>Unknown</p>
        <p class="score">${myst.length} <small>${myst.length === 1 ? "person" : "people"}</small></p>
      </div>
      <div class="entry-main">
        <p class="entry-tier"><strong>Mystery Box.</strong> ${esc(TIER_BLURB["Mystery Box"])}</p>
        <ul class="myst">
          ${myst.map(x => {
            const forced = x.pin === "none", sugg = x.suggestions || [];
            return `<li><span class="nm">${esc(x.name)}${x.is_me ? ` <span class="tag tag-me">${ro ? "Shared this" : "You"}</span>` : ""}</span>
              ${forced ? `<span class="dym">Marked as not them.${ro ? "" : ` <button type="button" class="linkbtn" data-undo="${x.i}" data-k="undo-${x.i}">Undo</button>`}</span>`
                : ro ? `<span class="dym">Not on Tabroom.</span>`
                : sugg.length ? `<span class="dym">Did you mean ${sugg.map((s, j) => `<button type="button" class="sugg" data-sugg="${x.i}" data-j="${j}" data-k="sugg-${x.i}-${j}">${esc(s.name)}${s.school ? `, ${esc(s.school)}` : ""}</button>`).join("")}</span>`
                : `<span class="dym">No close matches on Tabroom.</span>`}
            </li>`;
          }).join("")}
        </ul>
        <p class="note">Each one counts as a rating of 15 in the chamber math.${ro ? "" : " Fix a misspelled name in the chamber list above, or pick a match."}</p>
      </div>
    </article>`;
}

/* Where this chamber sits among real ones: a histogram of chambers.json with the label cut-offs. */
const BIN = 2.5;
function distFigure(s, ch) {
  const xs = (ch?.strengths || []).filter(Number.isFinite);
  if (xs.length < 20) return el("div");
  const cuts = Array.isArray(ch.thresholds) && ch.thresholds.length === 4 ? ch.thresholds : null;
  if (!cuts) return el("div");
  const hi = Math.max(80, Math.ceil(Math.max(...xs, s) / 20) * 20), nb = hi / BIN;
  const counts = Array(nb).fill(0);
  for (const x of xs) counts[clamp(Math.floor(x / BIN), 0, nb - 1)]++;
  const peak = Math.max(...counts), meBin = clamp(Math.floor(s / BIN), 0, nb - 1);
  const pct = Math.round(100 * xs.filter(x => x < s).length / xs.length);
  const pos = x => `${(100 * clamp(x, 0, hi) / hi).toFixed(3)}%`;
  const season = String(ch.source || "").match(/\d{4}-\d{2}/)?.[0];
  const pool = ["real ", season ? [el("span", { class: "nobr" }, season), " "] : "", "circuit chambers"];
  const title = pct >= 100 ? ["Stronger than every one of the ", pool] : pct <= 0 ? ["Weaker than every one of the ", pool] : [`Stronger than ${pct}% of `, pool];
  const bounds = [0, ...cuts, hi];
  const regions = CHAMBER_LABELS.map((label, i) => ({ label, lo: bounds[i], hi: bounds[i + 1] }));
  const band = i => `${i * BIN}–${(i + 1) * BIN}`;

  const tip = el("div", { class: "dist-tip", hidden: true, "aria-hidden": "true" });
  const bars = el("div", { class: "dist-bars", "aria-hidden": "true" }, counts.map((c, i) =>
    el("span", { class: i === meBin ? "is-me" : null, dataset: { i } }, el("b", { style: `height:${(100 * c / peak).toFixed(2)}%` }))));
  const show = e => {
    const b = e.target.closest?.("span[data-i]");
    if (!b) { tip.hidden = true; return; }
    const i = +b.dataset.i;
    tip.replaceChildren(el("strong", null, `${counts[i]} chamber${counts[i] === 1 ? "" : "s"}`), ` at strength ${band(i)}`);
    tip.hidden = false;
    const w = bars.clientWidth, tw = tip.offsetWidth;
    tip.style.left = `${clamp((i + 0.5) / nb * w - tw / 2, 0, w - tw)}px`;
    tip.style.bottom = `${100 * counts[i] / peak + 4}%`;
  };
  bars.addEventListener("pointerover", show);
  bars.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") tip.hidden = true; });

  const edge = x => x / hi < 0.18 ? "edge-l" : x / hi > 0.82 ? "edge-r" : null;
  const ticks = [];
  for (let t = 0; t <= hi; t += 20) ticks.push(t);
  return el("figure", { class: "dist" },
    el("figcaption", null,
      el("p", { class: "dist-title" }, title),
      el("p", { class: "dist-cap" }, `${ch.source || "Real chambers"}, in ${BIN}-point bands of strength. The bold line marks this chamber.`)),
    el("div", { class: "dist-chart" },
      el("div", { class: "dist-regions", "aria-hidden": "true" }, regions.map((g, i) =>
        el("span", { class: [`row-${i % 2}`, i === 0 ? "first" : i === regions.length - 1 ? "last" : ""].join(" ").trim(),
                     style: i === 0 ? "left:0" : i === regions.length - 1 ? "right:0" : `left:${pos((g.lo + g.hi) / 2)}` },
          el("i", { class: "light", "data-l": chamberLight(g.label) }), g.label))),
      cuts.map(t => el("span", { class: "dist-cut", style: `left:${pos(t)}`, "data-v": t, "aria-hidden": "true" })),
      el("div", { class: "dist-plot" }, bars, tip),
      el("span", { class: "dist-me", style: `left:${pos(s)}`, "aria-hidden": "true" }),
      el("div", { class: "dist-axis", "aria-hidden": "true" }, ticks.map(t => el("span", { style: `left:${pos(t)}` }, t))),
      el("div", { class: "dist-you", "aria-hidden": "true" },
        el("span", { class: edge(s), style: `left:${pos(s)}` }, `This chamber, ${round(s)}`))),
    el("details", { class: "dist-table" },
      el("summary", null, "Show the numbers"),
      el("p", null, `Out of ${xs.length.toLocaleString()} real chambers, ${xs.filter(x => x < s).length.toLocaleString()} were weaker than this one (strength ${s.toFixed(1)}). Labels: `,
        regions.map((g, i) => `${g.label} ${i === 0 ? `below ${cuts[0]}` : i === 4 ? `${cuts[3]} and up` : `${g.lo} to ${g.hi}`}`).join(", "), "."),
      el("table", null,
        el("thead", null, el("tr", null, el("th", { scope: "col" }, "Strength"), el("th", { scope: "col" }, "Chambers"))),
        el("tbody", null, counts.map((c, i) => c ? el("tr", { class: i === meBin ? "is-me" : null },
          el("td", null, band(i), i === meBin ? " (this chamber)" : ""), el("td", null, c)) : null)))));
}

/* Home: static markup only; everything user-supplied is added with textContent or esc(). */
const HOME_HTML = `
  <section class="hero">
    <div>
      <h1 tabindex="-1">Is my chamber stacked?</h1>
      <p class="lede">Paste your Congress chamber and we'll check everyone's Tabroom record, then tell you how strong the room is and how fried you are.</p>
      <p class="dataline" id="dataline" aria-live="polite">Loading Tabroom data…</p>
    </div>
    <aside class="teaser board" id="teaser" hidden aria-labelledby="teaser-h">
      <p class="teaser-h" id="teaser-h">Example report: <span id="teaser-title"></span></p>
      <span class="led led-xl" data-ghost="88" aria-hidden="true"><span id="teaser-n"></span></span>
      <p class="led-cap"><span class="sr" id="teaser-sr"></span>Chamber strength, out of 100</p>
      <p class="verdict-label"><span class="light" id="teaser-light"></span><span id="teaser-label"></span></p>
      <p class="blurb" id="teaser-blurb"></p>
      <button type="button" class="btn-line" data-sample>See the full report</button>
    </aside>
  </section>
  <div class="home-grid">
    <form class="bill" id="paste-form">
      <p class="bill-title" id="bill-title">A bill to find out whether my chamber is stacked</p>
      <div class="draft">
        <pre class="gutter" id="gutter" aria-hidden="true"></pre>
        <textarea id="paste" wrap="off" spellcheck="false" autocomplete="off" aria-label="Chamber list" aria-describedby="paste-hint paste-err" placeholder="Paste your chamber from Tabroom (or type names, one per line)"></textarea>
      </div>
      <p class="hint" id="paste-hint">Copy the entries from the Tabroom schematic, or type one name per line. Judges and room numbers get skipped.</p>
      <div class="actions">
        <button class="btn" id="roll">Call the roll</button>
        <button type="button" class="btn-line" data-sample>Try it with the 2026 TOC final</button>
        <p class="err" id="paste-err" role="alert"></p>
      </div>
    </form>
    <aside class="order" aria-labelledby="order-h">
      <h2 class="order-h" id="order-h">How it works</h2>
      <ol>
        <li><b>Paste the chamber</b><span>Straight from the Tabroom schematic, judges and rooms included.</span></li>
        <li><b>Call the roll</b><span>Fix any names we misread and mark yourself with the circle.</span></li>
        <li><b>Run the numbers</b><span>Everyone gets a rating from their Tabroom results since 2020. You get the chamber's verdict and your break odds.</span></li>
      </ol>
    </aside>
  </div>
  <section class="step" id="confirm" hidden aria-labelledby="confirm-h">
    <h2 id="confirm-h" tabindex="-1">Who's in the chamber</h2>
    <p class="sub">Click a name to fix it. Use the circle to mark yourself, so we can tell you how fried you are.</p>
    <div class="seg" id="chamber-pick" role="group" aria-labelledby="chamber-pick-l" hidden></div>
    <ul class="chips" id="chips"></ul>
    <form class="add" id="add-form">
      <label class="sr" for="add-name">Add a name</label>
      <input id="add-name" placeholder="Add a name" autocomplete="off">
      <button type="submit" class="btn-line">Add</button>
    </form>
    <details class="ignored" id="ignored" hidden><summary></summary><ul></ul></details>
    <label class="adv">Spots that break <input type="number" id="adv" min="1" step="1" inputmode="numeric"> <small id="adv-note"></small></label>
    <div class="actions">
      <button type="button" class="btn" id="run">Run the numbers</button>
      <p class="err" id="run-err" role="alert"></p>
    </div>
  </section>
  <div id="report" hidden></div>`;

const home = document.createElement("div");
home.className = "home";
home.innerHTML = HOME_HTML;
const $ = s => home.querySelector(s);
const R = reportRefs($("#report"), false);
const S = { text: "", chambers: [], ignored: [], ci: 0, entries: [], me: null, advTouched: false, meRating: null, editing: null, report: null };

CS.meta().then(m => {
  $("#dataline").replaceChildren(`Ratings from ${m.tournaments.toLocaleString()} tournaments and ${m.people.toLocaleString()} competitors, `,
    el("span", { class: "nobr" }, `${m.seasons[0]} to ${m.seasons.at(-1)}`),
    `. Updated ${new Date(m.built_at).toLocaleDateString([], { dateStyle: "medium" })}.`);
}, e => { $("#dataline").textContent = e.message; });

/* Paste box */
const ta = $("#paste"), gutter = $("#gutter");
function syncGutter() {
  const n = Math.max(ta.value.split("\n").length, 10);
  gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n");
  gutter.scrollTop = ta.scrollTop;
}
ta.addEventListener("input", syncGutter);
ta.addEventListener("focus", () => loadNames().catch(() => {}), { once: true });
ta.addEventListener("scroll", () => { gutter.scrollTop = ta.scrollTop; });
ta.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("#paste-form").requestSubmit(); } });
syncGutter();

async function callRoll() {
  const err = $("#paste-err"), btn = $("#roll");
  err.textContent = "";
  const text = ta.value;
  if (!text.trim()) { err.textContent = "No names found. Paste the chamber list, one name per line."; return false; }
  btn.disabled = true;
  if (!known) btn.textContent = "Loading names…";
  try {
    await loadNames();
    const { chambers, ignored } = parsePaste(text, known);
    if (!chambers.length) { err.textContent = "No names found. Paste the chamber list, one name per line."; return false; }
    Object.assign(S, { text, chambers, ignored });
    pickChamber(0);
    $("#confirm").hidden = false;
    $("#confirm-h").focus();
    $("#confirm").scrollIntoView({ block: "start" });
    return true;
  } catch (x) { err.textContent = x.message; return false; }
  finally { btn.disabled = false; btn.textContent = "Call the roll"; }
}
$("#paste-form").onsubmit = e => { e.preventDefault(); callRoll(); };

const sampleBtns = [...home.querySelectorAll("[data-sample]")];
async function trySample() {
  const err = $("#paste-err"), labels = sampleBtns.map(b => b.textContent);
  err.textContent = "";
  sampleBtns.forEach(b => { b.disabled = true; b.textContent = "Loading the TOC final…"; });
  try {
    const s = await CS.sample();
    const names = (Array.isArray(s?.names) ? s.names : []).filter(x => typeof x === "string" && x.trim()).slice(0, MAX_SHARE);
    if (names.length < 2) throw new Error("The sample chamber isn't available right now. Paste your own instead.");
    ta.value = names.join("\n");
    syncGutter();
    if (!await callRoll()) return;
    const me = S.entries.findIndex(e => e.name === s.me);
    if (me >= 0) { S.me = me; renderConfirm(); }
    if (await run() && me >= 0) {
      R.foot.textContent = `Shown as ${s.me}, the lowest-rated member. Pick yourself above.`;
      R.foot.hidden = false;
    }
  } catch (x) { err.textContent = x.message; }
  finally { sampleBtns.forEach((b, i) => { b.disabled = false; b.textContent = labels[i]; }); }
}
for (const b of sampleBtns) {
  b.addEventListener("click", trySample);
  b.addEventListener("pointerenter", () => loadNames().catch(() => {}), { once: true });
}

Promise.all([CS.sample(), CS.meta()]).then(([s, m]) => {
  if (!(s?.strength >= 0) || !m.chamber_thresholds) return;
  const label = chamberLabel(s.strength, m.chamber_thresholds);
  $("#teaser-title").textContent = s.title;
  $("#teaser-n").textContent = round(s.strength);
  $("#teaser-sr").textContent = `Strength ${round(s.strength)} `;
  $("#teaser-light").dataset.l = chamberLight(label);
  $("#teaser-label").textContent = label;
  $("#teaser-blurb").textContent = CHAMBER_BLURB[label];
  $("#teaser").hidden = false;
}, () => {});

/* Confirm step */
function pickChamber(ci) {
  S.ci = ci;
  S.entries = S.chambers[ci].map(e => ({ name: e.name, school: e.school || null, po: !!e.po, pid: null }));
  Object.assign(S, { me: null, advTouched: false, meRating: null, editing: null, report: null });
  R.root.hidden = true;
  renderConfirm();
}

function lineOf(s) {
  const t = s.trim(), lines = S.text.split(/\r?\n/).map(l => l.replace(/[\u00a0\u200b]/g, " ").trim());
  const k = lines.indexOf(t);
  return (k >= 0 ? k : lines.findIndex(l => t && l.includes(t))) + 1;
}

function renderConfirm() {
  const n = S.entries.length;
  const adv = $("#adv");
  if (!S.advTouched) adv.value = advancing(n);
  adv.max = Math.max(1, n - 1);
  $("#adv-note").textContent = `out of ${n}`;

  const cp = $("#chamber-pick");
  cp.hidden = S.chambers.length < 2;
  cp.innerHTML = `<p class="seg-label" id="chamber-pick-l">We found ${S.chambers.length} chambers. Which one is yours?</p>` +
    S.chambers.map((c, i) => `<button type="button" data-ci="${i}" aria-pressed="${i === S.ci}">Chamber ${i + 1} <span style="font-weight:400">(${c.length} names)</span></button>`).join("");

  $("#chips").innerHTML = S.entries.map((e, i) => `
    <li class="chip${i === S.me ? " is-me" : ""}">
      <label><input type="radio" name="me" value="${i}" data-k="me-${i}"${i === S.me ? " checked" : ""}><span class="sr">This is me: ${esc(e.name)}</span></label>
      ${S.editing === i
        ? `<input class="chip-edit" data-edit-input="${i}" value="${esc(e.name)}" aria-label="Edit name">`
        : `<button type="button" class="chip-name" data-edit="${i}" data-k="name-${i}" aria-label="${esc(e.name)}, edit name">${esc(e.name)}</button>`}
      ${e.school ? `<span class="chip-school">${esc(e.school)}</span>` : ""}
      ${e.po ? `<span class="tag" title="Presiding officer">PO</span>` : ""}
      ${i === S.me ? `<span class="tag tag-me">This is me</span>` : ""}
      <button type="button" class="chip-x" data-rm="${i}" data-k="rm-${i}" aria-label="Remove ${esc(e.name)}">&times;</button>
    </li>`).join("");

  const ig = $("#ignored");
  ig.hidden = !S.ignored.length;
  if (S.ignored.length) {
    ig.querySelector("summary").textContent = `Ignored ${S.ignored.length} line${S.ignored.length === 1 ? "" : "s"} (judges and rooms)`;
    ig.querySelector("ul").innerHTML = S.ignored.map(s => { const k = lineOf(s); return `<li>${k ? `Line ${k}: ` : ""}${esc(s.trim())}</li>`; }).join("");
  }
}

function changed() {
  const k = document.activeElement?.dataset?.k;
  renderConfirm();
  if (k) document.querySelector(`[data-k="${CSS.escape(k)}"]`)?.focus();
  if (S.report) runReport();
}

function commitEdit(i, keep) {
  if (S.editing !== i) return;
  const v = home.querySelector(`[data-edit-input="${i}"]`)?.value.trim();
  S.editing = null;
  const dirty = keep && v && v !== S.entries[i].name;
  if (dirty) Object.assign(S.entries[i], { name: v, pid: null });
  renderConfirm();
  home.querySelector(`[data-k="name-${i}"]`)?.focus();
  if (dirty && S.report) runReport();
}

$("#confirm").addEventListener("click", e => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.ci !== undefined) { pickChamber(+t.dataset.ci); home.querySelector(`[data-ci="${+t.dataset.ci}"]`)?.focus(); }
  else if (t.dataset.rm !== undefined) {
    const i = +t.dataset.rm;
    S.entries.splice(i, 1);
    if (S.me === i) { S.me = null; S.meRating = null; } else if (S.me > i) S.me--;
    changed();
  } else if (t.dataset.edit !== undefined) {
    S.editing = +t.dataset.edit;
    renderConfirm();
    const inp = home.querySelector(`[data-edit-input="${S.editing}"]`);
    inp.focus(); inp.select();
  } else if (t.id === "run") run();
});

$("#chips").addEventListener("change", e => {
  if (e.target.name !== "me") return;
  S.me = +e.target.value;
  S.meRating = null;
  changed();
});
$("#chips").addEventListener("keydown", e => {
  const i = e.target.dataset.editInput;
  if (i === undefined) return;
  if (e.key === "Enter") { e.preventDefault(); commitEdit(+i, true); }
  if (e.key === "Escape") { e.preventDefault(); commitEdit(+i, false); }
});
$("#chips").addEventListener("focusout", e => {
  const i = e.target.dataset.editInput;
  if (i !== undefined) commitEdit(+i, true);
});
$("#add-form").onsubmit = e => {
  e.preventDefault();
  const inp = $("#add-name"), name = inp.value.trim();
  if (!name) return;
  S.entries.push({ name, school: null, po: false, pid: null });
  inp.value = "";
  changed();
};
let advTimer;
$("#adv").addEventListener("input", () => {
  S.advTouched = true;
  clearTimeout(advTimer);
  if (S.report && +$("#adv").value >= 1) advTimer = setTimeout(runReport, 300);
});

async function run() {
  $("#run-err").textContent = "";
  if (S.entries.length < 2) { $("#run-err").textContent = "Add at least two names to compare."; return; }
  $("#run").disabled = true;
  $("#run").textContent = "Running…";
  const ok = await runReport();
  $("#run").disabled = false;
  $("#run").textContent = "Run the numbers";
  if (ok) { $("#rate-h").focus(); $("#rate-h").scrollIntoView({ block: "start" }); }
  return ok;
}

let seq = 0;
async function runReport(focusKey) {
  const mine = ++seq;
  try {
    const r = await buildReport(S, Math.round(+$("#adv").value));
    if (mine !== seq) return false;
    $("#run-err").textContent = "";
    S.report = r;
    if (+$("#adv").value !== r.chamber.adv) $("#adv").value = r.chamber.adv;
    const k = focusKey || document.activeElement?.dataset?.k;
    renderReport(r, R);
    if (k) document.querySelector(`[data-k="${CSS.escape(k)}"]`)?.focus();
    return true;
  } catch (e) {
    $("#run-err").textContent = e.message;
    return false;
  }
}

function setPid(i, pid, name) {
  const e = S.entries[i];
  if (!e) return;
  e.pid = pid;
  if (name) e.name = name;
  if (name) renderConfirm();
  runReport(pid === "none" ? `undo-${i}` : `notme-${i}`);
}

async function share() {
  const url = $("#share-url");
  if (S.entries.length > MAX_SHARE) { R.msg.textContent = `Share links hold up to ${MAX_SHARE} names. Remove a few and try again.`; return; }
  const code = encodeShare(S, S.advTouched ? S.report.chamber.adv : null);
  if (code.length > MAX_LINK) { R.msg.textContent = "This chamber is too big for a share link. Remove a few names and try again."; return; }
  url.value = `${location.href.split("#")[0]}#/report?r=${code}`;
  R.share.hidden = false;
  await copy(url);
}
async function copy(url) {
  try {
    await navigator.clipboard.writeText(url.value);
    R.msg.textContent = "Link copied. Anyone who opens it sees this report, read-only.";
  } catch {
    url.focus();
    url.select();
    R.msg.textContent = "Couldn't reach your clipboard. The link is selected, so copy it with Ctrl+C or Cmd+C.";
  }
}

R.root.addEventListener("click", e => {
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;
  if (d.share !== undefined) share();
  else if (d.copy !== undefined) copy($("#share-url"));
  else if (d.notme !== undefined) setPid(+d.notme, "none");
  else if (d.undo !== undefined) setPid(+d.undo, null);
  else if (d.sugg !== undefined) {
    const x = S.report.competitors.find(c => c.i === +d.sugg), s = x?.suggestions?.[+d.j];
    if (s) setPid(+d.sugg, s.pid, s.name);
  }
});
R.root.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.pick !== undefined) setPid(+t.dataset.pick, t.value);
  else if (t.name === "lvl") { S.meRating = +t.value; runReport(); }
});
$("#share-url").addEventListener("focus", e => e.target.select());

CS.route("", view => { view.append(home); });

CS.route("report", async (view, params) => {
  document.title = "Shared chamber report – Is My Chamber Stacked?";
  const data = decodeShare(params.get("r"));
  const status = el("p", { class: "sub", role: "status" }, data ? "Calling the roll…" : "");
  view.append(el("header", { class: "shared-head" },
    el("h1", { class: "page-h", tabindex: "-1" }, "Shared chamber report"),
    el("p", { class: "lede" }, data
      ? `${data.n.length} competitors, rated from the latest Tabroom data. Ratings refresh every week, so they may have moved since this link was made.`
      : "This share link is broken or cut off. Ask for a fresh link, or check a chamber yourself."),
    el("p", { class: "actions" }, el("a", { class: "btn", href: "#/" }, "Check your own chamber")),
    status));
  if (!data) return;
  const Rr = reportRefs(el("div", { class: "shared", hidden: true }), true);
  view.append(Rr.root);
  const st = { entries: data.n.map((name, i) => ({ name, school: null, po: false, pid: data.p[i] ?? null })), me: data.m, meRating: data.l };
  try {
    renderReport(await buildReport(st, data.a ?? 0), Rr);
    status.textContent = "";
  } catch (e) { status.textContent = e.message; }
});
})();
