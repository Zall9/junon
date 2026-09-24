"""The Claude Code gate, run the way Claude Code runs it: a process per call, JSON on stdin.

Exit 2 with a reason on stderr refuses the call; exit 0 lets it run. The gate keeps its memory in
marker files, pointed at the test's own directory so no run shares state with another — or with the
Claude Code session running the suite.

It has the opencode gate's rules (integrations/agent-hosts/opencode/junon-first.ts), minus what
Claude Code cannot do: a hook there cannot change which tool runs, so a whole read of a large file is
refused where opencode 2 answers it with an outline.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

GATE = Path(__file__).resolve().parents[2] / "agent-hosts" / "claude-code" / "junon-first-gate"


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    (root / "src").mkdir(parents=True)
    (root / "src" / "big.ts").write_text("export const line = 1\n" * 400)
    (root / "src" / "small.ts").write_text("export const a = 1\n")
    return root


@pytest.fixture
def ask(tmp_path: Path, project: Path):
    markers = tmp_path / "markers"
    markers.mkdir()

    def run(tool: str, tool_input: dict, session: str = "s1", cwd: Path | None = None) -> tuple[int, str]:
        event = {"session_id": session, "cwd": str(cwd or project), "tool_name": tool, "tool_input": tool_input}
        done = subprocess.run(
            [sys.executable, str(GATE)],
            input=json.dumps(event),
            capture_output=True,
            text=True,
            env={**os.environ, "JUNON_GATE_MARKERS": str(markers)},
            timeout=30,
        )
        return done.returncode, done.stderr

    run.markers = markers  # type: ignore[attr-defined]
    return run


class TestAWholeLargeFile:
    def test_is_refused_on_every_try(self, ask, project: Path) -> None:
        for _ in range(4):
            code, reason = ask("Read", {"file_path": str(project / "src/big.ts")})
            assert code == 2
            assert "will not be on another try" in reason

    def test_is_advised_with_a_project_relative_path_under_the_right_argument(self, ask, project: Path) -> None:
        _, reason = ask("Read", {"file_path": str(project / "src/big.ts")})

        assert 'mcp__serena__ide_symbols_overview(relative_path="src/big.ts")' in reason
        assert "path=" not in reason.replace("relative_path=", "").replace("file_path", "")

    def test_a_range_always_passes(self, ask, project: Path) -> None:
        assert ask("Read", {"file_path": str(project / "src/big.ts"), "offset": 1, "limit": 80})[0] == 0

    def test_a_file_outside_the_project_passes(self, ask, tmp_path: Path) -> None:
        elsewhere = tmp_path / "elsewhere.ts"
        elsewhere.write_text("export const line = 1\n" * 400)

        assert ask("Read", {"file_path": str(elsewhere)})[0] == 0

    def test_is_refused_after_the_gate_gave_up_on_the_guesses(self, ask, project: Path) -> None:
        for pattern in ("alphaThing", "betaThing", "gammaThing"):
            assert ask("Grep", {"pattern": pattern})[0] == 2
        # Three ignored: the guesses stop for a session that never used serena...
        assert ask("Grep", {"pattern": "deltaThing"})[0] == 0
        # ...and the large-file rule does not, because its way out is a range, not serena.
        assert ask("Read", {"file_path": str(project / "src/big.ts")})[0] == 2
        assert ask("Bash", {"command": "cat src/big.ts"})[0] == 2


class TestTheShell:
    def test_cat_of_a_large_file_is_refused_on_every_try(self, ask) -> None:
        for _ in range(3):
            code, reason = ask("Bash", {"command": "cat src/big.ts"})
            assert code == 2
            assert "not read whole by any route" in reason

    def test_a_range_or_a_pipeline_passes(self, ask) -> None:
        assert ask("Bash", {"command": "sed -n '1,80p' src/big.ts"})[0] == 0
        assert ask("Bash", {"command": "head -50 src/big.ts"})[0] == 0
        assert ask("Bash", {"command": "cat src/big.ts | wc -l"})[0] == 0

    def test_a_quoted_alternation_is_one_pattern(self, ask) -> None:
        # Split naively on `|`, this was `grep "startWorkflow` — a bare identifier — and was refused.
        assert ask("Bash", {"command": 'grep -rnE "startWorkflow|compose" src'})[0] == 0

    def test_a_grep_fed_by_a_pipe_filters_output(self, ask) -> None:
        assert ask("Bash", {"command": "git log --oneline | grep startWorkflow"})[0] == 0
        # Control: over the files, it is still a question about a symbol.
        assert ask("Bash", {"command": "grep -rn startWorkflow src"}, session="s2")[0] == 2


class TestTheGuesses:
    def test_a_bare_identifier_grep_is_refused_once(self, ask) -> None:
        assert ask("Grep", {"pattern": "startWorkflow"})[0] == 2
        assert ask("Grep", {"pattern": "startWorkflow"})[0] == 0

    def test_a_grep_aimed_outside_the_project_passes(self, ask, tmp_path: Path) -> None:
        assert ask("Grep", {"pattern": "startWorkflow", "path": str(tmp_path / "other")})[0] == 0

    def test_a_short_file_is_nudged_once_per_session(self, ask, project: Path) -> None:
        small = {"file_path": str(project / "src/small.ts")}
        assert ask("Read", small)[0] == 2
        assert ask("Read", small)[0] == 0

    def test_a_session_that_used_serena_is_not_nudged_about_short_files(self, ask, project: Path) -> None:
        assert ask("mcp__serena__find_symbol", {"name_path_pattern": "x"})[0] == 0
        assert ask("Read", {"file_path": str(project / "src/small.ts")})[0] == 0


class TestItsOwnHygiene:
    def test_keeps_its_memory_where_it_is_told(self, ask, project: Path) -> None:
        ask("Grep", {"pattern": "startWorkflow"})

        assert list(ask.markers.glob("junon-first-gate-*"))

    def test_fails_open(self, tmp_path: Path) -> None:
        done = subprocess.run(
            [sys.executable, str(GATE)],
            input="not json",
            capture_output=True,
            text=True,
            env={**os.environ, "JUNON_GATE_MARKERS": str(tmp_path)},
            timeout=30,
        )
        assert done.returncode == 0
