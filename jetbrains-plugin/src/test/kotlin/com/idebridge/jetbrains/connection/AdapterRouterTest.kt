package com.idebridge.jetbrains.connection

import com.idebridge.jetbrains.protocol.Atomicity
import com.idebridge.jetbrains.protocol.ChangeSummary
import com.idebridge.jetbrains.protocol.DiagnosticsGetSnapshotResult
import com.idebridge.jetbrains.protocol.DocumentGetSymbolsResult
import com.idebridge.jetbrains.protocol.EditOperation
import com.idebridge.jetbrains.protocol.EditPlan
import com.idebridge.jetbrains.protocol.ErrorCode
import com.idebridge.jetbrains.protocol.Guarantee
import com.idebridge.jetbrains.protocol.IdebpJson
import com.idebridge.jetbrains.protocol.RefactorPrepareParams
import com.idebridge.jetbrains.protocol.SymbolLocationsResult
import com.idebridge.jetbrains.protocol.SymbolResolveAtParams
import com.idebridge.jetbrains.protocol.SymbolResolveAtResult
import com.idebridge.jetbrains.protocol.SymbolTargetParams
import com.idebridge.jetbrains.protocol.RefactorPrepareRenameParams
import com.idebridge.jetbrains.protocol.RefactorPrepareRenameResult
import com.idebridge.jetbrains.protocol.WorkspaceApplyPlanParams
import com.idebridge.jetbrains.protocol.WorkspaceDiscardPlanParams
import com.idebridge.jetbrains.protocol.WorkspaceDiscardPlanResult
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Routing, decoding and refusals — without an IDE.
 *
 * The backend is what touches the platform, so everything the daemon can observe about a request's
 * outcome is decided here and is testable here.
 */
class AdapterRouterTest {

    private val plan = EditPlan(
        planId = "plan_1",
        adapterId = "adapter_1",
        sessionId = "session_1",
        workspaceId = "ws_1",
        expiresAt = "2026-08-02T12:02:00Z",
        operation = EditOperation.RENAME,
        guarantee = Guarantee.SEMANTIC,
        atomicity = Atomicity.SEMANTIC,
        preconditions = emptyList(),
        changes = listOf(ChangeSummary(uri = "file:///demo/A.java", editCount = 2)),
        warnings = emptyList(),
    )

    private open class StubBackend : AdapterRouter.Backend {
        override fun documentSymbols(
            workspaceId: String,
            uri: String,
        ): AdapterRouter.SymbolsOutcome? = null

        override fun searchSymbols(
            params: com.idebridge.jetbrains.protocol.WorkspaceSearchSymbolsParams,
        ): AdapterRouter.SearchOutcome? = null

        override fun documentRead(workspaceId: String, uri: String): com.idebridge.jetbrains.protocol.DocumentContent? = null

        override fun documentRevision(
            workspaceId: String,
            uri: String,
        ): com.idebridge.jetbrains.protocol.DocumentGetRevisionResult? = null

        override fun diagnostics(
            workspaceId: String,
            documentUris: List<String>?,
        ): AdapterRouter.DiagnosticsOutcome? = null

        override fun locations(
            method: String,
            params: SymbolTargetParams,
        ): SymbolLocationsResult? = null

        override fun listBookmarks(
            params: com.idebridge.jetbrains.protocol.WorkspaceListBookmarksParams,
        ): com.idebridge.jetbrains.protocol.WorkspaceListBookmarksResult? = null

        override fun searchTodos(
            params: com.idebridge.jetbrains.protocol.WorkspaceSearchTodosParams,
        ): com.idebridge.jetbrains.protocol.WorkspaceSearchTodosResult? = null

        override fun hierarchy(
            params: com.idebridge.jetbrains.protocol.SymbolHierarchyParams,
        ): AdapterRouter.HierarchyOutcome? = null

        override fun resolveAt(params: SymbolResolveAtParams): SymbolResolveAtResult? = null
        override fun prepare(
            params: RefactorPrepareParams,
        ): AdapterRouter.RenameOutcome? = null

        override fun prepareRename(
            params: RefactorPrepareRenameParams,
        ): AdapterRouter.RenameOutcome? = null

        override fun applyPlan(params: WorkspaceApplyPlanParams): AdapterRouter.ApplyOutcome? = null

        override fun undo(
            params: com.idebridge.jetbrains.protocol.WorkspaceUndoParams,
        ): AdapterRouter.ApplyOutcome? = null

        override fun discardPlan(
            params: WorkspaceDiscardPlanParams,
        ): WorkspaceDiscardPlanResult? = null
    }

    private fun request(method: String, params: JsonObject): String = IdebpJson.encodeToString(
        JsonObject.serializer(),
        buildJsonObject {
            put("jsonrpc", JsonPrimitive("2.0"))
            put("id", JsonPrimitive("r-1"))
            put("method", JsonPrimitive(method))
            put("params", params)
        },
    )

    private val prepareParams = buildJsonObject {
        put("workspaceId", JsonPrimitive("ws_1"))
        put(
            "symbol",
            buildJsonObject {
                put(
                    "handle",
                    buildJsonObject {
                        put("adapterId", JsonPrimitive("adapter_1"))
                        put("sessionId", JsonPrimitive("session_1"))
                        put("id", JsonPrimitive("sym_1"))
                        put("validUntilEpoch", JsonPrimitive(0))
                    },
                )
            },
        )
        put("newName", JsonPrimitive("amount"))
        put(
            "options",
            buildJsonObject {
                put("includeComments", JsonPrimitive(false))
                put("includeStrings", JsonPrimitive(false))
            },
        )
    }

    private fun code(answer: RpcClient.Answer): ErrorCode =
        assertIs<RpcClient.Answer.Failed>(answer).code

    @Test
    fun `routes a hierarchy step and returns its locations`() {
        val router = AdapterRouter(object : StubBackend() {
            override fun hierarchy(
                params: com.idebridge.jetbrains.protocol.SymbolHierarchyParams,
            ) = AdapterRouter.HierarchyOutcome.Found(SymbolLocationsResult(emptyList(), false))
        })

        val answer = router.handle(
            "symbol/getHierarchy",
            """{"jsonrpc":"2.0","id":"h1","method":"symbol/getHierarchy","params":""" +
                """{"workspaceId":"ws_1","symbol":{"handle":{"id":"s1","adapterId":"a",""" +
                """"sessionId":"sess","validUntilEpoch":1}},"relation":"callers"}}""",
        )

        assertEquals(true, answer is RpcClient.Answer.Result, "expected a result, got $answer")
    }

    @Test
    fun `refuses a relation with no engine rather than answering it empty`() {
        // An unsupported relation returned as an empty list reads as "nothing found" and would be
        // believed. The refusal has to be visible on the wire, not inferred from silence.
        val router = AdapterRouter(object : StubBackend() {
            override fun hierarchy(
                params: com.idebridge.jetbrains.protocol.SymbolHierarchyParams,
            ) = AdapterRouter.HierarchyOutcome.Unsupported
        })

        val answer = router.handle(
            "symbol/getHierarchy",
            """{"jsonrpc":"2.0","id":"h2","method":"symbol/getHierarchy","params":""" +
                """{"workspaceId":"ws_1","symbol":{"handle":{"id":"s1","adapterId":"a",""" +
                """"sessionId":"sess","validUntilEpoch":1}},"relation":"supertypes"}}""",
        )

        assertEquals(
            RpcClient.Answer.Failed(ErrorCode.CAPABILITY_UNAVAILABLE),
            answer,
        )
    }

    @Test
    fun `serves a prepared rename plan`() {
        val router = AdapterRouter(object : StubBackend() {
            override fun prepareRename(params: RefactorPrepareRenameParams) =
                AdapterRouter.RenameOutcome.Prepared(RefactorPrepareRenameResult(plan))
        })

        val answer = router.handle("refactor/prepareRename", request("refactor/prepareRename", prepareParams))

        val result = assertIs<RpcClient.Answer.Result>(answer)
        assertEquals(
            "plan_1",
            result.json.jsonObject["plan"]!!.jsonObject["planId"]!!.jsonPrimitive.content,
        )
    }

    @Test
    fun `passes a backend refusal through as its own code`() {
        val router = AdapterRouter(object : StubBackend() {
            override fun prepareRename(params: RefactorPrepareRenameParams) =
                AdapterRouter.RenameOutcome.Refused(ErrorCode.STALE_SYMBOL)
        })

        // A stale symbol is a different fact from an unknown workspace, and the consumer acts on
        // the difference: one is retried after relocating, the other is not.
        assertEquals(
            ErrorCode.STALE_SYMBOL,
            code(router.handle("refactor/prepareRename", request("refactor/prepareRename", prepareParams))),
        )
    }

    @Test
    fun `an unknown workspace is refused as such`() {
        val router = AdapterRouter(StubBackend())

        assertEquals(
            ErrorCode.WORKSPACE_NOT_FOUND,
            code(router.handle("refactor/prepareRename", request("refactor/prepareRename", prepareParams))),
        )
    }

    @Test
    fun `an unknown plan is refused as a plan problem, not a workspace one`() {
        val router = AdapterRouter(StubBackend())
        val params = buildJsonObject {
            put("workspaceId", JsonPrimitive("ws_1"))
            put("planId", JsonPrimitive("plan_missing"))
        }

        assertEquals(
            ErrorCode.PLAN_NOT_FOUND,
            code(router.handle("workspace/discardPlan", request("workspace/discardPlan", params))),
        )
    }

    @Test
    fun `discarding answers whether the plan was there`() {
        val router = AdapterRouter(object : StubBackend() {
            override fun discardPlan(params: WorkspaceDiscardPlanParams) =
                WorkspaceDiscardPlanResult(planId = params.planId, discarded = true)
        })
        val params = buildJsonObject {
            put("workspaceId", JsonPrimitive("ws_1"))
            put("planId", JsonPrimitive("plan_1"))
        }

        val result = assertIs<RpcClient.Answer.Result>(
            router.handle("workspace/discardPlan", request("workspace/discardPlan", params)),
        )
        assertEquals(true, result.json.jsonObject["discarded"]!!.jsonPrimitive.content.toBoolean())
    }

    @Test
    fun `undecodable parameters are an invalid request, not a provider failure`() {
        val router = AdapterRouter(StubBackend())

        // The distinction matters: one blames the caller, the other blames the IDE.
        assertEquals(
            ErrorCode.INVALID_REQUEST,
            code(
                router.handle(
                    "workspace/applyPlan",
                    request("workspace/applyPlan", buildJsonObject { put("nope", JsonPrimitive(1)) }),
                ),
            ),
        )
    }

    @Test
    fun `a backend that throws is a provider failure, not an adapter fault`() {
        val router = AdapterRouter(object : StubBackend() {
            override fun applyPlan(params: WorkspaceApplyPlanParams): AdapterRouter.ApplyOutcome =
                error("the refactoring engine blew up")
        })
        val params = buildJsonObject {
            put("workspaceId", JsonPrimitive("ws_1"))
            put("planId", JsonPrimitive("plan_1"))
        }

        assertEquals(
            ErrorCode.PROVIDER_FAILED,
            code(router.handle("workspace/applyPlan", request("workspace/applyPlan", params))),
        )
    }

    @Test
    fun `a method with no route is unsupported, matching what registration advertises`() {
        val router = AdapterRouter(StubBackend())

        assertIs<RpcClient.Answer.Unsupported>(
            router.handle("workspace/list", request("workspace/list", buildJsonObject { })),
        )
        // The advertised set and the routed set are the same object, so they cannot disagree.
        //  is answered by the daemon itself and never routed to an adapter, which
        // is why it stands in here now that every routed method is served.
        assertEquals(false, "workspace/list" in AdapterRouter.IMPLEMENTED_METHODS)
    }
}
