"""Every update brings the agent hosts' file-tool gate to the release — the shell's and the click's.

Until 0.3.10 the gate on a machine was whatever had been copied there once. When the machine moved to
opencode 2, the copy was ported by hand, lived nowhere else, and advised `serena_find_symbol` — a
tool opencode 2 does not have. The next update would then have overwritten that port with the
repository's opencode-1-only file. Both update routes now run one script, and its `--check` is read
back into the answer.

These run the real script against a home of the test's own: `JUNON_AGENT_GATE_HOME` is set by the
conftest floor, and the machine's `~/.config/opencode` is asserted untouched.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from junon import update_action
from junon.update_action import AgentGates, apply_release, install_agent_gates

REPO = Path(__file__).resolve().parents[3]
SOURCE = REPO / "integrations" / "agent-hosts"
REAL_GATE = Path.home() / ".config" / "opencode" / "plugin" / "junon-first.ts"


@pytest.fixture
def home(tmp_path: Path) -> Path:
    """A home with both agent hosts configured, as the machine has them."""
    target = Path(os.environ[update_action.GATE_HOME_ENV_VAR])
    (target / ".config" / "opencode").mkdir(parents=True)
    (target / ".claude").mkdir(parents=True)
    return target


def gate_in(home: Path) -> Path:
    return home / ".config" / "opencode" / "plugin" / "junon-first.ts"


class TestTheScript:
    def test_a_first_install_puts_this_release_everywhere(self, home: Path) -> None:
        result = install_agent_gates()

        assert result.state == "updated", result
        assert gate_in(home).read_bytes() == (SOURCE / "opencode" / "junon-first.ts").read_bytes()
        assert (home / ".claude" / "hooks" / "junon-first-gate").read_bytes() == (
            SOURCE / "claude-code" / "junon-first-gate"
        ).read_bytes()

    def test_a_second_run_changes_nothing_and_says_so(self, home: Path) -> None:
        install_agent_gates()
        before = gate_in(home).stat().st_mtime_ns

        result = install_agent_gates()

        assert result.state == "current", result
        assert gate_in(home).stat().st_mtime_ns == before

    def test_a_copy_that_differs_is_kept_before_it_is_replaced(self, home: Path) -> None:
        """What the machine had: a hand-ported copy that existed nowhere else."""
        gate_in(home).parent.mkdir(parents=True)
        gate_in(home).write_text("// ported by hand during the migration\n")

        result = install_agent_gates()

        assert result.state == "updated"
        assert gate_in(home).read_bytes() == (SOURCE / "opencode" / "junon-first.ts").read_bytes()
        kept = list((home / ".ide-bridge" / "agent-gate-backups").glob("*/junon-first.ts"))
        assert [copy.read_text() for copy in kept] == ["// ported by hand during the migration\n"]
        # Kept where no host scans for plugins: a backup loaded as a plugin would be a second gate.
        assert not any(".config/opencode" in str(copy) for copy in kept)

    def test_a_second_copy_in_the_other_plugin_directory_is_reported(self, home: Path) -> None:
        """opencode scans `plugin/` and `plugins/`; a copy in each would judge every call twice."""
        install_agent_gates()
        stray = home / ".config" / "opencode" / "plugins" / "junon-first.ts"
        stray.parent.mkdir(parents=True)
        stray.write_bytes(gate_in(home).read_bytes())

        assert install_agent_gates().state == "differs"

    def test_a_host_that_is_not_configured_is_left_alone(self, tmp_path: Path) -> None:
        bare = Path(os.environ[update_action.GATE_HOME_ENV_VAR])
        bare.mkdir(parents=True, exist_ok=True)

        result = install_agent_gates()

        assert result.state == "current"
        assert not (bare / ".config").exists() and not (bare / ".claude").exists()

    def test_the_machine_is_never_touched(self, home: Path) -> None:
        before = REAL_GATE.stat().st_mtime_ns if REAL_GATE.exists() else None

        install_agent_gates()

        after = REAL_GATE.stat().st_mtime_ns if REAL_GATE.exists() else None
        assert after == before, "a test installed a gate into the machine's own opencode"


class TestTheClick:
    """`apply_release` — the dashboard's install button — runs the same step and reports it."""

    @pytest.fixture
    def machine_steps(self, monkeypatch: pytest.MonkeyPatch):
        from junon import daemon_control

        monkeypatch.setattr(update_action, "install", lambda **_: update_action.InstallOutcome(
            installed=(), unchanged=("GoLand",), failed=(), running=(),
        ))
        monkeypatch.setattr(update_action, "record_daemon_command", lambda: None)
        monkeypatch.setattr(update_action, "refresh_instances", lambda: ())
        restart = lambda: daemon_control.Restart("restarted", "Daemon replaced.", 1, 2)  # noqa: E731
        check = lambda: {"agrees": True, "sentence": "Verified.", "wanted": "9.9.9"}  # noqa: E731
        return restart, check

    def test_a_click_updates_the_gates_and_says_so(self, machine_steps) -> None:
        restart, check = machine_steps
        calls: list[str] = []

        def gates() -> AgentGates:
            calls.append("gates")
            return AgentGates("updated", "The agent gates were updated (1 file(s)).")

        answer = apply_release(restart_daemon=restart, check=check, install_gates=gates)

        assert calls == ["gates"]
        assert answer["agentGates"] == {"state": "updated", "reason": "The agent gates were updated (1 file(s))."}
        assert "agent gates were updated" in answer["next"]
        assert answer["ok"] is True

    def test_a_gate_that_still_differs_is_not_a_success(self, machine_steps) -> None:
        restart, check = machine_steps

        answer = apply_release(
            restart_daemon=restart, check=check, install_gates=lambda: AgentGates("differs", "Still differs.")
        )

        assert answer["ok"] is False
        assert answer["agentGates"]["state"] == "differs"
