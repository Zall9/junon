"""What a session needs to start, kept so that starting one need not start a project.

A host asks two things the moment it launches a relay: `initialize`, whose result carries Serena's
instructions, and `tools/list`. Answering either meant having a live instance, which is why opening
opencode with twenty-three registered projects started twenty-three of them — 55 language servers and
4.16 GB, measured on 2026-09-21, for projects nobody had touched.

Both answers are recorded here the first time a relay does have an instance, so every later session
can be handed them from a file and the project itself started only when something is actually asked
of it.

**Keyed by JUNON version alone, and that is a measurement, not a guess.** Ten live instances across
ten unrelated projects — Go, PHP, TypeScript, Swift — returned byte-identical instructions and the
same thirty-nine tools. Keying by project as well would have been safer in theory and much worse in
practice: every project would pay one eager start after each release, which is exactly the cost this
exists to remove.

**A stale entry corrects itself.** When an instance does start, its real tool list is compared with
the cached one; a difference rewrites the file and sends `tools/list_changed`, which hosts already
honour. A project that genuinely narrows its toolset is therefore right from its first call onwards,
and the worst case is one refresh rather than a wrong answer.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from junon import instances


@dataclass(frozen=True, slots=True)
class Handshake:
    """Everything a host asks while a session opens, and nothing else.

    That was `initialize` and `tools/list` until 0.3.8 — which is what a host was *assumed* to ask.
    Measured on 2026-09-23 with a stdio tap between each host and the relay: opencode 1.18 sends
    `initialize`, `tools/list`; opencode 2.0 sends those **and `prompts/list`**, on every relay it
    opens. The relay answered the first two from this file and opened the instance for the third, so
    under opencode 2 every session start still started its project. The prompt list is recorded now.
    """

    version: str
    instructions: str
    #: Serialised `types.Tool` objects, as the MCP SDK dumps them.
    tools: tuple[dict[str, Any], ...]
    #: Whether the instance offered prompts, so the relay knows which handlers to register.
    prompts: bool = False
    #: Which project it was captured from — for reading the file, never for deciding.
    captured_from: str | None = None
    #: Serialised `types.Prompt` objects. `None` means *not recorded* — a file written by 0.3.8 —
    #: which is not the same as an instance offering none, and the relay treats it that way: it asks
    #: the instance, as 0.3.8 did, and records the answer for next time.
    prompt_list: tuple[dict[str, Any], ...] | None = None

    def as_dict(self) -> dict[str, Any]:
        recorded: dict[str, Any] = {
            "version": self.version,
            "instructions": self.instructions,
            "tools": list(self.tools),
            "prompts": self.prompts,
            "capturedFrom": self.captured_from,
        }
        if self.prompt_list is not None:
            recorded["promptList"] = list(self.prompt_list)
        return recorded

    def tool_names(self) -> tuple[str, ...]:
        return tuple(sorted(str(tool.get("name", "")) for tool in self.tools))

    def prompt_names(self) -> tuple[str, ...] | None:
        if self.prompt_list is None:
            return None
        return tuple(sorted(str(prompt.get("name", "")) for prompt in self.prompt_list))


def directory() -> Path:
    return instances.registry_dir() / "handshake"


def path(version: str | None = None) -> Path:
    return directory() / f"{version or instances.running_version()}.json"


def _refuse_what_the_sdk_would(
    tools: tuple[dict[str, Any], ...], prompts: tuple[dict[str, Any], ...] | None = None
) -> None:
    """Raises if any recorded tool or prompt is not one the MCP SDK would accept.

    Validating here rather than at `tools/list` is the difference between a file that is ignored and
    a session that cannot list its tools at all — which would be worse than the eager start this
    replaces. Pydantic's error is a `ValueError`, so the caller's own net catches it.
    """
    from mcp import types

    for tool in tools:
        types.Tool.model_validate(tool)
    for prompt in prompts or ():
        types.Prompt.model_validate(prompt)


def read(version: str | None = None) -> Handshake | None:
    """The recorded handshake for this JUNON, or `None`. Never raises: a damaged file simply means
    the relay does what it did before this existed, which is correct and merely slower."""
    target = path(version)
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
        tools = tuple(dict(tool) for tool in payload["tools"])
        if not tools:
            return None
        # Absent, not empty: a 0.3.8 file never had the key, and an empty list is an instance that
        # offered no prompts. The two must stay distinguishable.
        prompt_list = payload.get("promptList")
        prompts = None if prompt_list is None else tuple(dict(prompt) for prompt in prompt_list)
        _refuse_what_the_sdk_would(tools, prompts)
        return Handshake(
            version=str(payload["version"]),
            instructions=str(payload.get("instructions") or ""),
            tools=tools,
            prompts=bool(payload.get("prompts", False)),
            captured_from=payload.get("capturedFrom"),
            prompt_list=prompts,
        )
    except (OSError, ValueError, KeyError, TypeError):
        return None


def write(handshake: Handshake) -> Path:
    """Records it, whole then renamed, so a reader never sees half a toolset."""
    target = path(handshake.version)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(handshake.as_dict()), encoding="utf-8")
    os.replace(temporary, target)
    return target


def offers_prompts(init: Any) -> bool:
    return getattr(getattr(init, "capabilities", None), "prompts", None) is not None


def capture(init: Any, tools: Any, root: str, prompts: Any = None) -> Handshake:
    """Turns a live instance's answers into a recordable handshake.

    `prompts` is the instance's prompt list when it offers prompts. An instance that does not offer
    them is recorded with an empty list — answered from the file as *none*, which is true.
    """
    offered = offers_prompts(init)
    if prompts is not None:
        prompt_list: tuple[dict[str, Any], ...] | None = tuple(
            prompt.model_dump(mode="json", exclude_none=True) for prompt in prompts
        )
    else:
        prompt_list = None if offered else ()
    return Handshake(
        version=instances.running_version(),
        instructions=getattr(init, "instructions", None) or "",
        tools=tuple(tool.model_dump(mode="json", exclude_none=True) for tool in tools),
        prompts=offered,
        captured_from=root,
        prompt_list=prompt_list,
    )
