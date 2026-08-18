"""One comparison, three surfaces, and the page that has to agree with the payload.

The rule lives in `junon.versions` because the alternative is three copies that drift, and a product
that says "your plugin is stale" to an agent while the dashboard stays quiet has taught nobody
anything.
"""

from __future__ import annotations

from pathlib import Path

from junon.versions import REMEDY, compare, release_order

PAGE = Path(__file__).resolve().parent.parent / "junon/resources/dashboard/index.html"


def adapter(version: str, ide: str = "GO-261.23567.143") -> dict[str, object]:
    return {"version": version, "ideVersion": ide}


class TestTheComparison:
    def test_it_orders_releases(self) -> None:
        assert release_order("0.2.0", "0.2.1") == -1
        assert release_order("0.2.1", "0.2.0") == 1
        assert release_order("0.9.0", "0.10.0") == -1  # not string order

    def test_it_declines_what_it_cannot_parse(self) -> None:
        """`0.1.0-SNAPSHOT` is what the plugin built as for months. Older would send someone to
        reinstall over a suffix; newer would hide a real mismatch."""
        assert release_order("0.1.0-SNAPSHOT", "0.2.1") == 0
        assert release_order("", "0.2.1") == 0

    def test_agreement_is_a_sentence_too(self) -> None:
        skew = compare("0.2.1", [adapter("0.2.1"), adapter("0.2.1", "PS-253")])

        assert skew.agrees
        assert skew.summary == "daemon and every adapter at 0.2.1"
        assert skew.remedy == ""

    def test_an_older_plugin_is_named_and_the_remedy_is_the_shared_one(self) -> None:
        skew = compare("0.2.1", [adapter("0.2.0"), adapter("0.2.1", "PS-253")])

        assert not skew.agrees
        assert skew.older == ("GO-261.23567.143@0.2.0",)
        assert "GO-261.23567.143@0.2.0" in skew.summary
        assert skew.remedy == REMEDY

    def test_the_same_skew_from_the_other_end_has_the_opposite_remedy(self) -> None:
        """Telling someone to reinstall a plugin that is already ahead sends them the wrong way."""
        skew = compare("0.2.0", [adapter("0.2.1")])

        assert skew.newer == ("GO-261.23567.143@0.2.1",)
        assert "daemon" in skew.summary
        # The daemon is rebuilt and restarted, never reinstalled — and a rebuild without a restart
        # changes nothing, which the sentence has to say because it is the mistake people make.
        assert "Rebuild and restart" in skew.remedy
        assert "a rebuild alone changes nothing" in skew.remedy
        assert REMEDY not in skew.remedy

    def test_a_dict_is_what_the_dashboard_receives(self) -> None:
        payload = compare("0.2.1", [adapter("0.2.0")]).as_dict()

        assert set(payload) == {
            "daemon", "consumer", "older", "newer", "daemonStale", "agrees", "summary", "remedy",
        }
        assert payload["agrees"] is False


class TestThePageAgreesWithThePayload:
    """The card renders fields the endpoint sends. These drift silently — the page would simply show
    nothing — so the names are pinned on both sides."""

    def test_the_card_reads_every_field_the_verdict_carries(self) -> None:
        page = PAGE.read_text()

        assert "status.versions" in page
        for field in ("agrees", "summary", "remedy"):
            assert f"versions.{field}" in page, f"the card never reads {field}"

    def test_it_says_something_when_they_agree_as_well(self) -> None:
        page = PAGE.read_text()
        card = page[page.index("const versions = status.versions;") :][:600]

        assert "Versions:" in card
        assert "Update needed" in card

class TestItSurvivesBeingRendered:
    """Found by opening the page, not by reading it.

    The remedy reached the card inside an `innerHTML` assignment carrying `<IDE>.app/...`, and the
    browser parsed the placeholder as a tag and dropped it. The card displayed
    `.app/Contents/MacOS/ installPlugins` — an instruction nobody can follow, with nothing looking
    wrong.
    """

    def test_the_remedy_carries_nothing_a_parser_will_eat(self) -> None:
        from junon.versions import REMEDY, compare

        for text in (REMEDY, compare("0.2.0", [adapter("0.2.1")]).remedy):
            assert "<" not in text and ">" not in text, text

    def test_the_card_escapes_what_it_renders_anyway(self) -> None:
        """Fixing the string alone would leave the next one to be swallowed as quietly. This text
        arrives from a process, not from a constant a reviewer can eyeball."""
        page = PAGE.read_text()

        assert "function escapeHtml(" in page
        card = page[page.index("const versions = status.versions;") :][:700]
        assert "escapeHtml(versions.summary)" in card
        assert "escapeHtml(versions.remedy)" in card

class TestTheDaemonCanBeTheStaleOne:
    """Until the consumer joined the comparison, this case could not be expressed.

    Everything was compared *to* the daemon, so the daemon was correct by construction: with a daemon
    at 0.2.1 and every plugin at 0.2.1, the answer was "all at 0.2.1" — even with a 0.2.2 JUNON
    talking to it, which is exactly what happened here after a restart without a rebuild.
    """

    def test_a_newer_junon_names_the_daemon(self) -> None:
        skew = compare("0.2.1", [adapter("0.2.1")], consumer_version="0.2.2")

        assert not skew.agrees
        assert skew.daemon_is_stale
        assert "the daemon (0.2.1) is older than this JUNON (0.2.2)" in skew.summary
        assert "pnpm -r build" in skew.remedy

    def test_agreement_still_agrees_when_all_three_match(self) -> None:
        skew = compare("0.2.2", [adapter("0.2.2")], consumer_version="0.2.2")

        assert skew.agrees
        assert skew.remedy == ""

    def test_both_halves_can_be_wrong_at_once_and_the_daemon_comes_first(self) -> None:
        """Updating a plugin against a stale daemon leaves the skew in place, so the order matters."""
        skew = compare("0.2.1", [adapter("0.2.0")], consumer_version="0.2.2")

        assert skew.daemon_is_stale and skew.older
        assert skew.remedy.index("pnpm -r build") < skew.remedy.index(
            "install-jetbrains-plugin.sh"
        )

    def test_without_a_consumer_version_it_says_nothing_about_the_daemon(self) -> None:
        """A caller that does not know its own version must not produce a verdict about anyone."""
        skew = compare("0.2.1", [adapter("0.2.1")])

        assert not skew.daemon_is_stale
        assert skew.agrees
