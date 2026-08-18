"""Tools that ask the IDE, registered alongside Serena's own.

These are **additive**. A tool's registered name comes from its class name, so nothing here shadows
or replaces an upstream tool, and nothing upstream has to be edited for them to appear. Replacing
one of Serena's own tools is a different act with a different owner: it is done through
``excluded_tools`` in a configuration a user can read, not silently by composition. A tool the user
configured should not vanish because a package was installed.

Every failure here is an ordinary state reported as a sentence, not an exception. "No IDE is
running" and "this adapter cannot do that" are the two most common answers this system gives, and a
tool that raises on them teaches an agent to treat the whole bridge as broken.
"""

from __future__ import annotations

import json
from abc import ABC
from pathlib import Path
from typing import Any

from serena.tools.tools_base import (
    Tool,
    ToolMarkerCanEdit,
    ToolMarkerDoesNotRequireActiveProject,
    ToolMarkerSymbolicRead,
)

from ide_bridge.models import SYMBOL_KINDS, UNCLASSIFIED

from junon.client import (
    DaemonUnavailableError,
    IdeBridgeClient,
    IdeBridgeError,
    RequestFailedError,
    read_discovery,
)


class IdeBridgeTool(Tool, ABC):
    """Shared plumbing. Defines no ``apply``, so the registry does not register it as a tool."""

    def _client(self) -> IdeBridgeClient:
        return IdeBridgeClient(read_discovery())

    def _workspace_id(self, client: IdeBridgeClient) -> str:
        """Finds the open workspace that contains this project.

        The daemon assigns workspace identifiers; a client cannot invent one — they are constrained
        to ``^ws_[A-Za-z0-9_-]+$`` and mean nothing outside the daemon that issued them. So the only
        honest way to address a workspace is to ask which ones are open and match on the roots the
        IDE reports.
        """
        workspaces = client.call("workspace/list", {}).get("workspaces", [])
        if not workspaces:
            raise RequestFailedError(
                "WORKSPACE_NOT_FOUND",
                "An IDE is connected but has no workspace open.",
            )

        project = Path(self.get_project_root()).resolve()
        for workspace in workspaces:
            for root in workspace.get("roots", []):
                uri = root.get("uri", "")
                if not uri.startswith("file://"):
                    continue
                if _same_tree(Path(uri[len("file://") :]), project):
                    return str(workspace["workspaceId"])

        opened = ", ".join(str(w.get("name", "?")) for w in workspaces)
        raise RequestFailedError(
            "WORKSPACE_NOT_FOUND",
            f"No open workspace covers {project}. The IDE has these open: {opened}. "
            "Open this project in your IDE, or activate the project the IDE has open.",
        )

    def _resolve_workspace(self, call: Any) -> str:
        """The workspace lookup, on a caller-supplied session rather than its own connection."""
        workspaces = call("workspace/list", {}).get("workspaces", [])
        if not workspaces:
            raise RequestFailedError(
                "WORKSPACE_NOT_FOUND", "An IDE is connected but has no workspace open."
            )
        project = Path(self.get_project_root()).resolve()
        for workspace in workspaces:
            for root in workspace.get("roots", []):
                uri = root.get("uri", "")
                if uri.startswith("file://") and _same_tree(Path(uri[len("file://") :]), project):
                    return str(workspace["workspaceId"])
        opened = ", ".join(str(w.get("name", "?")) for w in workspaces)
        raise RequestFailedError(
            "WORKSPACE_NOT_FOUND",
            f"No open workspace covers {project}. The IDE has these open: {opened}.",
        )

    def _explain(self, error: IdeBridgeError) -> str:
        """Turns a typed failure into something an agent can act on.

        The protocol's code is preserved verbatim. It is the part a caller can reason about —
        ``CAPABILITY_UNAVAILABLE`` means ask something else, ``TIMEOUT`` means ask again — and
        replacing it with prose would make a refusal indistinguishable from a defect.
        """
        if isinstance(error, DaemonUnavailableError):
            return (
                "No IDE Bridge daemon is reachable. This is normal when no IDE is open: start your "
                f"IDE with the IDE Bridge plugin installed and try again. ({error})"
            )
        if isinstance(error, RequestFailedError):
            again = " This one is worth retrying." if error.retryable else ""
            # The daemon supplies the code as the message when it has nothing better to say, which
            # rendered as "[CAPABILITY_UNAVAILABLE] CAPABILITY_UNAVAILABLE: CAPABILITY_UNAVAILABLE"
            # — three copies of one word, and no help. Say the code once and let the subclass add
            # what it knows about its own route.
            detail = str(error).replace(f"{error.code}: ", "", 1).strip()
            if detail in {error.code, ""}:
                return f"The IDE refused: [{error.code}].{again}{self._advice(error)}"
            return f"The IDE refused: [{error.code}] {detail}{again}{self._advice(error)}"
        return f"The IDE Bridge could not answer: {error}"

    def _advice(self, error: RequestFailedError) -> str:
        """What this particular route can add about a refusal. Nothing, by default.

        Takes the error rather than its code: some refusals are only actionable through their
        data — `STALE_DOCUMENT` carries the revision to prepare against — and a signature that
        saw only the code could not reach it.
        """
        return ""


def _same_tree(candidate: Path, project: Path) -> bool:
    try:
        resolved = candidate.resolve()
    except OSError:
        return False
    return resolved == project or project.is_relative_to(resolved)


class IdeStatusTool(IdeBridgeTool, ToolMarkerDoesNotRequireActiveProject):
    """Reports whether an IDE is connected, and what it has open."""

    def apply(self) -> str:
        """
        Check whether an IDE is connected through the IDE Bridge, and which workspaces it has open.

        Call this first when another IDE tool reports that nothing is reachable, to tell "no IDE is
        running" apart from "the IDE is running but does not have this project open".

        :return: a human-readable description of the daemon and the workspaces it can see.
        """
        try:
            client = self._client()
            workspaces = client.call("workspace/list", {}).get("workspaces", [])
        except IdeBridgeError as error:
            return self._explain(error)

        if not workspaces:
            # Measured against a real daemon with no adapter attached: an empty list is all the
            # daemon says. It does not distinguish "no IDE connected" from "an IDE is connected
            # with nothing open", so neither does this — claiming either would be a guess.
            return (
                "The IDE Bridge daemon is running, but reports no open workspace. Either no IDE is "
                "connected to it, or the connected IDE has no project open."
            )

        lines = [f"An IDE is connected with {len(workspaces)} workspace(s) open:"]
        lines.extend(self._version_lines(client))
        for workspace in workspaces:
            roots = ", ".join(root.get("uri", "?") for root in workspace.get("roots", []))
            trust = workspace.get("trust", {})
            lines.append(f"  - {workspace.get('name', '?')} [{workspace['workspaceId']}] {roots}")
            lines.append(f"    trust: {json.dumps(trust)}")
            # Whether the IDE can answer at all, which this tool did not ask about and is the
            # question a caller reaching for it most often has.
            try:
                status = client.call(
                    "workspace/getStatus", {"workspaceId": workspace["workspaceId"]}
                )["status"]
            except RequestFailedError as error:
                # The code, never the exception's text: a `DaemonUnavailableError` names the
                # endpoint it failed to reach, and this answer is pasted into transcripts. `doctor`
                # holds the same line about the discovery file it reads.
                lines.append(f"    readiness: unknown [{error.code}]")
                continue
            except IdeBridgeError:
                lines.append("    readiness: unknown")
                continue
            state = str(status.get("state", "unknown"))
            lines.append(f"    readiness: {state}{self._readiness_note(state)}")
        return "\n".join(lines)

    def _version_lines(self, client: IdeBridgeClient) -> list[str]:
        """The version of each half, and the remedy when they differ.

        Nothing else tells anyone. An IDE updates its plugin without knowing a daemon exists, `pipx`
        updates this package without knowing either, and the halves read and write the same files —
        so a mismatch is silent by construction and shows up later as a capability that is
        mysteriously absent.

        Reported even when everything agrees, because "all at 0.2.1" is the sentence that makes the
        next answer trustworthy, and a line that only ever appears when something is wrong teaches a
        reader to assume its absence means nothing was checked.
        """
        try:
            daemon = client.call("bridge/getStatus", {}).get("daemonVersion", "unknown")
            adapters = client.call("bridge/listAdapters", {}).get("adapters", [])
        except IdeBridgeError:
            # Never the reason this tool fails: the workspaces above are the answer it was asked for.
            return []

        if not adapters:
            return [f"  versions: daemon {daemon}, no adapter connected"]

        behind = sorted({
            f"{a.get('ideVersion', '?')}@{a.get('version', '?')}"
            for a in adapters
            if _release_order(str(a.get("version", "")), str(daemon)) < 0
        })
        ahead = sorted({
            f"{a.get('ideVersion', '?')}@{a.get('version', '?')}"
            for a in adapters
            if _release_order(str(a.get("version", "")), str(daemon)) > 0
        })

        if not behind and not ahead:
            return [f"  versions: daemon and every adapter at {daemon}"]

        lines = [f"  versions: daemon {daemon}"]
        if behind:
            lines.append(
                f"    older plugin(s): {', '.join(behind)} — rebuild and reinstall, per IDE:"
            )
            lines.append("      scripts/install-jetbrains-plugin.sh")
            lines.append(
                "      or, for one IDE without leaving the shell: "
                "<IDE>.app/Contents/MacOS/<ide> installPlugins com.idebridge.jetbrains"
            )
        if ahead:
            lines.append(
                f"    newer plugin(s): {', '.join(ahead)} — the daemon is the stale half here; "
                "restart it from a current build."
            )
        lines.append(
            "    Say this to the user rather than working around it: a plugin from another release "
            "may be missing capabilities this session expects."
        )
        return lines

    @staticmethod
    def _readiness_note(state: str) -> str:
        """What a readiness state means for the next call.

        The states are not equally actionable, and the two that matter were invisible here: an
        indexing IDE refuses index-dependent routes *retryably*, so waiting works; a degraded one is
        answering nothing at all, and waiting alone may never fix it. Reporting the bare word would
        leave a caller to guess which of those it had.
        """
        return {
            "ready": "",
            "indexing": (
                " — the IDE is building its index. Searches, symbols and refactorings refuse "
                "retryably until it finishes; reading a document still works."
            ),
            "degraded": (
                " — the IDE is not answering. Most often it is waiting on a dialog nobody has "
                "clicked. Bring the IDE to the front and look at it; retrying alone may never help."
            ),
            "initializing": " — the project is still opening. Ask again shortly.",
            "disconnected": " — the adapter is no longer serving this workspace. Re-link it in the "
            "IDE's IDE Bridge tool window.",
        }.get(state, "")


class IdeReadDocumentTool(IdeBridgeTool, ToolMarkerSymbolicRead):
    """A file as the IDE currently holds it, unsaved edits included."""

    def apply(self, relative_path: str, max_answer_chars: int = -1) -> str:
        """
        Read a file through the IDE rather than from disk.

        This returns the buffer the IDE has, which is what its symbols, diagnostics and refactorings
        are computed against — so an unsaved edit is visible here and is not on disk. The response
        carries the document's revision, which is what an edit plan's preconditions are checked
        against.

        :param relative_path: the path of the file, relative to the project root
        :param max_answer_chars: if the file is longer than this, it is not returned.
            -1 uses the configured default.
        :return: a JSON object with the document's text, language and revision.
        """
        try:
            client = self._client()
            result = client.call(
                "document/read",
                {
                    "workspaceId": self._workspace_id(client),
                    "uri": (Path(self.get_project_root()) / relative_path).resolve().as_uri(),
                },
            )
        except IdeBridgeError as error:
            return self._explain(error)

        return self._limit_length(json.dumps(result), max_answer_chars)


class IdeReadSymbolTool(IdeBridgeTool, ToolMarkerSymbolicRead):
    """One declaration's source, cut to the range the IDE gives for it."""

    def apply(self, name: str, relative_path: str = "", max_answer_chars: int = -1) -> str:
        """
        Read a single function, class or method instead of a whole file.

        The IDE reports each declaration's extent, so the text returned is exactly what it considers
        that declaration to be — body, signature and any decorators or annotations the language puts
        inside the range — rather than a guessed line count.

        :param name: the declaration's name. If several match, you are told which so you can be
            more specific rather than being given one of them at random.
        :param relative_path: the file to look in, relative to the project root. Omit to search the
            whole project through the IDE's index.
        :param max_answer_chars: if the answer is longer than this, it is not returned.
            -1 uses the configured default.
        :return: the declaration's source with line numbers, and where it lives.
        """
        try:
            client = self._client()
            workspace_id = self._workspace_id(client)
            candidates = (
                self._in_document(client, workspace_id, relative_path, name)
                if relative_path
                else self._in_workspace(client, workspace_id, name)
            )
        except IdeBridgeError as error:
            return self._explain(error)

        if not candidates:
            where = f" in {relative_path}" if relative_path else ""
            return f"No declaration named '{name}' was found{where}."
        if len(candidates) > 1:
            return self._describe_ambiguity(name, candidates)

        symbol = candidates[0]
        uri = symbol["locator"]["documentUri"]
        try:
            document = client.call("document/read", {"workspaceId": workspace_id, "uri": uri})
        except IdeBridgeError as error:
            return self._explain(error)

        text = document.get("text", "")
        start = symbol["range"]["start"]["line"]
        end = symbol["range"]["end"]["line"]
        lines = text.split("\n")[start : end + 1]
        numbered = "\n".join(f"{start + offset + 1:5}  {line}" for offset, line in enumerate(lines))

        return self._limit_length(
            json.dumps(
                {
                    "name": symbol["locator"].get("name"),
                    "kind": symbol["locator"].get("kind"),
                    "uri": uri,
                    "lines": f"{start + 1}-{end + 1}",
                    "source": numbered,
                }
            ),
            max_answer_chars,
        )

    @staticmethod
    def _describe_ambiguity(name: str, candidates: list[dict[str, Any]]) -> str:
        """Says which declarations matched, and what would actually narrow them.

        Advice that loops is worse than none. Measured against a real IDE on 2026-08-15:
        `declarations` matched three declarations, two of them overloads in one file. The message
        said "name a file with relative_path", and following it exactly returned the identical
        refusal with the identical advice. Nothing in this tool's parameters can separate two
        declarations sharing a name and a file, so it says so and names what does work.
        """
        described = "; ".join(
            f"{c['locator'].get('kind')} in "
            f"{c['locator'].get('documentUri', '').rsplit('/', 1)[-1]}"
            f" line {c['range']['start']['line'] + 1}"
            for c in candidates[:8]
        )
        files = {c["locator"].get("documentUri", "") for c in candidates}
        advice = (
            "Name a file with relative_path, or use a more specific name."
            if len(files) > 1
            else (
                "They are all in one file, so relative_path cannot separate them — read it "
                "around those lines with ide_read_document."
            )
        )
        return f"'{name}' matches {len(candidates)} declarations: {described}. {advice}"

    def _in_document(
        self, client: IdeBridgeClient, workspace_id: str, relative_path: str, name: str
    ) -> list[dict[str, Any]]:
        uri = (Path(self.get_project_root()) / relative_path).resolve().as_uri()
        result = client.call("document/getSymbols", {"workspaceId": workspace_id, "uri": uri})
        return [s for s in _flatten(result.get("symbols", [])) if s["locator"].get("name") == name]

    def _in_workspace(
        self, client: IdeBridgeClient, workspace_id: str, name: str
    ) -> list[dict[str, Any]]:
        found = client.call(
            "workspace/searchSymbols",
            {"workspaceId": workspace_id, "query": name, "limit": 20},
        ).get("symbols", [])
        return [s for s in found if s["locator"].get("name") == name]


def _flatten(symbols: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every declaration in a document tree, so a method is findable without naming its class."""
    found: list[dict[str, Any]] = []
    for symbol in symbols:
        found.append(symbol)
        found.extend(_flatten(symbol.get("children", [])))
    return found


class IdeSymbolsOverviewTool(IdeBridgeTool, ToolMarkerSymbolicRead):
    """Top-level symbols of a file, as the IDE's own engine reports them."""

    def _advice(self, error: RequestFailedError) -> str:
        """The refusal that means "wrong IDE for this file", said as such.

        The adapter answers `CAPABILITY_UNAVAILABLE` when no language plugin in the connected IDE
        claims the file — a `.ts` under a build without JavaScript support is opened by TextMate,
        which displays it without understanding it. The bare code reads as "this bridge cannot do
        symbols", which would be discouraging and wrong.
        """
        if error.code != "CAPABILITY_UNAVAILABLE":
            return ""
        return (
            " No language plugin in the connected IDE claims this file, so it has no declarations "
            "to report and never will — the file is displayed, not understood. Open the project in "
            "an IDE that supports the language (for example PhpStorm or WebStorm for TypeScript, "
            "PyCharm for Python) and ask again. Reading the file still works."
        )

    def apply(self, relative_path: str, max_answer_chars: int = -1) -> str:
        """
        Get the symbols of a file from the IDE that has the project open.

        Unlike the language-server overview, this reflects what the IDE itself shows in its
        structure view, including declarations only the IDE's parser knows about.

        :param relative_path: the path of the file, relative to the project root
        :param max_answer_chars: if the answer is longer than this, it is not returned.
            -1 uses the configured default.
        :return: a JSON object with the file's symbols, and a note about any the IDE declined to
            classify.
        """
        try:
            client = self._client()
            workspace_id = self._workspace_id(client)
            uri = (Path(self.get_project_root()) / relative_path).resolve().as_uri()
            result = client.call(
                "document/getSymbols", {"workspaceId": workspace_id, "uri": uri}
            )
        except IdeBridgeError as error:
            return self._explain(error)

        symbols = result.get("symbols", [])
        unclassified = _count_unclassified(symbols)
        answer: dict[str, Any] = {"symbols": symbols}
        if unclassified:
            # Stated rather than hidden. A caller filtering by kind would otherwise silently lose
            # these, and an empty answer presented as a complete one is the failure this project
            # treats as the worst kind.
            answer["note"] = (
                f"{unclassified} symbol(s) carry kind 'unknown': the language named a category "
                "outside the protocol's vocabulary, or named two at once. They are real "
                "declarations and are listed above; only their classification is missing."
            )
        return self._limit_length(json.dumps(answer), max_answer_chars)


class IdeFindSymbolTool(IdeBridgeTool, ToolMarkerSymbolicRead):
    """Searches the IDE's own symbol index, optionally narrowed by kind."""

    def apply(
        self,
        query: str,
        kinds: list[str] | None = None,
        limit: int = 50,
        max_answer_chars: int = -1,
    ) -> str:
        """
        Find symbols anywhere in the project, using the IDE's own index.

        This is the index behind "Go to Symbol", so it reflects what the IDE has parsed rather than
        a separate scan, and it sees declarations only the IDE's own engine knows about.

        :param kinds: restrict to these kinds, e.g. ["class", "interface"]. Valid kinds are the
            protocol's: class, method, property, field, constructor, enum, interface, function,
            variable, constant, struct, typeParameter, enumMember, namespace, module, package, and
            others. Omit to search every kind.
        :param query: the name, or part of it, to search for
        :param limit: how many results at most
        :param max_answer_chars: if the answer is longer than this, it is not returned.
            -1 uses the configured default.
        :return: a JSON object with the matches, the unclassified matches listed separately, and
            whether the IDE had more to give.
        """
        unknown_words = [kind for kind in (kinds or []) if kind not in SYMBOL_KINDS]
        if unknown_words:
            # Refused by name rather than searched for and silently found empty: a caller who
            # mistypes a kind should learn that, not conclude the project has no such symbols.
            return (
                f"Not symbol kinds in this protocol: {', '.join(unknown_words)}. "
                f"Valid kinds are: {', '.join(SYMBOL_KINDS)}."
            )

        params: dict[str, Any] = {"query": query, "limit": limit}
        if kinds:
            # `unknown` is added to the caller's filter deliberately. The adapter applies the filter,
            # so anything it excludes is gone before this code sees it — and a declaration the IDE
            # declined to classify would then disappear from a search for "class" without a word
            # said. Asking for it too means it can be reported separately and the caller decides.
            params["kinds"] = sorted({*kinds, UNCLASSIFIED})

        try:
            client = self._client()
            params["workspaceId"] = self._workspace_id(client)
            result = client.call("workspace/searchSymbols", params)
        except IdeBridgeError as error:
            return self._explain(error)

        matched: list[dict[str, Any]] = []
        unclassified: list[dict[str, Any]] = []
        for symbol in result.get("symbols", []):
            locator = symbol.get("locator", symbol)
            target = unclassified if locator.get("kind") == UNCLASSIFIED else matched
            target.append(symbol)

        answer: dict[str, Any] = {"symbols": matched, "truncated": result.get("truncated", False)}
        if kinds and unclassified:
            answer["unclassified"] = unclassified
            answer["note"] = (
                f"{len(unclassified)} declaration(s) matched '{query}' but carry kind 'unknown', so "
                "they could not be tested against your filter. The IDE named a category outside the "
                "protocol's vocabulary, or named two at once. They are listed under 'unclassified' "
                "rather than dropped, because a filter that hides what it cannot judge reports an "
                "incomplete answer as a complete one."
            )
        if answer["truncated"]:
            answer["truncation_note"] = (
                f"The IDE had more matches than the limit of {limit}. Narrow the query or raise the "
                "limit; this is not the whole answer."
            )
        return self._limit_length(json.dumps(answer), max_answer_chars)


class IdeDiagnosticsTool(IdeBridgeTool, ToolMarkerSymbolicRead):
    """The IDE's own inspections, with the fixes it offers for them."""

    def _advice(self, error: RequestFailedError) -> str:
        """Turns this route's one confusing refusal into a next step.

        The adapter answers `CAPABILITY_UNAVAILABLE` when the IDE cannot analyse the workspace at
        all — a project opened with no module or SDK, where waiting produces nothing for ever. The
        code alone reads as "this adapter has no diagnostics", which is a different and much more
        discouraging statement, so both readings are given rather than one guessed at.
        """
        if error.code != "CAPABILITY_UNAVAILABLE":
            return ""
        return (
            " Either this IDE provides no diagnostics, or — far more often — the project is open "
            "without a module or SDK, so its analyser cannot run. Open it as a Gradle, Maven or "
            "equivalent project in the IDE and ask again."
        )

    def apply(self, relative_path: str = "", max_answer_chars: int = -1) -> str:
        """
        Get the problems the IDE reports, and the fixes it offers.

        These are the IDE's own inspections — the squiggles you would see in the editor — which go
        well beyond a compiler's errors: unused declarations, suspicious comparisons, framework
        checks, and anything a third-party plugin contributes. Each problem carries the fixes the
        IDE can apply to it, by name.

        :param relative_path: a file to inspect, relative to the project root. Omit for every file
            the IDE currently reports problems in.
        :param max_answer_chars: if the answer is longer than this, it is not returned.
            -1 uses the configured default.
        :return: a JSON object of documents and their problems, each with any offered fixes.
        """
        try:
            client = self._client()
            params: dict[str, Any] = {"workspaceId": self._workspace_id(client)}
            if relative_path:
                params["documentUris"] = [
                    (Path(self.get_project_root()) / relative_path).resolve().as_uri()
                ]
            result = client.call("diagnostics/getSnapshot", params)
        except IdeBridgeError as error:
            return self._explain(error)

        documents = result.get("documents", [])
        reported = sum(len(document.get("diagnostics", [])) for document in documents)
        answer: dict[str, Any] = {
            "documents": documents,
            "capturedAt": result.get("capturedAt"),
        }

        # `truncated` carries two facts and the difference matters enormously to a caller. The
        # adapter sets it when its analysis is still running, where it means "absent problems prove
        # nothing", and also when a document held more than the response could carry.
        #
        # Measured against a real IntelliJ: a file asked for the first time answers `0 diagnostics,
        # truncated=true`, and the same file six seconds later answers `44 diagnostics,
        # truncated=false`. An earlier version of this tool called that first answer "no problems"
        # and explained the flag as overflow — turning an honest signal from the adapter into a
        # false statement at the last step before the caller.
        if result.get("truncated"):
            answer["incomplete_note"] = (
                "This snapshot is incomplete: the IDE said so. "
                + (
                    "Nothing is listed, which most often means analysis has not finished yet rather "
                    "than that the file is clean — ask again in a few seconds. A file the IDE has "
                    "never opened is analysed on demand, and the first answer usually arrives empty."
                    if reported == 0
                    else "Some problems the IDE holds are not in this list; ask for a single file to "
                    "see all of its problems."
                )
            )
        elif reported == 0:
            # The other half of the same distinction, and the only case where silence is a finding.
            answer["clean_note"] = (
                "The IDE finished analysing and reported no problems. This is a complete answer, "
                "not an empty one."
            )

        offered = sum(
            len(diagnostic.get("availableFixes", []))
            for document in documents
            for diagnostic in document.get("diagnostics", [])
        )
        if offered:
            answer["fixes_note"] = (
                f"{offered} fix(es) are offered across these problems, listed as 'availableFixes' "
                "with a fixId and a title. They are the IDE's own quick fixes; nothing here has "
                "applied any of them."
            )
        return self._limit_length(json.dumps(answer), max_answer_chars)


class IdeTodosTool(IdeBridgeTool, ToolMarkerSymbolicRead):
    """TODO markers as the IDE recognises them, not as a text search guesses at them."""

    def apply(self, relative_path: str = "", limit: int = 100, max_answer_chars: int = -1) -> str:
        """
        List the TODO markers the IDE knows about.

        This uses the IDE's own TODO patterns, which the user can configure and which languages
        extend — so it finds markers in the comment syntax of each language and honours custom
        patterns a plain text search would miss, while not matching the word inside a string
        literal.

        :param relative_path: a file to search, relative to the project root. Omit for the whole
            project.
        :param limit: how many markers at most.
        :param max_answer_chars: if the answer is longer than this, it is not returned.
            -1 uses the configured default.
        :return: a JSON object of the markers found, and whether the IDE had more.
        """
        try:
            client = self._client()
            params: dict[str, Any] = {
                "workspaceId": self._workspace_id(client),
                "limit": limit,
            }
            if relative_path:
                params["uri"] = (Path(self.get_project_root()) / relative_path).resolve().as_uri()
            result = client.call("workspace/searchTodos", params)
        except IdeBridgeError as error:
            return self._explain(error)

        answer: dict[str, Any] = {"items": result.get("items", [])}
        if result.get("truncated"):
            answer["truncation_note"] = (
                f"The IDE held more than the limit of {limit}. This is not every marker in the "
                "project."
            )
        return self._limit_length(json.dumps(answer), max_answer_chars)


class IdeHierarchyTool(IdeBridgeTool, ToolMarkerSymbolicRead):
    """Callers, callees, supertypes and subtypes, from the IDE's own hierarchy engines."""

    RELATIONS = ("callers", "callees", "supertypes", "subtypes")

    def apply(self, name: str, relation: str, max_answer_chars: int = -1) -> str:
        """
        Find what calls a symbol, what it calls, or what it inherits from and to.

        :param name: the symbol's name, or part of it. It must match exactly one symbol; if it
            matches several you will be told which, so you can be more specific.
        :param relation: one of "callers", "callees", "supertypes", "subtypes". Named for the
            relation rather than a direction, so it means the same thing whichever IDE answers.
        :param max_answer_chars: if the answer is longer than this, it is not returned.
            -1 uses the configured default.
        :return: a JSON object of the neighbouring symbols in that relation.
        """
        if relation not in self.RELATIONS:
            return f"Not a relation: {relation}. Valid relations are: {', '.join(self.RELATIONS)}."

        try:
            client = self._client()
            workspace_id = self._workspace_id(client)
            found = client.call(
                "workspace/searchSymbols",
                {"workspaceId": workspace_id, "query": name, "limit": 20},
            ).get("symbols", [])
        except IdeBridgeError as error:
            return self._explain(error)

        exact = [s for s in found if s.get("locator", {}).get("name") == name] or found
        if not exact:
            return f"No symbol named '{name}' was found in the IDE's index."
        if len(exact) > 1:
            # Named rather than guessed at. Picking the first would answer a question about a
            # symbol the caller did not ask about, and the answer would look right.
            candidates = [
                f"{s['locator'].get('name')} ({s['locator'].get('kind')}) in "
                f"{s['locator'].get('documentUri', '').rsplit('/', 1)[-1]}"
                for s in exact
            ]
            return (
                f"'{name}' matches {len(exact)} symbols, so the {relation} of which one is "
                f"ambiguous: {'; '.join(candidates)}. Ask again with a more specific name."
            )

        target = exact[0]
        try:
            result = client.call(
                "symbol/getHierarchy",
                {
                    "workspaceId": workspace_id,
                    # Both are carried: the handle is the fast path, the locator survives it going
                    # stale. The protocol accepts either.
                    "symbol": {"handle": target["handle"], "locator": target["locator"]},
                    "relation": relation,
                },
            )
        except IdeBridgeError as error:
            return self._explain(error)

        return self._limit_length(json.dumps(result), max_answer_chars)


class IdeApplyFixTool(IdeBridgeTool, ToolMarkerCanEdit):
    """Applies one of the IDE's quick fixes — or, by default, only says what it would do.

    This began as three tools, `prepare`, `apply` and `undo`, mirroring the protocol's two-phase
    edit flow. Running them against a real IDE showed why that cannot work here: an edit plan
    carries the id of the session that created it, and so does the undo token. Preparing on one
    connection and applying on another is refused `PLAN_NOT_FOUND`, and this client opens a
    connection per call. Measured both ways — the identical sequence inside a single connection
    applies and undoes cleanly.

    So the whole flow lives in one call, on one session. `confirm` is what separates looking from
    doing, rather than a plan id a caller could carry between tools and find expired or unknown.
    """

    def _advice(self, error: RequestFailedError) -> str:
        """The three refusals that mean "your plan no longer describes the file".

        They arrive here and nowhere else, and they are not interchangeable: one says the document
        moved under a plan that is otherwise fine, one says the file changed between preparing and
        applying, and one says the identifier means nothing. An agent told only the code retries the
        same call, or gives up on a fix that would work perfectly a moment later.

        `STALE_DOCUMENT` is the useful one: the daemon builds it with the revision the document has
        *now*, so the answer is "re-read that revision and prepare again" rather than "something
        went wrong".
        """
        if error.code == "STALE_DOCUMENT":
            revision = error.details.get("currentRevision")
            named = ""
            if isinstance(revision, dict) and revision.get("contentHash"):
                # The daemon computes this precisely so a caller does not have to guess what to
                # re-read. Repeating it here is the whole point of carrying `details` at all.
                named = f" The document is now at {revision['contentHash']}."
            # No restatement: the daemon's own message already says the document changed, and
            # repeating it made the answer read as two voices saying one thing. This adds only what
            # the daemon cannot know — that the edit was very likely this session's own — and what
            # to do next.
            return (
                " Often this is an edit made earlier in this same session. Nothing was written."
                f"{named} Read the file again and ask for the fix again; the offer is usually still "
                "there."
            )
        if error.code == "PRECONDITION_FAILED":
            return (
                " The file changed between preparing the fix and applying it, so the IDE refused "
                "rather than write edits computed for text that has moved. Nothing was written. "
                "Read the file again and ask for the fix again."
            )
        if error.code == "PLAN_NOT_FOUND":
            return (
                " The plan is gone rather than stale — expired, already applied, or never known. "
                "Nothing was written. Ask for the fix again; do not reuse an identifier from an "
                "earlier call, since a plan belongs to the session that prepared it."
            )
        return ""

    def apply(
        self,
        relative_path: str,
        fix_id: str,
        confirm: bool = False,
        max_answer_chars: int = -1,
    ) -> str:
        """
        Apply one of the IDE's quick fixes. **With confirm=True this modifies files on disk.**

        Call `ide_diagnostics` first to get a `fixId`. Leave `confirm` false to see exactly which
        files would change and how many edits each would take, without writing anything; pass true
        to have the IDE carry it out with its own refactoring engine.

        :param relative_path: the file the problem is in, relative to the project root
        :param fix_id: the `fixId` of the fix, from `ide_diagnostics`
        :param confirm: false reports the plan and discards it; true applies it
        :param max_answer_chars: if the answer is longer than this, it is not returned.
            -1 uses the configured default.
        :return: a JSON object describing what would change, or what did.
        """
        try:
            client = self._client()
            with client.session() as call:
                workspace_id = self._resolve_workspace(call)
                plan = call(
                    "refactor/prepare",
                    {
                        "workspaceId": workspace_id,
                        "operation": "quickFix",
                        "uri": (Path(self.get_project_root()) / relative_path).resolve().as_uri(),
                        "arguments": {"fixId": fix_id},
                    },
                ).get("plan", {})

                preview: dict[str, Any] = {
                    "operation": plan.get("operation"),
                    "guarantee": plan.get("guarantee"),
                    "atomicity": plan.get("atomicity"),
                    "changes": plan.get("changes", []),
                    "warnings": plan.get("warnings", []),
                    "preconditions": plan.get("preconditions", []),
                }

                if not confirm:
                    # The plan dies with this connection, which is why no id is handed back: an
                    # identifier a caller cannot use is worse than none at all.
                    preview["applied"] = False
                    preview["note"] = (
                        "Nothing was written. Call again with confirm=true to have the IDE apply "
                        "this."
                    )
                    return self._limit_length(json.dumps(preview), max_answer_chars)

                applied = call(
                    "workspace/applyPlan",
                    {
                        "workspaceId": workspace_id,
                        "planId": plan["planId"],
                        "includePostApplyDiagnostics": True,
                    },
                )
        except IdeBridgeError as error:
            return self._explain(error)

        modified = applied.get("modifiedDocuments", [])
        answer: dict[str, Any] = {
            "applied": True,
            "modifiedDocuments": modified,
            "planned": preview,
            "summary": f"{len(modified)} document(s) changed by the IDE.",
            # Said plainly because it is the one thing a caller cannot work out: the undo token the
            # daemon issued is bound to the session this call just closed, so nothing can replay it
            # later. The change is in the IDE's own undo stack, and in version control.
            "undo_note": (
                "This cannot be undone through the bridge: an undo token belongs to the session "
                "that made the edit, and that session ended with this call. Undo in the IDE, or "
                "revert with version control."
            ),
        }
        if applied.get("diagnostics"):
            answer["diagnostics_after"] = applied["diagnostics"]
            answer["diagnostics_note"] = (
                "Problems the IDE reports after the change. A fix that introduces a new one is "
                "worth seeing before moving on."
            )
        return self._limit_length(json.dumps(answer), max_answer_chars)


class IdeRefactorTool(IdeBridgeTool, ToolMarkerCanEdit):
    """A refactoring the IDE performs itself — or, by default, only says what it would do.

    The IDE's rename is not a search and replace: it follows the references its own engine resolved,
    across files, and refuses when it cannot. That is the operation this integration exists to
    expose, and until now it did not — `ide_apply_fix` hard-codes `quickFix`, so `rename`,
    `reformat` and `optimizeImports` were served by both adapters, exercised in the demo, and
    reachable by nobody.

    Prepare and apply live in one call for the same reason they do in `ide_apply_fix`: a plan
    carries the id of the session that made it, this client opens a connection per call, and a plan
    prepared on one connection is refused `PLAN_NOT_FOUND` on the next. `confirm` is what separates
    looking from doing.

    The structural refactorings — `extractMethod`, `inline`, `move`, `changeSignature` — are not
    offered, because the adapters refuse them by name: the platform's only language-neutral route to
    them is a dialog-driven handler that cannot run behind a socket (ADR-0028). Listing them here
    would invite an agent to spend a turn discovering that.
    """

    #: What the adapters actually perform. `quickFix` is deliberately absent: it needs a fix id from
    #: `ide_diagnostics`, and it has its own tool.
    OPERATIONS = ("rename", "reformat", "optimizeImports")

    #: Refused by name by both adapters. Named so the answer can say why rather than pass it on.
    STRUCTURAL = ("extractMethod", "inline", "move", "changeSignature")

    def _advice(self, error: RequestFailedError) -> str:
        """The refusals that mean "this plan no longer describes the code"."""
        if error.code == "STALE_DOCUMENT":
            revision = error.details.get("currentRevision")
            named = ""
            if isinstance(revision, dict) and revision.get("contentHash"):
                named = f" The document is now at {revision['contentHash']}."
            return (
                " Often this is an edit made earlier in this same session. Nothing was written."
                f"{named} Read the file again and ask for the refactoring again."
            )
        if error.code == "PRECONDITION_FAILED":
            return (
                " The code changed between preparing the refactoring and applying it, so the IDE "
                "refused rather than write edits computed for text that has moved. Nothing was "
                "written."
            )
        if error.code == "PLAN_NOT_FOUND":
            return (
                " The plan is gone rather than stale — expired, already applied, or never known. "
                "Nothing was written. Ask again; a plan belongs to the session that prepared it."
            )
        if error.code == "CAPABILITY_UNAVAILABLE":
            return (
                " This IDE does not offer that refactoring on this element. The refusal is the "
                "answer: do not fall back to editing the text by hand and call it the same thing."
            )
        return ""

    def apply(
        self,
        operation: str,
        name: str = "",
        new_name: str = "",
        relative_path: str = "",
        confirm: bool = False,
        include_comments: bool = False,
        include_strings: bool = False,
        max_answer_chars: int = -1,
    ) -> str:
        """
        Have the IDE perform a refactoring. **With confirm=True this modifies files on disk.**

        Leave `confirm` false to see every file that would change and how many edits each would
        take, without writing anything.

        :param operation: "rename" (needs `name` and `new_name`), or "reformat" /
            "optimizeImports" (need `relative_path`).
        :param name: for a rename, the symbol's current name. It must match exactly one symbol; if
            it matches several you will be told which, so you can be more specific.
        :param new_name: for a rename, the name to give it.
        :param relative_path: for a document-scoped operation, the file, relative to the project
            root.
        :param confirm: false reports the plan and discards it; true applies it.
        :param include_comments: rename occurrences in comments too. Off by default: a rename that
            edits prose is harder to review than one that does not.
        :param include_strings: rename occurrences in string literals too. Off by default, and for
            a stronger reason — a string may be a protocol constant, a database column, or a key
            some other system reads.
        :param max_answer_chars: if the answer is longer than this, it is not returned.
            -1 uses the configured default.
        :return: a JSON object describing what would change, or what did.
        """
        if operation in self.STRUCTURAL:
            return (
                f"'{operation}' is refused by both adapters, not missing: the platform's only "
                "language-neutral route to it is a dialog-driven handler, which cannot run behind "
                f"a socket (ADR-0028). Available here: {', '.join(self.OPERATIONS)}."
            )
        if operation not in self.OPERATIONS:
            return (
                f"Not an operation: {operation}. Available: {', '.join(self.OPERATIONS)}. "
                "For a quick fix, use ide_apply_fix, which takes a fixId from ide_diagnostics."
            )
        if operation == "rename" and not (name and new_name):
            return "A rename needs both 'name' (the symbol now) and 'new_name' (what to call it)."
        if operation != "rename" and not relative_path:
            return f"'{operation}' applies to a document: pass relative_path."

        try:
            client = self._client()
            # One session, start to finish: the plan below carries this session's id, and applying
            # it on another connection is refused PLAN_NOT_FOUND.
            with client.session() as call:
                workspace_id = self._resolve_workspace(call)

                if operation == "rename":
                    target = self._one_symbol(call, workspace_id, name)
                    if isinstance(target, str):
                        return target
                    plan = call(
                        "refactor/prepareRename",
                        {
                            "workspaceId": workspace_id,
                            "symbol": {
                                "handle": target["handle"],
                                "locator": target["locator"],
                            },
                            "newName": new_name,
                            "options": {
                                "includeComments": include_comments,
                                "includeStrings": include_strings,
                            },
                        },
                    ).get("plan", {})
                else:
                    plan = call(
                        "refactor/prepare",
                        {
                            "workspaceId": workspace_id,
                            "operation": operation,
                            "uri": (Path(self.get_project_root()) / relative_path)
                            .resolve()
                            .as_uri(),
                        },
                    ).get("plan", {})

                preview: dict[str, Any] = {
                    "operation": plan.get("operation"),
                    "guarantee": plan.get("guarantee"),
                    "atomicity": plan.get("atomicity"),
                    "changes": plan.get("changes", []),
                    "warnings": plan.get("warnings", []),
                    "preconditions": plan.get("preconditions", []),
                }

                if not confirm:
                    preview["applied"] = False
                    preview["note"] = (
                        "Nothing was written. Call again with confirm=true to have the IDE apply "
                        "this."
                    )
                    return self._limit_length(json.dumps(preview), max_answer_chars)

                applied = call(
                    "workspace/applyPlan",
                    {
                        "workspaceId": workspace_id,
                        "planId": plan["planId"],
                        "includePostApplyDiagnostics": True,
                    },
                )
        except IdeBridgeError as error:
            return self._explain(error)

        modified = applied.get("modifiedDocuments", [])
        answer: dict[str, Any] = {
            "applied": True,
            "modifiedDocuments": modified,
            "planned": preview,
            "summary": f"{len(modified)} document(s) changed by the IDE.",
            "undo_note": (
                "This cannot be undone through the bridge: an undo token belongs to the session "
                "that made the edit, and that session ended with this call. Undo in the IDE, or "
                "revert with version control."
            ),
        }
        if applied.get("diagnostics"):
            answer["diagnostics_after"] = applied["diagnostics"]
            answer["diagnostics_note"] = (
                "Problems the IDE reports after the change. A rename that introduces one is worth "
                "seeing before moving on."
            )
        return self._limit_length(json.dumps(answer), max_answer_chars)

    def _one_symbol(self, call: Any, workspace_id: str, name: str) -> Any:
        """The single symbol that name refers to, or a sentence saying why there isn't one.

        Renaming the first of several matches would rename something the caller did not ask about,
        and the answer would look exactly like success.
        """
        found = call(
            "workspace/searchSymbols",
            {"workspaceId": workspace_id, "query": name, "limit": 20},
        ).get("symbols", [])
        exact = [s for s in found if s.get("locator", {}).get("name") == name] or found
        if not exact:
            return f"No symbol named '{name}' was found in the IDE's index."
        if len(exact) > 1:
            candidates = [
                f"{s['locator'].get('name')} ({s['locator'].get('kind')}) in "
                f"{s['locator'].get('documentUri', '').rsplit('/', 1)[-1]}"
                for s in exact
            ]
            return (
                f"'{name}' matches {len(exact)} symbols, so which one to rename is ambiguous: "
                f"{'; '.join(candidates)}. Ask again with a more specific name."
            )
        return exact[0]




def _release_order(left: str, right: str) -> int:
    """Orders two release numbers, with no opinion about anything it cannot parse.

    A version carrying a suffix — `0.1.0-SNAPSHOT`, which this plugin built as for months — reads as
    "no comparison" rather than as "older". Telling someone to reinstall because of a suffix would be
    a worse answer than saying nothing.
    """
    import re

    def parts(value: str) -> tuple[int, int, int] | None:
        found = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", value.strip())
        return (int(found[1]), int(found[2]), int(found[3])) if found else None

    a, b = parts(left), parts(right)
    if a is None or b is None:
        return 0
    return (a > b) - (a < b)

def _count_unclassified(symbols: list[dict[str, Any]]) -> int:
    total = 0
    for symbol in symbols:
        locator = symbol.get("locator", symbol)
        if locator.get("kind") == "unknown":
            total += 1
        total += _count_unclassified(symbol.get("children", []))
    return total
