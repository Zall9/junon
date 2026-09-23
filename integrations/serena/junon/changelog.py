"""What the dashboard's Changelog tab shows: the last releases, from the notes that ship with this JUNON.

The dashboard is where an update is offered, and until this existed it said nothing about what an
update contained — that was only in `CHANGELOG.md`, in a repository most people never open. The notes
read here are the ones that travel with the running code: the checkout's for an editable install, the
copy packaged in `junon/resources` otherwise. So the page describes what is installed, not whatever
the repository says today.

Rendered to HTML here, from a small subset of Markdown — the one this changelog is written in: bullet
lists with continuation lines, paragraphs, `code`, **bold**, _emphasis_, links, fenced blocks. Every
character is escaped before any of it is turned into markup, so a note can never inject anything into
the page. A relative link is made absolute against the repository, since the page is not served from
it.
"""

from __future__ import annotations

import html
import re
from pathlib import Path
from typing import Any

#: The complete history, for anything older than what the tab shows.
REPOSITORY = "https://github.com/Zall9/junon"
CHANGELOG_URL = f"{REPOSITORY}/blob/main/CHANGELOG.md"

#: Releases shown in the tab.
SHOWN = 3

_RELEASE = re.compile(r"^\d+\.\d+\.\d+$")


def changelog_path() -> Path | None:
    package = Path(__file__).resolve().parent
    for candidate in (package.parents[2] / "CHANGELOG.md", package / "resources" / "CHANGELOG.md"):
        if candidate.is_file():
            return candidate
    return None


def sections(text: str) -> list[tuple[str, str]]:
    """`## <title>` sections, in file order, as (title, body)."""
    found: list[tuple[str, list[str]]] = []
    for line in text.splitlines():
        if line.startswith("## "):
            found.append((line[3:].strip(), []))
        elif found:
            found[-1][1].append(line)
    return [(title, "\n".join(body).strip()) for title, body in found]


def _link(target: str) -> str:
    if re.match(r"^[a-z]+://", target) or target.startswith("#"):
        return target
    return f"{REPOSITORY}/blob/main/{target.lstrip('./')}"


def _inline(escaped: str) -> str:
    """Inline markup over text that is already escaped. Code spans first, so nothing inside them is
    read as markup; their content is set aside and put back at the end."""
    spans: list[str] = []

    def keep(match: re.Match[str]) -> str:
        spans.append(f"<code>{match.group(1)}</code>")
        return f"\x00{len(spans) - 1}\x00"

    out = re.sub(r"`([^`]+)`", keep, escaped)
    out = re.sub(
        r"\[([^\]]+)\]\(([^)\s]+)\)",
        lambda m: f'<a href="{_link(m.group(2))}" target="_blank" rel="noopener">{m.group(1)}</a>',
        out,
    )
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"(?<![\w*])_([^_]+)_(?![\w])", r"<em>\1</em>", out)
    out = re.sub(r"(?<![\w*])\*([^*]+)\*(?![\w*])", r"<em>\1</em>", out)
    return re.sub(r"\x00(\d+)\x00", lambda m: spans[int(m.group(1))], out)


def render(markdown: str) -> str:
    """The subset of Markdown this changelog uses, as HTML. Escaped first, always."""
    blocks: list[str] = []
    items: list[str] = []
    paragraph: list[str] = []
    fence: list[str] | None = None

    def close_paragraph() -> None:
        if paragraph:
            blocks.append(f"<p>{_inline(html.escape(' '.join(paragraph)))}</p>")
            paragraph.clear()

    def close_list() -> None:
        if items:
            blocks.append("<ul>" + "".join(f"<li>{_inline(html.escape(item))}</li>" for item in items) + "</ul>")
            items.clear()

    for line in markdown.splitlines():
        if fence is not None:
            if line.strip().startswith("```"):
                blocks.append(f"<pre><code>{html.escape(chr(10).join(fence))}</code></pre>")
                fence = None
            else:
                fence.append(line)
            continue
        if line.strip().startswith("```"):
            close_paragraph()
            close_list()
            fence = []
        elif line.startswith("- "):
            close_paragraph()
            items.append(line[2:].strip())
        elif line.startswith("  ") and items and line.strip():
            items[-1] += " " + line.strip()
        elif line.startswith("### "):
            close_paragraph()
            close_list()
            blocks.append(f"<h4>{_inline(html.escape(line[4:].strip()))}</h4>")
        elif not line.strip():
            close_paragraph()
            close_list()
        else:
            close_list()
            paragraph.append(line.strip())
    if fence is not None:
        blocks.append(f"<pre><code>{html.escape(chr(10).join(fence))}</code></pre>")
    close_paragraph()
    close_list()
    return "\n".join(blocks)


def recent(path: Path | None = None, shown: int = SHOWN) -> dict[str, Any]:
    """The last `shown` releases, rendered, and where to read the rest."""
    from junon import instances

    path = path or changelog_path()
    answer: dict[str, Any] = {"more": CHANGELOG_URL, "running": instances.running_version(), "versions": []}
    if path is None:
        answer["reason"] = "This JUNON carries no changelog."
        return answer
    releases = [(title, body) for title, body in sections(path.read_text(encoding="utf-8")) if _RELEASE.match(title)]
    answer["versions"] = [{"version": title, "html": render(body)} for title, body in releases[:shown]]
    return answer
