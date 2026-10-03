import functools
import http.server
import os
import threading
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect, sync_playwright

SITE = Path(os.environ.get("SITE_DIR", Path(__file__).resolve().parent.parent / "site"))
PREFIX = "/is-my-chamber-stacked"
ROUTES = ["#/", "#/lookup", "#/lookup?q=Bryan Dominguez", "#/rankings", "#/about"]
YALE_A = (
    "Anna Gordeev Arthur Krukau Arya Tangirala Bennett Ortiz Bryan Dominguez Caden Huckelbridge "
    "Claire Hua Cybil Jeanfils Diya Vijayakumar Julia Brown Maya Khan Medha Thirumala Nikhil Khanna "
    "Norah Ferguson Sai Jain"
)


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        path = path.split("?", 1)[0]
        return super().translate_path(path.removeprefix(PREFIX) or "/")

    def log_message(self, *args) -> None:
        pass


@pytest.fixture(scope="session")
def base():
    assert (SITE / "index.html").exists(), f"build the site first: python app.py --export {SITE.name}"
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(SITE)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}{PREFIX}/"
    server.shutdown()


@pytest.fixture(scope="session")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture
def make_page(browser, base):
    contexts = []

    def make(width: int = 1280, height: int = 900) -> tuple[Page, list[str]]:
        ctx = browser.new_context(viewport={"width": width, "height": height})
        ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=base.split("/is-my")[0])
        # Google Fonts is the only external request; stub it so tests run offline and stay deterministic.
        ctx.route(lambda u: not u.startswith(base.split("/is-my")[0]),
                  lambda r: r.fulfill(status=200, body="", content_type="text/css"))
        page = ctx.new_page()
        errors: list[str] = []
        page.on("console", lambda m: errors.append(m.text) if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        contexts.append(ctx)
        return page, errors

    yield make
    for c in contexts:
        c.close()


def open_home(page: Page, base: str) -> None:
    page.goto(base)
    expect(page.locator("#dataline")).to_contain_text("Ratings from")


def run_yale(page: Page, base: str) -> None:
    open_home(page, base)
    page.fill("#paste", YALE_A)
    page.click("#roll")
    expect(page.locator("#chips li")).to_have_count(15)
    page.locator('input[name=me][value="3"]').check(force=True)
    page.click("#run")
    expect(page.locator("#report .dist-title")).to_be_visible()


def test_home_has_meta_line(make_page, base):
    page, errors = make_page()
    open_home(page, base)
    line = page.text_content("#dataline")
    assert "tournaments" in line and "competitors" in line
    assert "Loading" not in line
    assert not errors


def test_sample_button_reports_a_chamber(make_page, base):
    page, errors = make_page()
    open_home(page, base)
    page.locator("#paste-form [data-sample]").click()
    expect(page.locator("#report .verdict-label")).to_be_visible()
    assert page.text_content("#report .verdict-label").strip()
    found = page.text_content("#report .found")
    assert int(found.split(" of ")[0].strip()) >= 10, found
    assert not errors


def test_sample_marks_someone_as_you(make_page, base):
    page, errors = make_page()
    open_home(page, base)
    page.locator("#paste-form [data-sample]").click()
    expect(page.locator("#report .fried-label")).to_be_visible()
    expect(page.locator("#report .row.is-me")).to_have_count(1)
    expect(page.locator("#report .sample-note")).to_contain_text("circuit regular")
    expect(page.locator("#report .row.is-me")).to_contain_text("You")
    page.locator('#chips input[name=me]').first.check(force=True)
    expect(page.locator("#report .sample-note")).to_be_hidden()
    assert not errors


def test_teaser_matches_the_sample_report(make_page, base):
    page, errors = make_page()
    open_home(page, base)
    expect(page.locator("#teaser")).to_be_visible()
    shown = page.text_content("#teaser-n"), page.text_content("#teaser-label")
    page.locator("#teaser [data-sample]").click()
    expect(page.locator("#report .verdict-label")).to_be_visible()
    assert (page.text_content("#report .led-xl > span"), page.text_content("#report .verdict-label").strip()) == shown
    assert not errors


def test_teaser_is_hidden_on_phones(make_page, base):
    page, _ = make_page(375, 812)
    open_home(page, base)
    page.wait_for_load_state("networkidle")
    expect(page.locator("#teaser")).to_be_hidden()
    expect(page.locator("#paste-form [data-sample]")).to_be_visible()


def test_report_collapses_all_but_the_top_five_competitors(make_page, base):
    page, errors = make_page()
    run_yale(page, base)
    assert page.locator("#report .ledger > .entry h3").count() <= 6
    more = page.locator("#report details.more")
    expect(more).to_have_count(1)
    assert not more.evaluate("d => d.open")
    page.evaluate("dispatchEvent(new Event('beforeprint'))")
    assert more.evaluate("d => d.open")
    assert not errors


def test_phone_nav_fits_on_one_row(make_page, base):
    page, _ = make_page(375, 812)
    open_home(page, base)
    assert page.locator(".site-head").bounding_box()["height"] < 100
    assert page.locator(".nav a", has_text="Check a chamber").get_attribute("data-route") == ""


def test_yale_example_shows_fried_section(make_page, base):
    page, errors = make_page()
    run_yale(page, base)
    expect(page.locator("#report .fried-label")).to_be_visible()
    assert page.text_content("#report .fried-label").strip()
    expect(page.locator("#report #fried-h")).to_have_text("How fried you are")
    assert not errors


def test_share_link_round_trip(make_page, base):
    page, errors = make_page()
    run_yale(page, base)
    label = page.text_content("#report .verdict-label").strip()
    page.click("[data-share]")
    url = page.input_value("#share-url")
    assert "#/report?r=" in url
    assert page.evaluate("navigator.clipboard.readText()") == url
    page.goto(url)
    expect(page.locator(".shared .verdict-label")).to_be_visible()
    assert page.text_content(".shared .verdict-label").strip() == label
    expect(page.locator(".shared [data-notme]")).to_have_count(0)
    assert page.locator(".shared a.who-link").count() >= 10
    assert not errors


def test_report_lookup_link_opens_profile(make_page, base):
    page, errors = make_page()
    open_home(page, base)
    page.locator("#paste-form [data-sample]").click()
    expect(page.locator("#report a.who-link").first).to_be_visible()
    page.locator("#report a.who-link").first.click()
    expect(page.locator(".lk-name")).to_be_visible()
    assert page.url.split("#")[1].startswith("/lookup?pid=")
    assert not errors


def share_and_open(page: Page, base: str, extra: str | None = None, adv: str | None = None) -> Page:
    open_home(page, base)
    page.fill("#paste", YALE_A)
    page.click("#roll")
    expect(page.locator("#chips li")).to_have_count(15)
    if extra:
        page.fill("#add-name", extra)
        page.click("#add-form button")
    if adv:
        page.fill("#adv", adv)
    page.click("#run")
    expect(page.locator("#report .found")).to_be_visible()
    page.click("[data-share]")
    shared = page.context.new_page()
    shared.goto(page.input_value("#share-url"))
    expect(shared.locator(".shared .found")).to_be_visible()
    return shared


def test_share_keeps_every_spots_value(make_page, base):
    page, _ = make_page()
    for adv in ("6", "14", "15"):
        shared = share_and_open(page, base, adv=adv)
        expect(shared.locator(".shared .found")).to_contain_text("14 spots break" if adv == "15" else f"{adv} spots break")
        shared.close()


def test_share_opens_with_a_letterless_name(make_page, base):
    page, errors = make_page()
    shared = share_and_open(page, base, extra="1234")
    expect(shared.locator(".shared .found")).to_contain_text("of 16 found")
    assert not errors


def test_broken_share_link_is_handled(make_page, base):
    page, errors = make_page()
    page.goto(base + "#/report?r=" + "x" * 9000)
    expect(page.locator(".shared-head .lede")).to_be_visible()
    assert page.locator("#view .shared .verdict-label").count() == 0


def test_lookup_shows_profile_with_timeline(make_page, base):
    page, errors = make_page()
    page.goto(base + "#/lookup")
    page.fill(".lk-input", "bryan dominguez")
    page.locator(".lk-opt", has_text="Bryan Dominguez").first.click()
    expect(page.locator(".lk-name")).to_have_text("Bryan Dominguez")
    expect(page.locator(".ch .ch-m").first).to_be_visible()
    assert page.locator(".ch .ch-m").count() >= 10
    assert page.locator(".rec tbody tr").count() >= 10
    assert not errors


def test_lookup_escapes_untrusted_query(make_page, base):
    page, errors = make_page()
    page.goto(base + "#/lookup?q=" + "<img src=x onerror=alert(1)>")
    expect(page.locator("#view h1")).to_contain_text("No one named")
    assert page.locator("#view img").count() == 0
    assert not errors


def test_rankings_overall_and_filter(make_page, base):
    page, errors = make_page()
    page.goto(base + "#/rankings")
    rows = page.locator(".roll tbody tr:not(.roll-empty)")
    expect(rows.first).to_be_visible()
    assert rows.count() >= 100
    page.fill(".roll-f", "cary academy")
    expect(page.locator(".roll-count")).to_contain_text(" of ")
    shown = page.locator(".roll tbody tr:not(.roll-empty):visible").count()
    assert 0 < shown < rows.count()
    assert not errors


def test_rankings_season_tab(make_page, base):
    page, errors = make_page()
    page.goto(base + "#/rankings")
    tab = page.locator(".roll-tabs a").nth(1)
    season = tab.text_content()
    tab.click()
    expect(page.locator(".roll-tabs a[aria-current]")).to_have_text(season)
    assert page.locator(".roll tbody tr:not(.roll-empty)").count() == 100
    assert not errors


def test_profile_counts_match_its_table(make_page, base):
    page, errors = make_page()
    page.goto(base + "#/lookup?q=Bella Grubb")
    expect(page.locator(".lk-name")).to_have_text("Bella Grubb")
    rows = page.locator(".rec tbody tr:not(.rec-season)").count()
    assert f"{rows} results across" in page.text_content("#lk-rec-h + .sub")
    assert not errors


def test_back_from_profile_returns_focus_to_the_link(make_page, base):
    page, errors = make_page()
    page.goto(base + "#/rankings")
    link = page.locator(".roll-nm").nth(7)
    name = link.text_content()
    link.click()
    expect(page.locator(".lk-name")).to_be_visible()
    page.go_back()
    expect(page.locator(".roll")).to_be_visible()
    assert page.evaluate("document.activeElement.textContent") == name
    assert not errors


def test_about_renders_histogram(make_page, base):
    page, errors = make_page()
    page.goto(base + "#/about")
    expect(page.locator(".ab-hist")).to_be_visible()
    assert page.locator(".ab-hist .ch-bar").count() >= 10
    assert page.locator(".ab h2").count() >= 8
    assert not errors


@pytest.mark.parametrize("route", ROUTES)
def test_route_has_no_console_errors(make_page, base, route):
    page, errors = make_page()
    page.goto(base + route)
    page.wait_for_load_state("networkidle")
    expect(page.locator("#view h1, #view h2").first).to_be_visible()
    assert not errors


@pytest.mark.parametrize("route", ROUTES)
def test_route_has_no_horizontal_scroll_at_375(make_page, base, route):
    page, _ = make_page(375, 812)
    page.goto(base + route)
    page.wait_for_load_state("networkidle")
    expect(page.locator("#view h1, #view h2").first).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")


def test_report_has_no_horizontal_scroll_at_375(make_page, base):
    page, errors = make_page(375, 812)
    run_yale(page, base)
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    assert not errors


def test_nav_reaches_every_route(make_page, base):
    page, errors = make_page()
    open_home(page, base)
    for text, hash_ in [("Look someone up", "/lookup"), ("Rankings", "/rankings"), ("How it works", "/about"), ("Check a chamber", "/")]:
        page.locator(".site-head nav a", has_text=text).click()
        assert page.url.endswith("#" + hash_)
        expect(page.locator(".site-head nav a[aria-current]")).to_have_text(text)
    assert not errors
