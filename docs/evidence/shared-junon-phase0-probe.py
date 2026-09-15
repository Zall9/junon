"""Phase 0 of docs/SHARED_JUNON_PLAN.md: one JUNON over streamable-http, two clients at once.

Measures, in this order:
  1. start-up of the shared instance (process start -> first `find_symbol` answer);
  2. a second client's connect + first answer, against that already-warm instance;
  3. 20 calls from each of two clients, concurrently — correctness and wall time per call;
  4. the same 20 calls from one client alone — the contention cost is the difference;
  5. how many language-server processes the instance holds;
  6. for comparison, a fresh stdio JUNON: start -> first `find_symbol` answer.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import time
from contextlib import asynccontextmanager

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client

ROOT = "/Users/pauldelifer/dev/moneta"
JUNON = os.path.expanduser("~/.local/bin/junon")

# Two files, so that each client asks about a different one and a cross-wired answer shows.
ASKS = [
    ("integrations/serena/junon/compose.py", "compose"),
    ("integrations/serena/junon/client.py", "IdeBridgeClient"),
]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def text_of(result) -> str:
    return "".join(getattr(c, "text", "") for c in result.content)


def ls_processes() -> list[str]:
    out = subprocess.run(["ps", "-Ao", "pid,ppid,rss,command"], capture_output=True, text=True).stdout
    names = ("typescript-language-server", "pyright", "basedpyright", "gopls", "intelephense")
    return [line for line in out.splitlines() if any(n in line for n in names)]


@asynccontextmanager
async def http_session(url: str):
    async with streamablehttp_client(url) as (read, write, _):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            yield session, init


async def wait_ready(url: str, deadline_s: float) -> float:
    """Polls until `find_symbol` answers; returns seconds waited. The LS start-up is inside."""
    t0 = time.monotonic()
    last = None
    while time.monotonic() - t0 < deadline_s:
        try:
            async with http_session(url) as (session, _):
                r = await session.call_tool("find_symbol", {"name_path_pattern": ASKS[0][1], "relative_path": ASKS[0][0]})
                if ASKS[0][1] in text_of(r):
                    return time.monotonic() - t0
                last = text_of(r)[:200]
        except Exception as e:  # noqa: BLE001 - the server is not up yet
            last = repr(e)[:200]
        await asyncio.sleep(0.5)
    raise RuntimeError(f"instance never answered: {last}")


async def one_round(session: ClientSession, path: str, symbol: str, tag: str) -> tuple[bool, float]:
    t0 = time.monotonic()
    r = await session.call_tool("find_symbol", {"name_path_pattern": symbol, "relative_path": path})
    ok = symbol in text_of(r) and path in text_of(r)
    return ok, time.monotonic() - t0


async def burst(session: ClientSession, path: str, symbol: str, tag: str, n: int) -> tuple[int, list[float]]:
    wrong = 0
    times = []
    for i in range(n):
        ok, dt = await one_round(session, path, symbol, f"{tag}{i}")
        wrong += 0 if ok else 1
        times.append(dt)
    return wrong, times


async def main() -> None:
    port = free_port()
    url = f"http://127.0.0.1:{port}/mcp"
    ls_before = len(ls_processes())
    env = dict(os.environ)
    proc = subprocess.Popen(
        [JUNON, "start-mcp-server", "--transport", "streamable-http", "--port", str(port),
         "--project", ROOT, "--enable-web-dashboard", "false", "--enable-gui-log-window", "false",
         "--log-level", "WARNING"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env,
    )
    report: dict[str, object] = {"port": port, "pid": proc.pid}
    try:
        report["1_shared_startup_s"] = round(await wait_ready(url, 180), 2)

        # 2. second client against the warm instance
        t0 = time.monotonic()
        async with http_session(url) as (s2, init2):
            r = await s2.call_tool("find_symbol", {"name_path_pattern": ASKS[1][1], "relative_path": ASKS[1][0]})
            report["2_second_client_first_answer_s"] = round(time.monotonic() - t0, 3)
            report["2_instructions_present"] = bool(init2.instructions)
            report["2_second_client_correct"] = ASKS[1][1] in text_of(r)

        # 3. two clients, concurrently
        async with http_session(url) as (a, _), http_session(url) as (b, _):
            t0 = time.monotonic()
            (wa, ta), (wb, tb) = await asyncio.gather(
                burst(a, ASKS[0][0], ASKS[0][1], "A", 20),
                burst(b, ASKS[1][0], ASKS[1][1], "B", 20),
            )
            report["3_concurrent_wall_s"] = round(time.monotonic() - t0, 2)
            report["3_wrong_answers"] = wa + wb
            report["3_mean_call_s_under_contention"] = round(sum(ta + tb) / len(ta + tb), 3)
            report["3_max_call_s_under_contention"] = round(max(ta + tb), 3)

        # 4. one client alone, same 20 calls
        async with http_session(url) as (a, _):
            t0 = time.monotonic()
            wa, ta = await burst(a, ASKS[0][0], ASKS[0][1], "S", 20)
            report["4_alone_wall_s"] = round(time.monotonic() - t0, 2)
            report["4_mean_call_s_alone"] = round(sum(ta) / len(ta), 3)

        # 5. language servers held by the instance
        report["5_ls_processes_added"] = len(ls_processes()) - ls_before
    finally:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()

    # 6. a fresh stdio instance, the way every session starts today
    t0 = time.monotonic()
    params = StdioServerParameters(
        command=JUNON,
        args=["start-mcp-server", "--transport", "stdio", "--project", ROOT,
              "--enable-web-dashboard", "false", "--enable-gui-log-window", "false", "--log-level", "WARNING"],
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as s:
            await s.initialize()
            r = await s.call_tool("find_symbol", {"name_path_pattern": ASKS[0][1], "relative_path": ASKS[0][0]})
            report["6_fresh_stdio_first_answer_s"] = round(time.monotonic() - t0, 2)
            report["6_fresh_stdio_correct"] = ASKS[0][1] in text_of(r)

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
