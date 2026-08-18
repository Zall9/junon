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
        assert "restart the daemon" in skew.remedy
        assert REMEDY not in skew.remedy

    def test_a_dict_is_what_the_dashboard_receives(self) -> None:
        payload = compare("0.2.1", [adapter("0.2.0")]).as_dict()

        assert set(payload) == {"daemon", "older", "newer", "agrees", "summary", "remedy"}
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
