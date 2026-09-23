"""The dashboard's Changelog tab, and the IDE Bridge card's line for the agent gate.

The notes are rendered from the CHANGELOG.md that ships with the running JUNON, escaped before any
markup is added: the tab is the one place the page inserts HTML it did not build itself.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from flask import Flask

from junon import changelog
from junon.dashboard import JunonDashboardAPI

NOTES = """# Changelog

Intro text that is not a release.

## Unreleased

- Something not released yet.

## 2.0.0

- **Bold claim.** With `code`, _emphasis_ and a [relative link](docs/OPENCODE.md).
  A continuation line of the same item.
- An [absolute link](https://example.org/x).

## 1.9.0

Some paragraph.

```bash
echo "<fenced>"
```

## 1.8.0

- Third.

## 1.7.0

- Fourth, which the tab does not show.
"""


@pytest.fixture
def notes(tmp_path: Path) -> Path:
    path = tmp_path / "CHANGELOG.md"
    path.write_text(NOTES)
    return path


def routes() -> Flask:
    api = JunonDashboardAPI.__new__(JunonDashboardAPI)
    api._app = Flask("test")
    api._setup_junon_routes()
    return api._app


class TestTheLastReleases:
    def test_three_releases_newest_first_and_the_rest_linked(self, notes: Path) -> None:
        answer = changelog.recent(notes)

        assert [release["version"] for release in answer["versions"]] == ["2.0.0", "1.9.0", "1.8.0"]
        assert answer["more"] == "https://github.com/Zall9/junon/blob/main/CHANGELOG.md"

    def test_unreleased_notes_are_not_a_release(self, notes: Path) -> None:
        assert "Something not released yet" not in str(changelog.recent(notes))

    def test_the_running_version_is_reported_so_the_page_can_mark_it(self, notes: Path) -> None:
        from junon import instances

        assert changelog.recent(notes)["running"] == instances.running_version()

    def test_the_real_changelog_is_found_and_read(self) -> None:
        """The file this repository ships, not a fixture: a heading format change would show here."""
        answer = changelog.recent()

        assert len(answer["versions"]) == 3
        assert all(release["html"].strip() for release in answer["versions"])


class TestRendering:
    def test_the_subset_the_changelog_uses(self, notes: Path) -> None:
        rendered = changelog.recent(notes)["versions"][0]["html"]

        assert "<strong>Bold claim.</strong>" in rendered
        assert "<code>code</code>" in rendered
        assert "<em>emphasis</em>" in rendered
        assert "A continuation line of the same item." in rendered
        assert rendered.count("<li>") == 2

    def test_a_relative_link_points_at_the_repository(self, notes: Path) -> None:
        rendered = changelog.recent(notes)["versions"][0]["html"]

        assert 'href="https://github.com/Zall9/junon/blob/main/docs/OPENCODE.md"' in rendered
        assert 'href="https://example.org/x"' in rendered

    def test_markup_in_the_notes_is_text_not_markup(self) -> None:
        """Escaped before anything is turned into HTML — in prose, in code spans, in fences."""
        rendered = changelog.render(
            "- A <script>alert(1)</script> and `<img src=x onerror=alert(2)>`\n\n```\n<b>fenced</b>\n```"
        )

        assert "<script>" not in rendered and "<img" not in rendered and "<b>" not in rendered
        assert "&lt;script&gt;" in rendered
        assert "&lt;b&gt;fenced&lt;/b&gt;" in rendered

    def test_a_fenced_block_is_kept_verbatim(self, notes: Path) -> None:
        rendered = changelog.recent(notes)["versions"][1]["html"]

        assert "<pre><code>echo &quot;&lt;fenced&gt;&quot;</code></pre>" in rendered


class TestTheRoutes:
    def test_the_changelog_route_answers(self) -> None:
        with routes().test_client() as web:
            body = web.get("/junon/changelog").get_json()

        assert len(body["versions"]) == 3
        assert body["more"].endswith("/CHANGELOG.md")

    def test_the_bridge_card_carries_the_agent_gate(self, tmp_path: Path) -> None:
        """Shown when current as well as when not: a line that only appears on failure teaches a
        reader that its absence means nothing was checked."""
        with routes().test_client() as web:
            body = web.get("/junon/ide-bridge/status").get_json()

        assert body["agentGates"]["state"] in {"current", "differs"}
        assert body["agentGates"]["summary"]


class TestThePage:
    """The page is not run here — the real dashboard is looked at for that — but its wiring is pinned."""

    PAGE = Path(__file__).resolve().parents[1] / "junon" / "resources" / "dashboard" / "index.html"

    def test_the_tab_the_pane_and_the_route_are_wired(self) -> None:
        page = self.PAGE.read_text()

        assert 'id="tab-changelog"' in page
        assert 'id="changelog-pane"' in page
        assert 'getJson("/junon/changelog")' in page

    def test_the_card_draws_the_gate_line(self) -> None:
        page = self.PAGE.read_text()

        assert "status.agentGates" in page
        assert "Agent gate" in page
