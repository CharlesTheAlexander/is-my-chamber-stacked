/* Look up (#/lookup), The roll (#/rankings), How it works (#/about). Built on window.CS from core.js. */
(() => {
"use strict";

const SITE = "Is My Chamber Stacked?";
const E = CS.el;
const S = (tag, attrs, ...kids) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  n.append(...kids);
  return n;
};
const on = (n, type, fn) => (n.addEventListener(type, fn), n);
const href = (route, params) => `#/${route}${params ? `?${new URLSearchParams(params)}` : ""}`;
const toPid = pid => href("lookup", { pid });
const fmtDate = (d, opts) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
const monthYear = d => fmtDate(d, { month: "short", year: "numeric" });
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const ord = n => `${n}${n % 100 > 10 && n % 100 < 14 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
const light = tier => E("span", { class: "light", "data-l": CS.tierLight(tier), "aria-hidden": "true" });
let seq = 0;

/* h row: [date, tid, tournament, tier, depth, place, bid, field, season] */
const DEPTH = { P: "Prelims", O: "Octos", Q: "Quarters", S: "Semis", F: "Finals" };
const LEVEL = { TOC: "Tournament of Champions", NSDA: "NSDA Nationals", NCFL: "NCFL Grand Nationals", T4: "Tier 4 bid tournament",
  T3: "Tier 3 bid tournament", T2: "Tier 2 bid tournament", T1: "Tier 1 bid tournament", L: "Local tournament" };
const LEVEL_SHORT = { TOC: "TOC", NSDA: "Nationals", NCFL: "NCFL", T4: "Bid, tier 4", T3: "Bid, tier 3", T2: "Bid, tier 2", T1: "Bid, tier 1", L: "Local" };
const kind = t => t === "L" ? "loc" : ["TOC", "NSDA", "NCFL"].includes(t) ? "nat" : "bid";
const resultWord = r => r[4] === "F" && r[5] ? ord(r[5]) : DEPTH[r[4]] || r[4];

/* ---------------------------------------------------------------- charts (shared by Look up and How it works) */

function chartFrame(fig, draw) {
  let w = 0;
  new ResizeObserver(([e]) => {
    const nw = Math.floor(e.contentRect.width);
    if (nw > 0 && nw !== w) draw(w = nw);
  }).observe(fig);
}

/* st = {pts: [{x, y, i}] in reading order, w, byX, slot, mark(p|null)}; draw() refreshes st, then calls the returned hide(). */
function wire(fig, st, lines) {
  const tip = E("div", { class: "ch-tip", role: "status" });
  tip.hidden = true;
  fig.append(tip);
  let cur = -1;
  const hide = () => { cur = -1; tip.hidden = true; st.mark?.(null); };
  const show = k => {
    const p = st.pts[k];
    if (!p) return hide();
    cur = k;
    st.mark?.(p);
    tip.replaceChildren(...lines(p.i));
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${Math.max(0, Math.min(st.w - tw, p.x - tw / 2))}px`;
    tip.style.top = `${p.y - th - 16 < 0 ? p.y + 18 : p.y - th - 16}px`;
  };
  on(fig, "pointermove", e => {
    const r = fig.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = -1, bd = Infinity;
    st.pts.forEach((p, k) => {
      const d = st.byX ? Math.abs(p.x - x) : Math.hypot(p.x - x, p.y - y);
      if (d < bd) [best, bd] = [k, d];
    });
    if (best >= 0 && bd <= (st.byX ? st.slot : 24)) show(best);
    else hide();
  });
  on(fig, "pointerleave", hide);
  on(fig, "blur", hide);
  on(fig, "keydown", e => {
    const n = st.pts.length, step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    let k = null;
    if (step) k = cur < 0 ? (step > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, cur + step));
    else if (e.key === "Home") k = 0;
    else if (e.key === "End") k = n - 1;
    else if (e.key === "Escape") k = -1;
    if (k === null || !n) return;
    e.preventDefault();
    if (k < 0) hide(); else show(k);
  });
  return hide;
}

const KEY_SHAPES = {
  nat: () => S("path", { class: "ch-m ch-nat", d: "M9 2.5L15.5 9L9 15.5L2.5 9Z" }),
  bid: () => S("circle", { class: "ch-m ch-bid", cx: 9, cy: 9, r: 4.5 }),
  loc: () => S("circle", { class: "ch-m ch-loc", cx: 9, cy: 9, r: 3.75 }),
  ring: () => S("g", {}, S("circle", { class: "ch-bidring", cx: 9, cy: 9, r: 7.5 }), S("circle", { class: "ch-m ch-bid", cx: 9, cy: 9, r: 3.5 })),
};
const keyItem = (shape, text) => E("li", {}, S("svg", { width: 18, height: 18, viewBox: "0 0 18 18", "aria-hidden": "true" }, KEY_SHAPES[shape]()), text);

function timeline(fig, h, best) {
  const st = { pts: [], w: 0 };
  const hide = wire(fig, st, i => {
    const r = h[i];
    return [
      E("strong", {}, r[4] === "F" ? (r[5] ? `${ord(r[5])} in finals` : "Made finals") : r[4] === "P" ? "Prelims" : `Made ${DEPTH[r[4]].toLowerCase()}`),
      E("span", {}, `${r[2]}, ${fmtDate(r[0], { month: "short", day: "numeric", year: "numeric" })}`),
      E("span", {}, `${LEVEL[r[3]] || r[3]}${r[7] ? `, ${plural(r[7], "entry", "entries")}` : ""}`),
      r[6] ? E("span", {}, "Earned a TOC bid") : null,
    ].filter(Boolean);
  });
  const years = h.map(r => +r[8].slice(0, 4)), y0 = Math.min(...years), y1 = Math.max(...years);
  chartFrame(fig, w => {
    const L = 70, R = 12, T = 30, BH = 34, H = T + BH * 5 + 30, pw = w - L - R, base = T + BH * 5;
    const t0 = Date.UTC(y0, 6, 1), t1 = Date.UTC(y1 + 1, 6, 1);
    const sx = d => L + (Date.parse(`${d}T12:00:00Z`) - t0) / (t1 - t0) * pw;
    const sy = d => T + (4 - "POQSF".indexOf(d)) * BH + BH / 2;
    const svg = S("svg", { width: w, height: H, viewBox: `0 0 ${w} ${H}`, "aria-hidden": "true" });
    for (const d of "POQSF") {
      svg.append(S("line", { class: "ch-grid", x1: L, x2: w - R, y1: sy(d), y2: sy(d) }),
        S("text", { class: "ch-axis", x: L - 12, y: sy(d), "text-anchor": "end", "dominant-baseline": "middle" }, DEPTH[d]));
    }
    const sw = pw / (y1 - y0 + 1);
    for (let y = y0; y <= y1 + 1; y++) {
      const x = L + (y - y0) * sw;
      svg.append(S("line", { class: "ch-season", x1: x, x2: x, y1: T - 8, y2: base }));
      if (y <= y1) {
        const lab = sw < 72 ? `${y % 100}-${(y + 1) % 100}` : `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
        svg.append(S("text", { class: "ch-axis", x: x + sw / 2, y: base + 21, "text-anchor": "middle" }, lab));
      }
    }
    const order = h.map((_, i) => i).sort((a, b) => "loc bid nat".indexOf(kind(h[a][3])) - "loc bid nat".indexOf(kind(h[b][3])) || (h[a][0] < h[b][0] ? -1 : 1));
    const pts = [];
    for (const i of order) {
      const r = h[i], x = sx(r[0]), y = sy(r[4]), k = kind(r[3]);
      if (r[6]) svg.append(S("circle", { class: "ch-bidring", cx: x, cy: y, r: 9 }));
      svg.append(k === "nat" ? S("path", { class: "ch-m ch-nat", d: `M${x} ${y - 6.5}L${x + 6.5} ${y}L${x} ${y + 6.5}L${x - 6.5} ${y}Z` })
        : S("circle", { class: `ch-m ch-${k}`, cx: x, cy: y, r: k === "loc" ? 3.75 : 4.5 }));
      pts.push({ x, y, i });
    }
    const b = pts.find(p => p.i === best), anchor = b.x > L + pw * 0.7 ? "end" : b.x < L + pw * 0.3 ? "start" : "middle";
    svg.append(S("text", { class: "ch-lab", x: b.x + (anchor === "end" ? 6 : anchor === "start" ? -6 : 0), y: b.y - 15, "text-anchor": anchor }, CS.fmtResult(h[best])));
    const ring = S("circle", { class: "ch-hi", r: 12, visibility: "hidden" });
    svg.append(ring);
    fig.querySelector("svg")?.remove();
    fig.prepend(svg);
    Object.assign(st, {
      w, pts: pts.sort((p, q) => p.x - q.x || q.y - p.y),
      mark: p => p ? (ring.setAttribute("cx", p.x), ring.setAttribute("cy", p.y), ring.removeAttribute("visibility")) : ring.setAttribute("visibility", "hidden"),
    });
    hide();
  });
}

const BANDS = [["Open Season", "green"], ["Manageable", "green"], ["Spicy", "amber"], ["Stacked", "red"], ["Group of Death", "red"]];
const BIN = 2.5;

function histogram(fig, xs, th) {
  const max = Math.ceil(Math.max(...xs, th[3] + 5) / 10) * 10;
  const counts = Array(Math.round(max / BIN)).fill(0);
  for (const v of xs) counts[Math.min(counts.length - 1, Math.max(0, Math.floor(v / BIN)))]++;
  const bandOf = v => BANDS[th.filter(t => v >= t).length][0];
  const st = { pts: [], w: 0, byX: true, slot: 0 };
  const hide = wire(fig, st, i => [
    E("strong", {}, plural(counts[i], "chamber")),
    E("span", {}, `Strength ${i * BIN} to ${(i + 1) * BIN}`),
    E("span", {}, bandOf((i + 0.5) * BIN)),
  ]);
  chartFrame(fig, w => {
    const L = 36, R = 10, T = 44, PH = 160, H = T + PH + 32, pw = w - L - R, base = T + PH;
    const yMax = Math.max(4, Math.ceil(Math.max(...counts) / 4) * 4);
    const sx = v => L + v / max * pw, sy = c => base - c / yMax * PH;
    const svg = S("svg", { width: w, height: H, viewBox: `0 0 ${w} ${H}`, "aria-hidden": "true" });
    for (const c of [0, yMax / 2, yMax]) {
      svg.append(S("line", { class: c ? "ch-grid" : "ch-base", x1: L, x2: w - R, y1: sy(c), y2: sy(c) }),
        S("text", { class: "ch-axis", x: L - 8, y: sy(c), "text-anchor": "end", "dominant-baseline": "middle" }, String(c)));
    }
    for (let v = 0, step = pw < 360 ? 20 : 10; v <= max; v += step) {
      svg.append(S("text", { class: "ch-axis", x: sx(v), y: base + 20, "text-anchor": "middle" }, String(v)));
    }
    const bw = pw / counts.length, barW = Math.min(24, bw - 2), bars = [], pts = [];
    counts.forEach((c, i) => {
      if (!c) return;
      const x = L + i * bw + (bw - barW) / 2, y = sy(c), r = Math.min(4, barW / 2, base - y);
      const bar = S("path", { class: "ch-bar", d: `M${x} ${base}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + barW - r}Q${x + barW} ${y} ${x + barW} ${y + r}V${base}Z` });
      svg.append(bar);
      bars[i] = bar;
      pts.push({ x: x + barW / 2, y, i });
    });
    const edges = [0, ...th, max];
    th.forEach(t => svg.append(S("line", { class: "ch-th", x1: sx(t), x2: sx(t), y1: T - 16, y2: base }),
      S("text", { class: "ch-axis ch-thv", x: sx(t), y: T - 20, "text-anchor": "middle" }, String(t))));
    BANDS.forEach(([name], k) => {
      const a = sx(edges[k]), z = sx(edges[k + 1]);
      if (z - a > name.length * 6.8 + 10) svg.append(S("text", { class: "ch-axis ch-band", x: (a + z) / 2, y: T - 2, "text-anchor": "middle" }, name));
    });
    fig.querySelector("svg")?.remove();
    fig.prepend(svg);
    let lit = null;
    Object.assign(st, { w, pts, slot: bw / 2 + 1, mark: p => { lit?.classList.remove("is-on"); lit = p ? bars[p.i] : null; lit?.classList.add("is-on"); } });
    hide();
  });
  return counts;
}

/* ---------------------------------------------------------------- #/lookup */

function searchBox(value, big) {
  const input = E("input", { type: "search", id: "lk-q", class: "lk-input", value, autocomplete: "off", spellcheck: "false", enterkeyhint: "search",
    role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": "lk-list", placeholder: "First and last name" });
  const list = E("ul", { id: "lk-list", role: "listbox", class: "lk-list", "aria-label": "Matching names" });
  list.hidden = true;
  const form = E("form", { class: big ? "lk-search is-big" : "lk-search", role: "search" },
    E("label", { for: "lk-q", class: big ? "lk-label" : "lk-label sr" }, big ? "Competitor name" : "Look up someone else"),
    E("div", { class: "lk-field" }, input, E("button", { type: "submit", class: "btn" }, "Look up")),
    list);
  let items = [], active = -1, ask = 0, timer;
  const pick = i => {
    active = i;
    [...list.children].forEach((li, k) => li.setAttribute("aria-selected", String(k === i)));
    if (i < 0) return input.removeAttribute("aria-activedescendant");
    input.setAttribute("aria-activedescendant", `lk-opt-${i}`);
    list.children[i].scrollIntoView({ block: "nearest" });
  };
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); pick(-1); };
  const choose = it => { close(); CS.go(href("lookup", { q: it.name })); };
  on(input, "input", () => {
    clearTimeout(timer);
    const v = input.value.trim(), mine = ++ask;
    if (v.length < 2) return close();
    timer = setTimeout(async () => {
      const res = await CS.search(v, 8).catch(() => []);
      if (mine !== ask) return;
      items = res;
      list.replaceChildren(...res.map((it, i) =>
        on(E("li", { id: `lk-opt-${i}`, role: "option", class: "lk-opt", "aria-selected": "false" }, it.name), "click", () => choose(it))));
      list.hidden = !res.length;
      input.setAttribute("aria-expanded", String(!!res.length));
      pick(-1);
    }, 90);
  });
  on(input, "keydown", e => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !list.hidden) {
      e.preventDefault();
      pick(e.key === "ArrowDown" ? (active + 1) % items.length : (active - 1 + items.length) % items.length);
    } else if (e.key === "Escape" && !list.hidden) {
      e.preventDefault();
      close();
    }
  });
  on(input, "blur", () => setTimeout(close, 150));
  on(list, "mousedown", e => e.preventDefault());
  on(form, "submit", e => {
    e.preventDefault();
    if (active >= 0 && !list.hidden) return choose(items[active]);
    const v = input.value.trim();
    if (v) { close(); CS.go(href("lookup", { q: v })); }
  });
  return form;
}

function landing(view, id) {
  document.title = `Look someone up | ${SITE}`;
  const picks = E("div", { class: "lk-picks" });
  view.replaceChildren(E("div", { class: "pg" },
    E("h1", { class: "page-h" }, "Look someone up"),
    E("p", { class: "lede" }, "Search any varsity Congress competitor on Tabroom to see their rating, their tier, and every result since the 2020-21 season."),
    searchBox("", true), picks));
  Promise.all([CS.rankings(), CS.meta()]).then(([rk, meta]) => {
    if (id !== seq) return;
    const season = rk.seasons?.[meta.current_season] || [];
    const top = (season.length >= 6 ? season : rk.overall || []).slice(0, 6);
    if (top.length) picks.replaceChildren(
      E("p", { class: "lk-picks-h" }, season.length >= 6 ? `Or start with this season's points leaders:` : "Or start with the top of the roll:"),
      E("ul", { class: "lk-chips" }, top.map(r => E("li", {}, E("a", { href: toPid(r.pid) }, light(r.tier), r.name)))));
  }, () => {}); // ponytail: quick picks are a nicety; the search box works without rankings.json
}

function profile(view, p) {
  document.title = `${p.name} | ${SITE}`;
  const tier = CS.TIERS.find(t => t.name === p.tier) || { blurb: "" };
  const h = p.h || [], st = p.stats || {}, r = Math.round(p.rating);
  const bids = Object.entries(p.bids || {}).filter(([, n]) => n);
  const others = (p.schools || []).filter(s => s !== p.school);
  const fact = (k, v) => E("div", {}, E("dt", {}, k), E("dd", {}, v));
  const board = E("section", { class: "board lk-board", "aria-label": "Rating and record" },
    E("div", { class: "board-top" },
      E("div", {},
        E("span", { class: "led led-xl", "data-ghost": r >= 100 ? "888" : "88", "aria-hidden": "true" }, E("span", {}, String(r))),
        E("p", { class: "led-cap" }, E("span", { class: "sr" }, `Rating ${r}. `), "Rating, out of 100")),
      E("div", {},
        E("p", { class: "verdict-line" }, "Tier"),
        E("p", { class: "verdict-label" }, light(p.tier), p.tier),
        E("p", { class: "blurb" }, tier.blurb)),
      E("dl", { class: "tally", "aria-label": "Career record" },
        [["Tournaments", st.tournaments ?? p.n], ["Breaks", st.breaks], ["Finals", st.finals], ["Wins", st.wins]]
          .map(([k, v]) => E("div", {}, E("dt", {}, k), E("dd", {}, String(v ?? 0)))))),
    E("div", { class: "mix lk-mix" },
      p.badges?.length ? E("ul", { class: "lk-badges", "aria-label": "Badges" }, p.badges.map(b => E("li", {}, b))) : null,
      E("dl", { class: "lk-facts" },
        fact("TOC bids", bids.length ? bids.map(([s, n]) => `${n} in ${s}`).join(", ") : "None yet"),
        fact("On Tabroom", p.first === p.last ? monthYear(p.first) : `${monthYear(p.first)} to ${monthYear(p.last)}`),
        fact("Record size", ["", "Thin: fewer than 3 results", "Fair: 3 to 7 results", "Solid: 8 or more results"][p.confidence] || "Unknown"))));

  const body = [];
  if (h.length) {
    const kinds = new Set(h.map(x => kind(x[3])));
    const fig = E("figure", { class: "ch", tabindex: "0", role: "group",
      "aria-label": `Results over time, ${plural(h.length, "result")}. Use the arrow keys to step through them. Every result is also in the table below.` });
    timeline(fig, h, p.b ?? 0);
    body.push(E("section", { class: "lk-sec", "aria-labelledby": "lk-chart-h" },
      E("h2", { id: "lk-chart-h" }, "Results over time"),
      E("p", { class: "sub" }, "One mark per result, placed by date and by how far they got. The best result is labeled."),
      E("ul", { class: "ch-key", "aria-label": "Key" },
        kinds.has("nat") ? keyItem("nat", "TOC, Nationals or NCFL") : null,
        kinds.has("bid") ? keyItem("bid", "Bid tournament") : null,
        kinds.has("loc") ? keyItem("loc", "Local tournament") : null,
        h.some(x => x[6]) ? keyItem("ring", "Earned a bid") : null),
      fig));

    const groups = new Map();
    for (const x of h) groups.set(x[8], [...groups.get(x[8]) || [], x]);
    body.push(E("section", { class: "lk-sec", "aria-labelledby": "lk-rec-h" },
      E("h2", { id: "lk-rec-h" }, "Every result"),
      E("p", { class: "sub" }, `${plural(h.length, "result")} across ${plural(groups.size, "season")}, newest first.`),
      E("div", { class: "tbl-wrap" }, E("table", { class: "rec" },
        E("caption", { class: "sr" }, `Every varsity Congress result for ${p.name}, by season`),
        E("thead", {}, E("tr", {},
          E("th", { scope: "col" }, "Date"), E("th", { scope: "col" }, "Tournament"), E("th", { scope: "col" }, "Result"),
          E("th", { scope: "col", class: "wide" }, "Level"), E("th", { scope: "col", class: "is-num wide" }, "Entries"))),
        [...groups].map(([season, rows]) => E("tbody", {},
          E("tr", { class: "rec-season" }, E("th", { colspan: "5", scope: "colgroup" }, season, " ",
            E("span", {}, [plural(rows.length, "result"), plural(rows.filter(x => x[4] !== "P").length, "break"),
              plural(rows.filter(x => x[6]).length, "bid")].join(", ")))),
          rows.map(x => E("tr", x[4] === "F" ? { class: "is-final" } : {},
            E("td", { class: "rec-date" }, fmtDate(x[0], { month: "short", day: "numeric" })),
            E("td", {}, x[2], E("span", { class: "cell-sub narrow-only" }, LEVEL_SHORT[x[3]] || x[3])),
            E("td", { class: "rec-res" }, resultWord(x), x[6] ? [" ", E("span", { class: "tag" }, "Bid")] : null),
            E("td", { class: "rec-lvl wide" }, LEVEL_SHORT[x[3]] || x[3]),
            E("td", { class: "is-num wide" }, x[7] ?? "")))))))));
  } else {
    body.push(E("p", { class: "note lk-sec" }, "The full result list isn't in this data build yet. It arrives with the next weekly refresh."));
  }

  view.replaceChildren(E("div", { class: "pg" },
    searchBox("", false),
    E("h1", { class: "page-h lk-name" }, p.name),
    E("p", { class: "lede" }, p.school || "School not listed"),
    others.length ? E("p", { class: "note lk-also" }, `Also entered as ${others.join("; ")}`) : null,
    board, body));
}

function chooser(view, q, ps) {
  const same = new Set(ps.map(p => p.name)).size === 1;
  document.title = `Which ${same ? ps[0].name : q}? | ${SITE}`;
  view.replaceChildren(E("div", { class: "pg" },
    searchBox(q, false),
    E("h1", { class: "page-h" }, `Which ${same ? ps[0].name : q}?`),
    E("p", { class: "lede" }, `${plural(ps.length, "person", "people")} on Tabroom match that name. Pick the one you mean.`),
    E("ul", { class: "lk-choose" }, ps.map(p => E("li", {}, E("a", { href: toPid(p.pid) },
      light(p.tier),
      E("span", { class: "lk-cn" }, p.name),
      E("span", { class: "lk-cs" }, p.school || "School not listed"),
      E("span", { class: "lk-cm" }, `${p.tier}, rating ${Math.round(p.rating)}. ${plural(p.n, "tournament")}, last seen ${monthYear(p.last)}.`)))))));
}

async function missing(view, q, id, moved) {
  document.title = `Not found | ${SITE}`;
  const sugg = E("div", { class: "lk-picks" });
  view.replaceChildren(E("div", { class: "pg" },
    searchBox(q, false),
    E("h1", { class: "page-h" }, moved ? "That profile moved" : `No one named “${q}”`),
    E("p", { class: "lede" }, moved
      ? "Records can split or merge when the weekly refresh runs. Search for the name again."
      : "That name isn't in any varsity Congress result on Tabroom since 2020-21. Check the spelling, or try a close match."),
    sugg));
  const res = await CS.search(q, 8).catch(() => []);
  if (id !== seq) return;
  sugg.replaceChildren(...res.length
    ? [E("p", { class: "lk-picks-h" }, "Close matches:"),
       E("ul", { class: "lk-chips" }, res.map(it => E("li", {}, E("a", { href: href("lookup", { q: it.name }) }, it.name))))]
    : [E("p", { class: "note" }, "No close matches either. They may compete only at tournaments that don't post results on Tabroom.")]);
}

CS.route("lookup", async (view, params) => {
  const id = ++seq, pid = params.get("pid"), q = (params.get("q") || "").trim();
  if (!pid && !q) return landing(view, id);
  const status = E("p", { class: "pg-status" }, "Looking it up…");
  view.replaceChildren(E("div", { class: "pg" }, searchBox(q, false), status));
  try {
    if (pid) {
      const p = await CS.person(pid);
      if (id !== seq) return;
      return p ? profile(view, p) : missing(view, pid.replace(/#\d+$/, ""), id, true);
    }
    const ps = await CS.lookupName(q);
    if (id !== seq) return;
    if (ps.length === 1) profile(view, ps[0]);
    else if (ps.length) chooser(view, q, ps);
    else await missing(view, q, id, false);
  } catch (e) {
    if (id === seq) status.replaceChildren(E("span", { class: "err" }, e.message));
  }
});

/* ---------------------------------------------------------------- #/rankings */

CS.route("rankings", async (view, params) => {
  const id = ++seq;
  document.title = `The roll | ${SITE}`;
  const status = E("p", { class: "pg-status" }, "Calling the roll…");
  view.replaceChildren(E("div", { class: "pg" }, E("h1", { class: "page-h" }, "The roll"), status));
  let rk, meta;
  try {
    [rk, meta] = await Promise.all([CS.rankings(), CS.meta()]);
  } catch (e) {
    if (id === seq) status.replaceChildren(E("span", { class: "err" }, e.message));
    return;
  }
  if (id !== seq) return;
  const seasons = Object.keys(rk.seasons || {}).sort().reverse();
  const s = seasons.includes(params.get("s")) ? params.get("s") : "overall";
  const all = s === "overall", rows = (all ? rk.overall : rk.seasons[s]) || [];
  const thisSeason = s === meta.current_season;
  const desc = all
    ? `The top ${rows.length} of ${meta.people.toLocaleString("en-US")} competitors by rating. Bids count this season and last.`
    : `The top ${rows.length} by points earned in ${s}${thisSeason ? " so far" : ""}. Every result counts in full, with no discount for age.`;

  const input = E("input", { type: "search", id: "roll-f", class: "roll-f", autocomplete: "off", spellcheck: "false", placeholder: "Name or school" });
  const count = E("p", { class: "roll-count", "aria-live": "polite" });
  const elsewhere = E("a", { href: href("lookup") }, "Search everyone instead");
  const empty = E("tr", { class: "roll-empty" }, E("td", { colspan: "5" }, "No one on this list matches. ", elsewhere, "."));
  const trs = rows.map((r, i) => E("tr", {},
    E("td", { class: "is-num roll-rk" }, String(i + 1)),
    E("td", {}, E("div", { class: "roll-who" }, light(r.tier), E("div", {},
      E("a", { href: toPid(r.pid), class: "roll-nm" }, r.name),
      r.school ? E("span", { class: "cell-sub" }, r.school) : null,
      E("span", { class: "cell-sub narrow-only" }, r.tier),
      all ? null : E("span", { class: "cell-sub narrow-only" }, `Best: ${r.best}`)))),
    E("td", { class: "wide" }, r.tier),
    E("td", { class: "is-num roll-v" }, (all ? r.rating : r.points).toFixed(1)),
    all ? E("td", { class: "is-num" }, String(r.bids || 0)) : E("td", { class: "wide" }, r.best)));
  const keys = rows.map(r => CS.nameKey(`${r.name} ${r.school || ""}`));
  const apply = () => {
    const q = CS.nameKey(input.value);
    let n = 0;
    trs.forEach((tr, i) => { tr.hidden = !!q && !keys[i].includes(q); n += !tr.hidden; });
    empty.hidden = n > 0;
    elsewhere.href = href("lookup", input.value.trim() ? { q: input.value.trim() } : null);
    count.textContent = q ? `${n} of ${rows.length} match` : `${rows.length} ranked`;
  };
  on(input, "input", apply);

  view.replaceChildren(E("div", { class: "pg" },
    E("h1", { class: "page-h" }, "The roll"),
    E("p", { class: "lede" }, "The strongest varsity Congress competitors on Tabroom, ranked."),
    E("nav", { class: "roll-tabs", "aria-label": "Ranking" }, ["overall", ...seasons].map(k =>
      E("a", { href: href("rankings", k === "overall" ? null : { s: k }), ...(k === s ? { "aria-current": "page" } : {}) }, k === "overall" ? "Overall" : k))),
    E("p", { class: "roll-desc" }, desc),
    rows.length ? [
      E("div", { class: "roll-tools" }, E("label", { for: "roll-f" }, "Filter"), input, count),
      E("div", { class: "tbl-wrap" }, E("table", { class: "roll" },
        E("caption", { class: "sr" }, all ? "Overall ranking by rating" : `${s} ranking by points`),
        E("thead", {}, E("tr", {},
          E("th", { scope: "col", class: "is-num" }, "Rank"), E("th", { scope: "col" }, "Competitor"), E("th", { scope: "col", class: "wide" }, "Tier"),
          E("th", { scope: "col", class: "is-num" }, all ? "Rating" : "Points"),
          E("th", { scope: "col", class: all ? "is-num" : "wide" }, all ? "Bids" : "Best result"))),
        E("tbody", {}, trs, empty))),
    ] : E("p", { class: "note roll-none" }, `No ${s} results yet. The roll fills in as tournaments publish on Tabroom.`)));
  apply();
});

/* ---------------------------------------------------------------- #/about */

const TIER_RULE = {
  "Final Boss": "Rating 80 or higher",
  "TOC-Bound": "Rating 60 to 79",
  "Bid Hunter": "Rating 45 to 59",
  "Circuit Regular": "Rating 10 to 44, with real circuit results",
  "Local Menace": "Rating under 60, with less than a quarter of it from bid tournaments or nationals",
  "Free Real Estate": "Rating under 10",
  "Mystery Box": "No varsity Congress result on Tabroom. Counts as 15 in the chamber math.",
};
const FRIED = [["Raw", "under 25"], ["Lightly Toasted", "25 to 49"], ["Golden Brown", "50 to 69"], ["Crispy", "70 to 84"], ["Deep Fried", "85 to 94"], ["Charcoal", "95 or more"]];

const sec = (n, id, title, ...body) => E("section", { class: "ab-sec", "aria-labelledby": `ab-${id}` },
  E("h2", { id: `ab-${id}` }, E("span", { class: "ab-no" }, `Sec. ${n}.`), ` ${title}`), ...body);
const tbl = (caption, head, rows) => E("table", { class: "ab-tbl" },
  E("caption", {}, caption),
  E("thead", {}, E("tr", {}, head.map((x, k) => E("th", { scope: "col", class: k ? "is-num" : "" }, x)))),
  E("tbody", {}, rows.map(([k, ...v]) => E("tr", {}, E("th", { scope: "row" }, k), v.map(x => E("td", { class: "is-num" }, x))))));
const x1 = n => `×${n.toFixed(n < 1 && n * 100 % 10 ? 2 : 1)}`;

CS.route("about", async view => {
  const id = ++seq;
  document.title = `How it works | ${SITE}`;
  view.replaceChildren(E("div", { class: "pg" }, E("h1", { class: "page-h" }, "How it works"), E("p", { class: "pg-status" }, "Loading…")));
  const [m, c] = await Promise.allSettled([CS.meta(), CS.chambers()]);
  if (id !== seq) return;
  if (m.status === "rejected") return view.replaceChildren(E("div", { class: "pg" }, E("h1", { class: "page-h" }, "How it works"), E("p", { class: "err", role: "alert" }, m.reason.message)));
  const meta = m.value, ch = c.value, th = ch?.thresholds || meta.chamber_thresholds;
  const { weight: WEIGHT, depth: DEPTH_PTS, place: PLACE_BONUS, bid: BID_BONUS, prelim_max: PRELIM_MAX, season_mult: RECENCY, topk: TOPK, decay: DECAY, scale: SCALE, local: LOCAL } = meta.scoring;
  const spot = (n, label) => E("div", {}, E("dt", {}, label), E("dd", {}, n));

  const cal = [];
  if (ch?.strengths?.length && th) {
    const xs = ch.strengths, fig = E("figure", { class: "ch ab-hist", tabindex: "0", role: "group",
      "aria-label": `Histogram of ${xs.length} real chamber strengths with the four cutoffs marked. Use the arrow keys to step through the bars. The counts are also in the tables below.` });
    const counts = histogram(fig, xs, th);
    const edges = [-Infinity, ...th, Infinity];
    cal.push(
      E("p", {}, `The chamber labels aren't guesses. We rebuilt ${ch.source}, rating every member only from results before that tournament, exactly as if someone had pasted the chamber in. The cutoffs sit at the 20th, 45th, 70th and 90th percentiles of those rooms, so about one real chamber in five is Open Season and one in ten is a Group of Death.`),
      fig,
      E("table", { class: "ab-tbl ab-bands" },
        E("caption", {}, "Chamber labels"),
        E("thead", {}, E("tr", {}, E("th", { scope: "col" }, "Label"), E("th", { scope: "col" }, "Strength"), E("th", { scope: "col", class: "is-num" }, "Real chambers"))),
        E("tbody", {}, BANDS.map(([name, l], k) => {
          const n = xs.filter(v => v >= edges[k] && v < edges[k + 1]).length;
          return E("tr", {},
            E("th", { scope: "row" }, E("span", { class: "light", "data-l": l, "aria-hidden": "true" }), ` ${name}`),
            E("td", {}, k === 0 ? `under ${th[0]}` : k === 4 ? `${th[3]} and up` : `${th[k - 1]} to ${th[k]}`),
            E("td", { class: "is-num" }, `${Math.round(100 * n / xs.length)}%`));
        }))),
      E("details", { class: "ab-bins" }, E("summary", {}, "Every bar as a number"),
        tbl(`Chambers per ${BIN}-point strength range`, ["Strength", "Chambers"],
          counts.map((n, i) => [`${i * BIN} to ${(i + 1) * BIN}`, String(n)]).filter(([, n]) => n !== "0"))));
  } else {
    cal.push(E("p", { class: "note" }, "The calibration data didn't load. Refresh to try again."));
  }

  view.replaceChildren(E("article", { class: "pg ab" },
    E("h1", { class: "page-h" }, "How it works"),
    E("p", { class: "lede" }, "Every number on this site, explained. These are the real constants from the code, not a summary of them."),

    sec(1, "data", "Where the data comes from",
      E("p", {}, "Everything comes from Tabroom's public results. Every Monday we read every tournament on Tabroom that has published results, from every circuit, back to the 2020-21 season. Only varsity Congress counts: middle school, novice, JV and round-robin events are skipped."),
      E("dl", { class: "figs" },
        spot(meta.tournaments.toLocaleString("en-US"), "Tournaments"),
        spot(meta.people.toLocaleString("en-US"), "Competitors"),
        spot(meta.perfs.toLocaleString("en-US"), "Results"),
        spot(new Date(meta.built_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }), "Last refresh")),
      E("p", {}, "A result is one competitor at one tournament: how far they got, their place if they made finals, whether they earned a TOC bid, and for prelims, how high they ranked in their chamber. Ballots and speaker points aren't used.")),

    sec(2, "score", "How one result is scored",
      E("p", {}, "Going deeper is worth more, bigger tournaments multiply it, a bid adds a bonus, and older results fade."),
      E("p", { class: "ab-formula" }, "points = (round reached + finals place) × tournament weight + bid bonus, all × how long ago"),
      E("div", { class: "ab-grid" },
        tbl("Round reached", ["Round", "Points"], [["Prelims", `0 to ${PRELIM_MAX}`], ...[..."OQSF"].map(d => [DEPTH[d], String(DEPTH_PTS[d])])]),
        tbl("Finals place", ["Place", "Bonus"], PLACE_BONUS.map((b, i) => [ord(i + 1), `+${b}`])),
        tbl("Tournament weight", ["Tournament", "Weight"], [
          ...Object.entries(WEIGHT).map(([t, w]) => [LEVEL_SHORT[t], x1(w)]),
          ["Local", `${x1(LOCAL[0])} to ${x1(LOCAL[1])}`]]),
        tbl("How long ago", ["Season", "Counts"], RECENCY.map((v, i) => [i ? i === 1 ? "Last season" : `${i} seasons ago` : "This season", x1(v)]))),
      E("p", {}, `A bid adds ${BID_BONUS} points after the weight. Prelim points grow with your rank in the chamber: first in the room earns the full ${PRELIM_MAX}. A bid tournament's tier comes from how many bids Tabroom lists for its Congress event: tier 1 is 1 to 6, tier 2 is 7 to 16, tier 3 is 17 to 60, tier 4 is more. A local's weight grows with its size, from ${x1(LOCAL[0])} up to ${x1(LOCAL[1])} at 60 entries. Results older than six seasons don't count.`),
      E("ul", { class: "ab-ex" },
        E("li", {}, E("strong", {}, "Winning the TOC this season: "), `(12 + 12) × 3.0 = ${(12 + 12) * 3} points.`),
        E("li", {}, E("strong", {}, "Semis and a bid at a tier 3 tournament last season: "), `(7 × 1.6 + 3) × 0.9 = ${((7 * 1.6 + 3) * 0.9).toFixed(1)} points.`),
        E("li", {}, E("strong", {}, "Topping your prelim room at a 40-entry local this season: "), `3 × ${(LOCAL[0] + 40 / 200).toFixed(2)} = ${(3 * (LOCAL[0] + 40 / 200)).toFixed(2)} points.`))),

    sec(3, "rating", "From results to a rating",
      E("p", {}, `Your ${TOPK} best results count. The best counts in full and each one after it counts a little less: ${Array.from({ length: TOPK }, (_, i) => `${Math.round(100 * DECAY ** i)}%`).join(", ")}. Showing up more doesn't raise your rating; doing well does.`),
      E("p", { class: "ab-formula" }, `rating = 100 × (1 − e^(−total ÷ ${SCALE}))`),
      E("p", {}, `The curve flattens near the top. A TOC win alone puts you at about ${Math.round(100 * (1 - Math.exp(-72 / SCALE)))}, and more trophies only nudge you toward 100.`),
      E("p", {}, "Bids set a floor. One bid in a season puts you at 45 or higher. Two bids in a season, a TOC semifinal or final, a Nationals final, or a top-six NCFL finish puts you at 60 or higher.")),

    sec(4, "tiers", "Tiers",
      E("p", {}, "Each rating maps to a tier. Every tier has a light, and the tier name always appears next to it."),
      E("ul", { class: "ab-tiers" }, CS.TIERS.map(t => E("li", {}, light(t.name), E("strong", {}, t.name), E("span", {}, TIER_RULE[t.name] || ""), E("em", {}, t.blurb))))),

    sec(5, "strength", "Chamber strength",
      E("p", {}, "Strength is top-heavy, because only the people who break matter."),
      E("p", { class: "ab-formula" }, "strength = 75% × average of the top N + 25% × average of everyone else"),
      E("p", {}, "N is the number of spots that break: a third of the room by default, between 3 and 6, and you can change it. You're left out of your own chamber's strength. Anyone we can't find on Tabroom counts as 15, about what a newcomer scores."),
      th ? E("p", {}, `The label comes from the strength: under ${th[0]} is Open Season, then Manageable, Spicy and Stacked, and ${th[3]} or more is a Group of Death. Sec. 7 shows where those cutoffs come from.`) : null),

    sec(6, "fried", "How fried you are",
      E("p", {}, "We run your chamber 5,000 times. In each run, everyone, you included, has a session drawn around their rating, give or take 15 points, or 22 for Mystery Boxes because we know less about them. Your break odds are the share of runs where you finish in a breaking spot. Fried is 100 minus that."),
      E("p", {}, "Odds never go below 3% or above 95%. Congress is Congress. If we can't find you, you start at 15 with the wider spread, or you can pick your level."),
      E("ol", { class: "doneness ab-done", "aria-label": "Doneness scale" },
        FRIED.map(([name, range], i) => E("li", { style: `--d:var(--d${i + 1})` }, name, E("span", { class: "here" }, range)))),
      E("p", {}, "Each light on the vote board compares that competitor to you:"),
      E("ul", { class: "ab-votes" },
        E("li", {}, E("span", { class: "light", "data-l": "red", "aria-hidden": "true" }), E("strong", {}, "Problem"), " rated more than 15 above you"),
        E("li", {}, E("span", { class: "light", "data-l": "amber", "aria-hidden": "true" }), E("strong", {}, "Coin flip"), " within 15 of you"),
        E("li", {}, E("span", { class: "light", "data-l": "green", "aria-hidden": "true" }), E("strong", {}, "You've got this"), " more than 15 below you"),
        E("li", {}, E("span", { class: "light", "data-l": "unlit", "aria-hidden": "true" }), E("strong", {}, "Unknown"), " not on Tabroom"))),

    sec(7, "cal", "Where the cutoffs come from", ...cal),

    sec(8, "limits", "What it gets wrong",
      E("ul", { class: "ab-limits" },
        E("li", {}, E("strong", {}, "Same name, same person. "), "Tabroom has no IDs for competitors, so results under one name are merged unless two of them competed in the same event. A profile with schools you don't recognize is probably two people. In a chamber check, use Not them."),
        E("li", {}, E("strong", {}, "Local-only debaters are invisible. "), "If your league doesn't post results on Tabroom, you're a Mystery Box, however good you are."),
        E("li", {}, E("strong", {}, "Results arrive late. "), "A tournament shows up after it publishes results on Tabroom and the next Monday refresh runs."),
        E("li", {}, E("strong", {}, "Some rounds are missing. "), "A few tournaments don't publish every elim round, so a quarterfinalist can look like a prelim-only result."),
        E("li", {}, E("strong", {}, "Nicknames split a record. "), "Alex and Alexander are two different people to us."),
        E("li", {}, E("strong", {}, "Presiding officers look like everyone else. "), "Results don't say who presided."),
        E("li", {}, E("strong", {}, "It's a model. "), "The weights are hand-tuned to match how the circuit talks about results. Use it to prep, not to panic.")),
      E("p", {}, E("strong", {}, "Want your name off this site? "),
        E("a", { href: "https://github.com/CharlesTheAlexander/is-my-chamber-stacked/issues/new?title=Remove%20my%20name" }, "Open an issue on GitHub"),
        " with your name as Tabroom shows it. It disappears from chamber checks, profiles and rankings after the next Monday update.")),

    E("p", { class: "ab-fine" }, "Not affiliated with Tabroom.com, the National Speech & Debate Association, the National Catholic Forensic League or the Tournament of Champions. All results belong to the tournaments that published them.")));
});
})();
