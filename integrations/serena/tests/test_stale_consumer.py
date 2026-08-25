"""The half that could not be wrong, again — this time it was JUNON itself.

The version check was written the day a stale *daemon* cost an afternoon, so it asks whether the
daemon is older than this JUNON and never the reverse. Found on a live dashboard on 2026-08-25: an
opencode session started at 12:48 was still running the JUNON it imported then, the daemon and every
plugin had moved to 0.2.5 at 15:00, and the card reported

    daemon and every adapter at 0.2.5        agrees: True

which is true, and silent about the only half that was behind. The dashboard that would have told you
is the one served by the stale JUNON.

The asymmetry mattered because the two halves age differently. A daemon is restarted by whoever
rebuilt it. A JUNON lives as long as the agent host that imported it, and hosts run for days.
"""

from __future__ import annotations

from junon.versions import compare

ADAPTER = [{"ideVersion": "GO-261", "version": "0.2.5"}]


class TestAJunonBehindItsDaemon:
    def test_it_is_not_agreement(self) -> None:
        """The exact shape seen on the dashboard: everything at 0.2.5 except the thing reporting."""
        skew = compare("0.2.5", ADAPTER, consumer_version="0.2.4")

        assert not skew.agrees
        assert skew.consumer_is_stale

    def test_the_summary_names_both_versions(self) -> None:
        skew = compare("0.2.5", ADAPTER, consumer_version="0.2.4")

        assert "this JUNON (0.2.4) is older than the daemon (0.2.5)" in skew.summary

    def test_the_remedy_is_a_host_restart_not_an_install(self) -> None:
        """Nothing installs a JUNON that is already the checkout — the process is holding the modules
        it imported. Telling someone to reinstall would send them round a loop that cannot end."""
        skew = compare("0.2.5", ADAPTER, consumer_version="0.2.4")

        assert "restart the host" in skew.remedy
        assert "pnpm -r build" not in skew.remedy

    def test_it_travels_in_the_payload_the_page_reads(self) -> None:
        assert compare("0.2.5", ADAPTER, consumer_version="0.2.4").as_dict()["consumerStale"] is True


class TestTheOtherDirectionStillWorks:
    def test_a_stale_daemon_is_still_caught(self) -> None:
        skew = compare("0.2.4", [{"ideVersion": "GO-261", "version": "0.2.4"}], consumer_version="0.2.5")

        assert not skew.agrees
        assert skew.daemon_is_stale
        assert "pnpm -r build" in skew.remedy

    def test_both_cannot_be_true_at_once(self) -> None:
        """They are opposite comparisons of the same pair; a state where both hold would mean the
        ordering is broken, and the remedy would tell someone to do two contradictory things."""
        for consumer, daemon in (("0.2.4", "0.2.5"), ("0.2.5", "0.2.4"), ("0.2.5", "0.2.5")):
            skew = compare(daemon, ADAPTER, consumer_version=consumer)
            assert not (skew.daemon_is_stale and skew.consumer_is_stale)


class TestWhenNothingIsWrong:
    def test_everything_at_one_version_agrees(self) -> None:
        skew = compare("0.2.5", ADAPTER, consumer_version="0.2.5")

        assert skew.agrees
        assert skew.remedy == ""

    def test_an_unknown_consumer_makes_no_claim(self) -> None:
        """`0.0.0+unpackaged` and an empty version are "no opinion", not "older" — telling someone
        their JUNON is stale because a version string could not be parsed is worse than saying
        nothing."""
        assert compare("0.2.5", ADAPTER, consumer_version="").agrees
        assert compare("0.2.5", ADAPTER, consumer_version="0.0.0+unpackaged").agrees
