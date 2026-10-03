"use strict";
/* Shared data access, router and DOM helpers. Every page script talks to the data through window.CS. */
(() => {
const loaded = new Map();
function load(path) {
  if (!loaded.has(path)) {
    loaded.set(path, fetch(path)
      .then(r => { if (!r.ok) throw new Error(`Couldn't load the Tabroom data (${r.status}). Try again.`); return r.json(); },
            () => { throw new Error("Couldn't load the Tabroom data. Check your connection and try again."); })
      .catch(e => { loaded.delete(path); throw e; }));
  }
  return loaded.get(path);
}
const meta = () => load("data/meta.json");
const names = () => load("data/names.json");
const extra = which => meta().then(m => load(m.files?.[which] || `data/${which}.json`));

/* Must match app.py name_key / shard_of exactly; meta.json carries test vectors that are checked on load. */
function nameKey(s) {
  return String(s ?? "").normalize("NFKD").replace(/\p{Mn}/gu, "").toLowerCase()
    .replace(/[-\u2010–—_.]/g, " ").replace(/['\u2019]/g, "").trim().split(/\s+/).join(" ");
}
function shardOf(key) {
  let h = 2166136261;
  for (const b of new TextEncoder().encode(key)) h = Math.imul(h ^ b, 16777619) >>> 0;
  return (h & 255).toString(16).padStart(2, "0");
}
const own = (o, k) => o && Object.hasOwn(o, k) ? o[k] : undefined;
const shard = key => load(`data/p/${shardOf(key)}.json`);
const people = async key => own((await shard(key)).n, key) || [];

async function lookupName(raw) {
  const key = nameKey(raw), toks = key.split(" ");
  const ps = key ? await people(key) : [];
  if (ps.length || toks.length < 2) return ps;
  const fk = `${toks[0]} ${toks.at(-1)}`, s = await shard(fk);
  const keys = [...new Set([...(own(s.n, fk) ? [fk] : []), ...(own(s.fl, fk) || [])])].filter(k => k !== key).sort();
  return (await Promise.all(keys.map(people))).flat();
}

async function person(pid) {
  if (typeof pid !== "string" || pid.length > 200 || !pid.includes("#")) return null;
  return (await people(pid.slice(0, pid.lastIndexOf("#")))).find(p => p.pid === pid) || null;
}

/* difflib.SequenceMatcher.ratio, so suggestions agree with app.py */
function ratio(a, b) {
  const m = (a0, a1, b0, b1) => {
    let bi = 0, bj = 0, bk = 0;
    for (let i = a0; i < a1; i++) for (let j = b0; j < b1; j++) {
      let k = 0;
      while (i + k < a1 && j + k < b1 && a[i + k] === b[j + k]) k++;
      if (k > bk) [bi, bj, bk] = [i, j, k];
    }
    return bk && bk + m(a0, bi, b0, bj) + m(bi + bk, a1, bj + bk, b1);
  };
  return 2 * m(0, a.length, 0, b.length) / (a.length + b.length);
}

// ponytail: linear scan of every name (difflib.get_close_matches); bucket by length if names.json gets huge
function closeMatches(word, list, n = 4, cutoff = 0.85) {
  const need = new Map();
  for (const c of word) need.set(c, (need.get(c) || 0) + 1);
  const hits = [];
  for (const row of list) {
    const x = row[0], total = x.length + word.length;
    if (2 * Math.min(x.length, word.length) / total < cutoff) continue;
    const used = new Map();
    let common = 0;
    for (const c of x) if ((used.get(c) || 0) < (need.get(c) || 0)) { used.set(c, (used.get(c) || 0) + 1); common++; }
    if (2 * common / total < cutoff) continue;
    const r = ratio(x, word);
    if (r >= cutoff) hits.push([r, row]);
  }
  return hits.sort((p, q) => q[0] - p[0] || (q[1][0] > p[1][0] ? 1 : -1)).slice(0, n).map(h => h[1]);
}

let tokIndex = null;
async function search(query, limit = 8) {
  const q = nameKey(query).slice(0, 80);
  if (!q) return [];
  const list = await names();
  tokIndex ||= list.map(([k, d]) => [k, d, k.split(" ")]);
  const qt = q.split(" "), hits = [];
  for (const [k, d, kt] of tokIndex) {
    if (k.startsWith(q)) hits.push([0, k, d]);
    else if (qt.every(t => kt.some(w => w.startsWith(t)))) hits.push([1, k, d]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || (a[1] < b[1] ? -1 : 1));
  const out = hits.slice(0, limit).map(([, key, name]) => ({ key, name }));
  if (out.length < limit && q.length >= 4) {
    const seen = new Set(out.map(o => o.key));
    for (const [key, name] of closeMatches(q, list, limit, 0.75)) if (!seen.has(key) && out.length < limit) out.push({ key, name });
  }
  return out;
}

const TIERS = [
  { name: "Final Boss", blurb: "Trophy shelf needs a second shelf.", light: "red", color: "--red" },
  { name: "TOC-Bound", blurb: "Already looking at Lexington hotels.", light: "red", color: "--red-dim" },
  { name: "Bid Hunter", blurb: "One bid down, hungry for two.", light: "amber", color: "--amber" },
  { name: "Circuit Regular", blurb: "Knows the circuit. Knows the drills.", light: "amber", color: "--amber-dim" },
  { name: "Local Menace", blurb: "Undefeated in their zip code.", light: "green", color: "--green-dim" },
  { name: "Free Real Estate", blurb: "Tabroom has receipts, and they're not scary.", light: "green", color: "--green" },
  { name: "Mystery Box", blurb: "No Tabroom trail. Freshman or sleeper agent.", light: "unlit", color: "--unlit" },
];
const tierLight = t => TIERS.find(x => x.name === t)?.light || "unlit";

const ordinal = n => `${n}${n % 100 >= 10 && n % 100 <= 20 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
const DEPTH = { S: "Semis", Q: "Quarters", O: "Octos", P: "Prelims" };
function fmtResult(h) {
  const [date, , short, , depth, place, , field] = h;
  const head = depth === "F" ? (place ? ordinal(place) : "Finals") : DEPTH[depth] || "Prelims";
  const top = depth !== "F" && place && field ? ` (top ${Math.max(1, Math.ceil(100 * place / field))}%)` : "";
  return `${head} @ ${short} '${String(date).slice(2, 4)}${top}`;
}

/* Safe DOM builder: strings become text nodes, attributes go through setAttribute, never innerHTML. */
const PROPS = new Set(["value", "checked", "selected", "indeterminate"]);
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (typeof v === "function") n.addEventListener(k.replace(/^on/, ""), v);
    else if (k === "dataset") Object.assign(n.dataset, v);
    else if (PROPS.has(k)) n[k] = v;
    else if ((k === "href" || k === "src") && /^\s*javascript:/i.test(v)) continue;
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  n.append(...kids.flat(Infinity).filter(c => c != null && c !== false).map(c => c instanceof Node ? c : String(c)));
  return n;
}

/* Hash router: #/name?params. Fresh navigations scroll to the top; back/forward restores the old position. */
const routes = new Map(), scrolls = new Map(), TITLE = document.title;
let fresh = false, started = false, shown = null, seq = 0;
const isRoute = h => h === "" || h === "#" || h.startsWith("#/");
function parse() {
  const h = isRoute(location.hash) ? location.hash.replace(/^#\/?/, "") : "", i = h.indexOf("?");
  let name = i < 0 ? h : h.slice(0, i);
  try { name = decodeURIComponent(name); } catch { name = "?"; }
  return { name: name.replace(/\/+$/, ""), params: new URLSearchParams(i < 0 ? "" : h.slice(i + 1)) };
}
async function render() {
  if (shown !== null) scrolls.set(shown, scrollY);
  const first = shown === null, isFresh = fresh || first, mine = ++seq, { name, params } = parse();
  fresh = false;
  shown = location.hash;
  const view = el("div", { class: "route", "data-name": name });
  document.getElementById("view").replaceChildren(view);
  document.title = TITLE;
  for (const a of document.querySelectorAll("[data-route]")) {
    if (a.dataset.route === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  const fn = routes.get(name);
  try {
    if (fn) await fn(view, params);
    else view.append(el("h1", { class: "page-h" }, "Page not found"),
                     el("p", { class: "sub" }, "That link doesn't go anywhere on this site. ", el("a", { href: "#/" }, "Check a chamber"), " instead."));
  } catch (e) {
    console.error(e);
    view.append(el("p", { class: "err", role: "alert" }, e.message || "Something went wrong loading this page."));
  }
  if (mine !== seq) return;
  if (!first) {
    const h = view.querySelector("h1, h2");
    if (h) { if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
  }
  scrollTo(0, isFresh ? 0 : scrolls.get(shown) || 0);
}
function route(name, fn) {
  routes.set(name, fn);
  if (started && parse().name === name) render();
}
function go(hash) {
  const h = `#${String(hash).replace(/^#/, "")}`;
  fresh = true;
  if (h === location.hash) render(); else location.hash = h;
}
history.scrollRestoration = "manual";
addEventListener("hashchange", render);
document.addEventListener("click", e => {
  if (e.target.closest?.("a.skip")) { e.preventDefault(); document.getElementById("view").focus(); return; }
  const a = e.target.closest?.("a[href^='#/']");
  if (a && !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) fresh = true;
}, true);
document.addEventListener("DOMContentLoaded", () => { started = true; render(); });

meta().then(m => {
  for (const [raw, k] of m.key_tests || []) if (nameKey(raw) !== k) console.error("name_key mismatch", { raw, js: nameKey(raw), py: k });
  for (const [k, h] of m.hash_tests || []) if (shardOf(k) !== h) console.error("shard hash mismatch", { key: k, js: shardOf(k), py: h });
  const f = document.getElementById("foot-data");
  if (f) f.textContent = `Data updated ${new Date(m.built_at).toLocaleDateString([], { dateStyle: "long" })} from ${m.tournaments.toLocaleString()} Tabroom tournaments, ` +
    `${m.seasons[0]} to ${m.seasons.at(-1)}. It refreshes every Monday.`;
}, () => {});

window.CS = {
  meta, names, nameKey, shardOf, people, lookupName, person, search, closeMatches,
  rankings: () => extra("rankings"), chambers: () => extra("chambers"), sample: () => extra("sample"),
  route, go, el, TIERS, tierLight, fmtResult,
};
})();
