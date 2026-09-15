"""What a person or an agent is shown about the shared instances, and the one reader behind it.

Three surfaces — `junon instances`, `ide_status`, `/junon/instances` — and one function, so they
cannot disagree about what is alive. The function is pinned here; each surface is pinned to it.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from junon import instances

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
LAUNCH = "import sys, runpy; sys.path.insert(0, sys.argv.pop(1)); runpy.run_module('junon', run_name='__main__', alter_sys=True)"


@pytest.fixture(autouse=True)
def isolated_registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv(instances.REGISTRY_ENV_VAR, str(tmp_path))
    return tmp_path


class TestDescribe:
    def test_nothing_running_is_said_in_words(self) -> None:
        assert instances.describe() == []
        assert "No shared JUNON instance" in instances.describe_text()

    def test_an_instance_is_described_with_its_sessions_and_whether_it_is_this_process(self, tmp_path: Path) -> None:
        instances.publish_instance(tmp_path, 4242)
        instances.publish_client(tmp_path, instance_pid=instances.instance_for(tmp_path).pid)

        [entry] = instances.describe(now=instances.instance_for(tmp_path).started_at + 125)

        assert entry["root"] == str(tmp_path.resolve())
        assert entry["port"] == 4242
        assert entry["uptime_seconds"] == 125
        assert entry["clients"] == [instances.instance_for(tmp_path).pid]
        assert entry["this_process"] is True
        text = instances.describe_text([entry])
        assert "1 session(s) attached" in text and "this one is answering you" in text and "up 2 min" in text

    def test_an_instance_with_no_session_says_it_will_leave(self, tmp_path: Path) -> None:
        instances.publish_instance(tmp_path, 1)

        assert "no session attached — it will exit when idle" in instances.describe_text()

    def test_describing_prunes_the_dead(self, tmp_path: Path) -> None:
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        proc.wait()
        path = instances.publish_instance(tmp_path, 1, pid=proc.pid)

        assert instances.describe() == []
        assert not path.exists()


class TestSurfaces:
    def test_the_subcommand_prints_the_description_and_json_on_request(self, tmp_path: Path) -> None:
        instances.publish_instance(tmp_path, 4242)
        env = {"PATH": "/usr/bin:/bin", instances.REGISTRY_ENV_VAR: str(tmp_path)}

        text = subprocess.run([sys.executable, "-c", LAUNCH, str(PACKAGE_ROOT), "instances"], capture_output=True, text=True, env=env, check=True).stdout
        raw = subprocess.run([sys.executable, "-c", LAUNCH, str(PACKAGE_ROOT), "instances", "--json"], capture_output=True, text=True, env=env, check=True).stdout

        assert "port 4242" in text
        assert json.loads(raw)[0]["port"] == 4242

    def test_ide_status_carries_the_description_whatever_the_ide_half_says(self, tmp_path: Path) -> None:
        """The tool an agent calls first; a session sharing its JUNON should learn it there."""
        from unittest.mock import patch

        from junon.tools import IdeStatusTool

        instances.publish_instance(tmp_path, 4242)
        tool = IdeStatusTool.__new__(IdeStatusTool)
        with patch.object(IdeStatusTool, "_ide_report", return_value="No IDE Bridge daemon is reachable."):
            answer = tool.apply()

        assert answer.startswith("No IDE Bridge daemon is reachable.")
        assert "1 shared JUNON instance(s)" in answer and "port 4242" in answer

    def test_the_dashboard_route_serves_the_same_reader(self, tmp_path: Path) -> None:
        from flask import Flask

        from junon.dashboard import JunonDashboardAPI

        instances.publish_instance(tmp_path, 4242)
        api = JunonDashboardAPI.__new__(JunonDashboardAPI)
        api._app = Flask("test")
        api._setup_junon_routes()

        with api._app.test_client() as web:
            body = web.get("/junon/instances").get_json()

        assert body["instances"][0]["port"] == 4242
