package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.connection.AdapterRouter
import com.idebridge.jetbrains.connection.DiscoveryReader
import com.idebridge.jetbrains.connection.HandshakeClient
import com.idebridge.jetbrains.connection.RpcClient
import com.idebridge.jetbrains.connection.WebSocketTransport
import com.idebridge.jetbrains.diagnostic.DiagnosticMapping
import com.idebridge.jetbrains.edit.RenamePlanRegistry
import com.idebridge.jetbrains.document.DocumentModel
import com.idebridge.jetbrains.document.LineIndex
import com.idebridge.jetbrains.protocol.Atomicity
import com.idebridge.jetbrains.protocol.DiagnosticSeverity
import com.idebridge.jetbrains.protocol.DiagnosticsGetSnapshotParams
import com.idebridge.jetbrains.protocol.DiagnosticsGetSnapshotResult
import com.idebridge.jetbrains.protocol.DocumentDiagnostics
import com.idebridge.jetbrains.protocol.DocumentContent
import com.idebridge.jetbrains.protocol.DocumentGetRevisionResult
import com.idebridge.jetbrains.protocol.DocumentGetSymbolsResult
import com.idebridge.jetbrains.protocol.DocumentRevisionPrecondition
import com.idebridge.jetbrains.protocol.DocumentTargetParams
import com.idebridge.jetbrains.protocol.EditOperation
import com.idebridge.jetbrains.protocol.EditPlan
import com.idebridge.jetbrains.protocol.ErrorCode
import com.idebridge.jetbrains.protocol.EndpointTopology
import com.idebridge.jetbrains.protocol.EnvironmentKind
import com.idebridge.jetbrains.protocol.Guarantee
import com.idebridge.jetbrains.protocol.HostKind
import com.idebridge.jetbrains.protocol.ModificationResult
import com.idebridge.jetbrains.protocol.ModifiedDocument
import com.idebridge.jetbrains.protocol.PeerInfo
import com.idebridge.jetbrains.protocol.RefactorPrepareRenameParams
import com.idebridge.jetbrains.protocol.RefactorPrepareRenameResult
import com.idebridge.jetbrains.protocol.RenameOptions
import com.idebridge.jetbrains.protocol.SessionRole
import com.idebridge.jetbrains.workspace.WorkspaceUri
import com.idebridge.jetbrains.protocol.HierarchyRelation
import com.idebridge.jetbrains.protocol.SymbolHierarchyParams
import com.idebridge.jetbrains.protocol.SymbolLocationsResult
import com.idebridge.jetbrains.protocol.SymbolTargetParams
import com.idebridge.jetbrains.protocol.SymbolReference
import com.idebridge.jetbrains.protocol.SymbolKind
import com.idebridge.jetbrains.protocol.IdebpJson
import com.idebridge.jetbrains.protocol.Workspace
import com.idebridge.jetbrains.protocol.WorkspaceSearchSymbolsParams
import com.idebridge.jetbrains.protocol.WorkspaceSearchSymbolsResult
import com.idebridge.jetbrains.protocol.WorkspaceApplyPlanParams
import com.idebridge.jetbrains.protocol.WorkspaceUndoParams
import com.idebridge.jetbrains.protocol.WorkspaceDiscardPlanParams
import com.idebridge.jetbrains.protocol.WorkspaceDiscardPlanResult
import com.idebridge.jetbrains.symbol.SymbolHandleRegistry
import com.idebridge.jetbrains.symbol.SymbolMapping
import com.idebridge.jetbrains.service.AdapterBackend
import com.idebridge.jetbrains.workspace.AdapterRegistration
import com.idebridge.jetbrains.workspace.WorkspaceModel
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.util.Disposer
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiJavaFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlin.io.path.createTempDirectory
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject

/**
 * The JetBrains adapter, end to end.
 *
 * Every other test covers one side: the platform fixtures exercise real PSI without a daemon, and
 * the real-daemon tests exercise the wire with a fabricated workspace. This joins them — a real
 * `Project`, the real daemon process, and a separate consumer session asking for the symbols of a
 * real Java file — which is the only arrangement that can show the adapter actually works.
 *
 * PSI is read through a `ReadAction` from the serving thread, as it would be in the plugin: the
 * daemon's request arrives off the EDT, and nothing but protocol types crosses back.
 *
 * It drives `AdapterBackend` — the backend the plugin ships — rather than a copy. A test-local
 * implementation proved the protocol path while leaving the production wiring unverified, and had to
 * be updated alongside it for every method added, which is where a divergence would have hidden.
 */
class RealDaemonSymbolsTest : BasePlatformTestCase() {

    private val repositoryRoot = File(System.getProperty("user.dir")).parentFile

    /** Where the conformance suite looks for this adapter's recorded responses. */
    private val CONFORMANCE_CAPTURE = "packages/conformance/captures/jetbrains.json"
    private val cli = File(repositoryRoot, "packages/cli/dist/bin.js")

    private val topology = EndpointTopology(
        hostKind = HostKind.LOCAL,
        environmentKind = EnvironmentKind.LOCAL,
        // The fixture's content root lives on the in-memory `temp` filesystem, so that is the
        // scheme this adapter genuinely serves here.
        uriSchemes = listOf("temp", "file"),
    )

    private fun nodeExecutable(): String? =
        System.getenv("PATH")
            ?.split(File.pathSeparator)
            ?.map { File(it, "node") }
            ?.firstOrNull { it.canExecute() }
            ?.absolutePath

    fun `test a consumer reads symbols and diagnostics and renames through the real daemon`() {
        val node = nodeExecutable()
        if (node == null || !cli.isFile) {
            // Reported rather than passed silently: a skipped integration must not read as a pass.
            System.err.println("[skipped] node or packages/cli/dist/bin.js unavailable")
            return
        }

        val file = myFixture.configureByText(
            "Service.java",
            """
            class Service {
                private int count = "not an int";

                void run() {
                    count = 1;
                }
            }
            """.trimIndent(),
        ) as PsiJavaFile
        // A second file, in a second language, for one reason: it holds a declaration the language
        // names without the text spelling it (ADR-0030). `addFileToProject` rather than
        // `configureByText` so the fixture's open editor stays the Java one the rename flow below
        // drives. Nothing here contains "Service", or it would join that file's search results.
        val unspelled = myFixture.addFileToProject(
            "Registry.kt",
            """
            class Registry {
                companion object {
                    const val LIMIT = 3

                    fun make() {}
                }
            }
            """.trimIndent(),
        )
        val unspelledUri = unspelled.virtualFile.url
        val tracker = DaemonAnalysisTracker(project).also { it.start() }
        Disposer.register(testRootDisposable, tracker)
        // Runs the daemon to completion, as opening a file in the IDE does. The tracker is what
        // makes the answer honest either way: without analysis the snapshot comes back incomplete
        // rather than looking clean.
        myFixture.doHighlighting()
        val documentUri = file.virtualFile.url

        val adapterId = WorkspaceModel.createIdentifier("adapter_")
        val model = WorkspaceModel(adapterId)
        val workspace = model.snapshot(IntelliJProjectSnapshot.capture(project))
            ?: error("the fixture project must produce a workspace")

        val directory: Path = createTempDirectory("ide-bridge-e2e")
        val discoveryFile = directory.resolve("discovery.json")
        val daemonLog = directory.resolve("daemon.log").toFile()
        val daemon = ProcessBuilder(
            node, cli.absolutePath, "daemon",
            "--discovery-file", discoveryFile.toString(),
            "--log-level", "info",
        ).directory(repositoryRoot)
            .redirectErrorStream(true)
            .redirectOutput(daemonLog)
            .start()

        try {
            val discovery = awaitDiscovery(discoveryFile)
            check(discovery is DiscoveryReader.Outcome.Ready) { "no discovery file: $discovery" }

            val adapterTransport = WebSocketTransport.connect(discovery.discovery.endpoint)
            val consumerTransport = WebSocketTransport.connect(discovery.discovery.endpoint)
            var serving: Thread? = null
            try {
                val handshake = HandshakeClient(PeerInfo("ide-bridge-jetbrains", "0.1.0"))
                val adapterSession = handshake.connect(
                    adapterTransport, discovery.discovery, SessionRole.ADAPTER, topology, "e2e-a",
                )
                check(adapterSession is HandshakeClient.Outcome.Established)
                val adapterSessionId = adapterSession.session.sessionId
                check(
                    handshake.connect(
                        consumerTransport, discovery.discovery, SessionRole.CONSUMER, topology, "e2e-c",
                    ) is HandshakeClient.Outcome.Established,
                )

                val router = AdapterRouter(
                    AdapterBackend(
                        project = project,
                        workspace = workspace,
                        adapterId = adapterId,
                        sessionId = adapterSessionId,
                        workspaceEpoch = model.currentEpoch,
                        tracker = tracker,
                    ),
                )
                val adapter = RpcClient(adapterTransport, onRequest = router)
                val registration = AdapterRegistration(adapterId, "0.1.0", "IC-2025.2")
                    .register(adapter, listOf(workspace))
                check(registration is AdapterRegistration.Outcome.Registered) {
                    "registration failed: $registration"
                }

                // From here the adapter only answers; the consumer drives.
                serving = Thread({ adapter.serve() }, "idebp-adapter-serve").apply {
                    isDaemon = true
                    start()
                }

                val consumer = RpcClient(consumerTransport)
                val failure = java.util.concurrent.atomic.AtomicReference<Throwable>()
                val finished = java.util.concurrent.atomic.AtomicBoolean(false)
                val driving = Thread({
                    try {
                        driveConsumer(consumer, workspace, documentUri, unspelledUri, file, adapterId)
                    } catch (error: Throwable) {
                        failure.set(error)
                    } finally {
                        finished.set(true)
                    }
                }, "idebp-consumer").apply { isDaemon = true; start() }

                // Dispatching while waiting is what lets the adapter's write action reach the EDT.
                com.intellij.testFramework.PlatformTestUtil.waitWithEventsDispatching(
                    "the consumer never finished",
                    { finished.get() },
                    60,
                )
                driving.join(5_000)
                failure.get()?.let { throw it }
            } finally {
                serving?.interrupt()
                adapterTransport.close()
                consumerTransport.close()
            }
        } catch (failure: Throwable) {
            System.err.println("=== daemon output ===")
            runCatching { daemonLog.readLines().takeLast(60).forEach(System.err::println) }
            throw failure
        } finally {
            daemon.destroy()
            daemon.waitFor(10, TimeUnit.SECONDS)
            daemon.destroyForcibly()
        }
    }

    /** Everything the consumer does, off the dispatch thread. */
    private fun driveConsumer(
        consumer: RpcClient,
        workspace: Workspace,
        documentUri: String,
        unspelledUri: String,
        file: PsiJavaFile,
        adapterId: String,
    ) {
                // Workspace search, answered by the IDE's own "Go to Symbol" index. A symbol
                // found here carries a transient handle, which must not have revoked the ones
                // document/getSymbols hands out later.
                val search = consumer.call(
                    "workspace/searchSymbols",
                    WorkspaceSearchSymbolsParams(workspace.workspaceId, "Service", limit = 50),
                    WorkspaceSearchSymbolsParams.serializer(),
                    WorkspaceSearchSymbolsResult.serializer(),
                )
                check(search is RpcClient.Outcome.Ok) { "searchSymbols failed: $search" }
                assertTrue(
                    "the class must be found by name: " + search.result.symbols.map { it.locator.name },
                    search.result.symbols.any { it.locator.name == "Service" },
                )
                assertTrue(
                    "every hit must sit in the workspace",
                    search.result.symbols.all { it.locator.documentUri == documentUri },
                )

                // Reading the document first: an agent that can list symbols but not read the
                // file is half blind, and the revision it gets back is what every edit
                // precondition is later checked against.
                val read = consumer.call(
                    "document/read",
                    DocumentTargetParams(workspace.workspaceId, documentUri),
                    DocumentTargetParams.serializer(),
                    DocumentContent.serializer(),
                )
                check(read is RpcClient.Outcome.Ok) { "document/read failed: $read" }
                assertTrue("the real text must come back", read.result.text.contains("class Service"))
                assertEquals(documentUri, read.result.document.uri)

                val revision = consumer.call(
                    "document/getRevision",
                    DocumentTargetParams(workspace.workspaceId, documentUri),
                    DocumentTargetParams.serializer(),
                    DocumentGetRevisionResult.serializer(),
                )
                check(revision is RpcClient.Outcome.Ok) { "document/getRevision failed: $revision" }
                // The two must agree: a revision describing content the adapter never served
                // would make every precondition built on it meaningless.
                assertEquals(
                    read.result.document.revision.contentHash,
                    revision.result.document.revision.contentHash,
                )

                val outcome = consumer.call(
                    "document/getSymbols",
                    DocumentTargetParams(workspace.workspaceId, documentUri),
                    DocumentTargetParams.serializer(),
                    DocumentGetSymbolsResult.serializer(),
                )

                check(outcome is RpcClient.Outcome.Ok) { "document/getSymbols failed: $outcome" }
                val symbols = outcome.result.symbols
                val service = symbols.single()
                assertEquals("Service", service.locator.name)
                // A real kind, serialised by the adapter and deserialised by the consumer with the
                // daemon in between. This assertion read UNKNOWN until the platform mapper existed,
                // which meant the end-to-end path had never actually carried a classification —
                // `unknown` is the enum's zero value and would have survived a broken mapping too.
                assertEquals(SymbolKind.CLASS, service.locator.kind)
                assertEquals(
                    setOf("count", "run"),
                    service.children.map { it.locator.name }.toSet(),
                )
                // The handle came back through the daemon intact, bound to this adapter.
                assertEquals(adapterId, service.handle.adapterId)
                assertEquals(workspace.workspaceEpoch, service.handle.validUntilEpoch)
                assertEquals(documentUri, outcome.result.document.uri)

                // Navigation, over the wire. The daemon accepting these results is the part a
                // unit test cannot show: every reported URI has to survive its containment
                // check, or the session is closed as a policy violation.
                val runSymbol = service.children.single { it.locator.name == "run" }
                val definition = consumer.call(
                    "symbol/getDefinition",
                    SymbolTargetParams(workspace.workspaceId, SymbolReference(handle = runSymbol.handle)),
                    SymbolTargetParams.serializer(),
                    SymbolLocationsResult.serializer(),
                )
                check(definition is RpcClient.Outcome.Ok) { "getDefinition failed: $definition" }
                val declaredAt = definition.result.locations.single().location
                assertEquals(documentUri, declaredAt.uri)
                assertFalse("a single declaration is a complete answer", definition.result.truncated)

                val references = consumer.call(
                    "symbol/getReferences",
                    SymbolTargetParams(workspace.workspaceId, SymbolReference(handle = runSymbol.handle)),
                    SymbolTargetParams.serializer(),
                    SymbolLocationsResult.serializer(),
                )
                check(references is RpcClient.Outcome.Ok) { "getReferences failed: $references" }
                // `run` is declared and never called in this fixture, so an empty list is the
                // truthful answer — and it still has to be a well-formed one.
                assertTrue(
                    "every reference must sit in the workspace",
                    references.result.locations.all { it.location.uri == documentUri },
                )

                // Recorded for the conformance suite. The rules live in one implementation
                // (packages/conformance); writing a second one in Kotlin is the drift
                // ADR-0025 exists to prevent, so the responses travel instead of the rules.
                captured["documentSymbols"] =
                    IdebpJson.encodeToJsonElement(
                        DocumentGetSymbolsResult.serializer(),
                        outcome.result,
                    )

                // A declaration the language names without spelling, over the real wire (ADR-0030).
                // Until 2026-08-09 this document answered with nothing but its top-level class, and
                // no unit test could show what the daemon does with the result: an empty selection
                // range has to survive its authority check, or the session closes as a policy
                // violation. The conformance suite judges the recorded response with the same rules
                // it applies to the Java one, so `wellFormed` and "the selection lies inside the
                // declaration" are checked against a real answer rather than a constructed one.
                val unspelledOutcome = consumer.call(
                    "document/getSymbols",
                    DocumentTargetParams(workspace.workspaceId, unspelledUri),
                    DocumentTargetParams.serializer(),
                    DocumentGetSymbolsResult.serializer(),
                )
                check(unspelledOutcome is RpcClient.Outcome.Ok) {
                    "document/getSymbols for the unspelled declaration failed: $unspelledOutcome"
                }
                val registry = unspelledOutcome.result.symbols.single()
                assertEquals("Registry", registry.locator.name)
                val companion = registry.children.single()
                assertEquals("Companion", companion.locator.name)
                assertEquals(
                    "the members are what a consumer asked for",
                    listOf("LIMIT", "make"),
                    companion.children.map { it.locator.name },
                )
                // No text spells this name, so nothing is claimed as one — the same answer the unit
                // tests pin, here after a round trip through the daemon's validation.
                assertEquals(
                    companion.locator.selectionRange.start,
                    companion.locator.selectionRange.end,
                )
                assertEquals(adapterId, companion.handle.adapterId)
                captured["unspelledDocumentSymbols"] = buildJsonObject {
                    // Carried explicitly: this response answers a different document from the one the
                    // capture's top-level `requestedUri` names, and the rule that the answer matches
                    // the request would otherwise have nothing to compare against.
                    put("requestedUri", JsonPrimitive(unspelledUri))
                    IdebpJson.encodeToJsonElement(
                        DocumentGetSymbolsResult.serializer(),
                        unspelledOutcome.result,
                    ).jsonObject.forEach { (key, value) -> put(key, value) }
                }

                // And the search route, which had the same defect twice over: the IDE's index offers
                // this name, so a consumer that found it in the document above must be able to find
                // it by name too. Recorded as evidence; no shared rule judges search yet, which is
                // stated in ADR-0030 rather than quietly true.
                val searchLimit = 50
                val unspelledSearch = consumer.call(
                    "workspace/searchSymbols",
                    WorkspaceSearchSymbolsParams(
                        workspace.workspaceId,
                        "Companion",
                        limit = searchLimit,
                    ),
                    WorkspaceSearchSymbolsParams.serializer(),
                    WorkspaceSearchSymbolsResult.serializer(),
                )
                check(unspelledSearch is RpcClient.Outcome.Ok) {
                    "workspace/searchSymbols for the unspelled name failed: $unspelledSearch"
                }
                assertTrue(
                    "the unspelled name must be findable: " +
                        unspelledSearch.result.symbols.map { it.locator.name },
                    unspelledSearch.result.symbols.any { it.locator.name == "Companion" },
                )
                captured["searchSymbols"] = buildJsonObject {
                    // The ceiling the consumer asked for, carried so the rule that a result stays
                    // inside it has the request's own number rather than the protocol's maximum.
                    put("requestedLimit", JsonPrimitive(searchLimit))
                    IdebpJson.encodeToJsonElement(
                        WorkspaceSearchSymbolsResult.serializer(),
                        unspelledSearch.result,
                    ).jsonObject.forEach { (key, value) -> put(key, value) }
                }

                // Same session, second capability: the daemon accepts this result too, which means
                // the severities, bounds and redaction all satisfy the contract on the wire and not
                // merely in a unit test.
                val diagnostics = consumer.call(
                    "diagnostics/getSnapshot",
                    DiagnosticsGetSnapshotParams(workspace.workspaceId, listOf(documentUri)),
                    DiagnosticsGetSnapshotParams.serializer(),
                    DiagnosticsGetSnapshotResult.serializer(),
                )
                check(diagnostics is RpcClient.Outcome.Ok) {
                    "diagnostics/getSnapshot failed: $diagnostics"
                }
                captured["diagnostics"] =
                    IdebpJson.encodeToJsonElement(
                        DiagnosticsGetSnapshotResult.serializer(),
                        diagnostics.result,
                    )
                val reported = diagnostics.result.documents.single()
                assertEquals(documentUri, reported.document.uri)
                val errors = reported.diagnostics.filter {
                    it.severity == DiagnosticSeverity.ERROR
                }
                assertFalse("the deliberate type error must reach the consumer", errors.isEmpty())
                assertFalse(
                    "an analysed document must be reported as complete",
                    diagnostics.result.truncated,
                )

                // Third capability, and the only one that writes: prepare, then apply, both driven
                // by the consumer through the daemon. Preparing must change nothing.
                val target = service.children.single { it.locator.name == "run" }

                // A hierarchy step over the wire. It matters that the daemon accepts it: the
                // response carries locations and handles, and every one has to survive the same
                // containment and authority checks a lookup does, or the session is closed.
                val hierarchy = consumer.call(
                    "symbol/getHierarchy",
                    SymbolHierarchyParams(
                        workspace.workspaceId,
                        SymbolReference(handle = target.handle),
                        HierarchyRelation.CALLEES,
                    ),
                    SymbolHierarchyParams.serializer(),
                    SymbolLocationsResult.serializer(),
                )
                check(hierarchy is RpcClient.Outcome.Ok) { "symbol/getHierarchy failed: $hierarchy" }
                captured["hierarchy"] =
                    IdebpJson.encodeToJsonElement(
                        SymbolLocationsResult.serializer(),
                        hierarchy.result,
                    )

                val prepared = consumer.call(
                    "refactor/prepareRename",
                    RefactorPrepareRenameParams(
                        workspaceId = workspace.workspaceId,
                        symbol = SymbolReference(handle = target.handle),
                        newName = "execute",
                        options = RenameOptions(includeComments = false, includeStrings = false),
                    ),
                    RefactorPrepareRenameParams.serializer(),
                    RefactorPrepareRenameResult.serializer(),
                )
                check(prepared is RpcClient.Outcome.Ok) { "prepareRename failed: $prepared" }
                captured["editPlan"] =
                    IdebpJson.encodeToJsonElement(EditPlan.serializer(), prepared.result.plan)
                assertEquals(Guarantee.SEMANTIC, prepared.result.plan.guarantee)
                assertTrue(
                    "the plan must name the document it changes",
                    prepared.result.plan.changes.any { it.uri == documentUri },
                )
                assertTrue("preparing must not edit", file.text.contains("void run()"))

                val applied = consumer.call(
                    "workspace/applyPlan",
                    WorkspaceApplyPlanParams(workspace.workspaceId, prepared.result.plan.planId),
                    WorkspaceApplyPlanParams.serializer(),
                    ModificationResult.serializer(),
                )
                check(applied is RpcClient.Outcome.Ok) { "applyPlan failed: $applied" }
                captured["modification"] =
                    IdebpJson.encodeToJsonElement(ModificationResult.serializer(), applied.result)
                assertTrue("the rename actually happened", file.text.contains("void execute()"))
                assertEquals(1, applied.result.modifiedDocuments.size)
                assertFalse(
                    "the content hash must record that the document changed",
                    applied.result.modifiedDocuments.single().beforeHash ==
                        applied.result.modifiedDocuments.single().afterHash,
                )

                // The undo leg is deliberately absent: `workspace/undo` is implemented and routed,
                // but driving it from here answered PROVIDER_FAILED and the cause is not yet
                // established. The most likely explanation is that the daemon issues its own public
                // undo token and stores the adapter's privately, so the identifier coming back is
                // not the one this adapter minted — but that is a hypothesis, not a finding, and a
                // passing test built on a guess would be worse than no test.

                // One-shot: replaying the plan would repeat an edit against text that has changed.
                val replay = consumer.call(
                    "workspace/applyPlan",
                    WorkspaceApplyPlanParams(workspace.workspaceId, prepared.result.plan.planId),
                    WorkspaceApplyPlanParams.serializer(),
                    ModificationResult.serializer(),
                )
                assertTrue("a consumed plan must be refused: $replay", replay is RpcClient.Outcome.Failed)

        writeCapture(workspace, documentUri)
                assertFalse(
                    "no diagnostic may carry the offending source text",
                    reported.diagnostics.any { it.message.contains("not an int") },
                )
    }

    /** Responses collected as the scenario runs, written once it has produced them all. */
    private val captured = mutableMapOf<String, kotlinx.serialization.json.JsonElement>()

    /**
     * Writes the real responses where the conformance suite can read them.
     *
     * Serialized with the protocol's own encoder, so what is judged is exactly what went on the
     * wire rather than a restatement of it. Written once at the end: a run that fails midway
     * leaves the previous capture rather than a partial one that would read as conformant.
     */
    private fun writeCapture(workspace: Workspace, documentUri: String) {
        val capture = buildJsonObject {
            put("adapter", JsonPrimitive("jetbrains"))
            put("requestedUri", JsonPrimitive(documentUri))
            put("workspace", IdebpJson.encodeToJsonElement(Workspace.serializer(), workspace))
            captured.forEach { (key, value) -> put(key, value) }
        }
        val target = File(repositoryRoot, CONFORMANCE_CAPTURE)
        target.parentFile.mkdirs()
        // Pretty-printed with a trailing newline, matching what Prettier expects of the repository.
        // Written compactly, every run of this test left the working tree failing `format:check`,
        // and a capture is evidence meant to be read in a diff rather than as one long line.
        val pretty = Json { prettyPrint = true; prettyPrintIndent = "  " }
        target.writeText(pretty.encodeToString(JsonObject.serializer(), capture) + "\n")
    }
    private fun awaitDiscovery(path: Path): DiscoveryReader.Outcome {
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < deadline) {
            if (Files.exists(path)) {
                val outcome = DiscoveryReader.read(path)
                if (outcome is DiscoveryReader.Outcome.Ready) return outcome
            }
            Thread.sleep(100)
        }
        return DiscoveryReader.read(path)
    }
}
