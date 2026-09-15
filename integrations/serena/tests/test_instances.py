"""The registry that lets a session find a shared instance, and an instance know it is still used.

Both directions rest on one rule — an entry is trusted only while the process holding its pid is
the process that wrote it — so that rule is what gets pinned here, once per direction, and once for
the two ways it can be broken: a pid that is gone, and a pid that came back as something else.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from junon import instances


@pytest.fixture(autouse=True)
def isolated_registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv(instances.REGISTRY_ENV_VAR, str(tmp_path))
    return tmp_path


def _pid_of_a_process_that_has_exited() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid  # reaped; the pid is free the moment `wait` returns


class TestInstances:
    def test_a_published_instance_is_found_by_its_root(self, tmp_path: Path) -> None:
        instances.publish_instance(tmp_path, 4242)

        found = instances.instance_for(tmp_path)

        assert found is not None
        assert found.pid == os.getpid()
        assert found.port == 4242
        assert found.url == "http://127.0.0.1:4242/mcp"

    def test_the_root_is_compared_after_resolving(self, tmp_path: Path) -> None:
        """Two sessions spell the same directory differently; both must reach the one instance."""
        instances.publish_instance(tmp_path, 1)

        assert instances.instance_for(tmp_path / "sub" / "..") is not None
        assert instances.instance_for(tmp_path / "elsewhere") is None

    def test_an_instance_whose_process_is_gone_is_dropped_and_its_file_removed(self, tmp_path: Path) -> None:
        dead = _pid_of_a_process_that_has_exited()
        path = instances.publish_instance(tmp_path, 1, pid=dead)
        assert path.exists()

        assert instances.instance_for(tmp_path) is None
        assert not path.exists()

    def test_a_recycled_pid_is_not_the_publisher(self, tmp_path: Path) -> None:
        """The failure ADR-0040 names: a live process wearing the pid of the one that wrote the entry."""
        path = instances.publish_instance(tmp_path, 1)
        payload = json.loads(path.read_text())
        payload["started_at"] = payload["started_at"] - 3600  # written by a process an hour older
        path.write_text(json.dumps(payload))

        assert instances.instance_for(tmp_path) is None
        assert not path.exists()

    def test_unpublishing_removes_only_this_process(self, tmp_path: Path) -> None:
        mine = instances.publish_instance(tmp_path, 1)
        instances.unpublish_instance()

        assert not mine.exists()

    def test_a_damaged_entry_is_removed_rather_than_raised(self, tmp_path: Path) -> None:
        directory = tmp_path / "instances"
        directory.mkdir()
        (directory / "999999.json").write_text("{not json")

        assert instances.live_instances() == []
        assert not (directory / "999999.json").exists()


class TestClients:
    def test_a_client_counts_only_for_its_instance(self, tmp_path: Path) -> None:
        instances.publish_client(tmp_path, instance_pid=100)

        assert len(instances.live_clients(instance_pid=100)) == 1
        assert instances.live_clients(instance_pid=200) == []
        assert len(instances.live_clients()) == 1

    def test_a_client_whose_session_died_no_longer_holds_the_instance(self, tmp_path: Path) -> None:
        """This is what turns an idle exit from a timer into a fact about the sessions."""
        instances.publish_client(tmp_path, instance_pid=100, pid=_pid_of_a_process_that_has_exited())

        assert instances.live_clients(instance_pid=100) == []

    def test_unpublishing_a_client_releases_the_instance(self, tmp_path: Path) -> None:
        instances.publish_client(tmp_path, instance_pid=100)
        instances.unpublish_client()

        assert instances.live_clients(instance_pid=100) == []
