package com.idebridge.jetbrains.connection

import com.idebridge.jetbrains.protocol.ErrorCode
import com.idebridge.jetbrains.protocol.IdebpJson
import com.idebridge.jetbrains.protocol.WorkspaceSearchSymbolsParams
import com.idebridge.jetbrains.protocol.WorkspaceSearchSymbolsResult
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test

/**
 * What a search says when it cannot look.
 *
 * The route reads the IDE's name index. While that index is being built there is nothing to read, and
 * an empty list would tell a consumer the symbol does not exist — a claim about the one thing nobody
 * knows yet. `INDEX_NOT_READY` is in the error catalogue for exactly this and is retriable, and the
 * adapter never used it for search until 2026-08-10 (ADR-0034).
 *
 * This is the same reasoning `symbol/getHierarchy` already applied to an unsupported relation, and it
 * is tested the same way: against the router, so the wire answer is what is checked rather than the
 * backend's opinion of it.
 */
class SearchRefusalTest {

    private fun request(id: Int): String = IdebpJson.encodeToString(
        JsonObject.serializer(),
        buildJsonObject {
            put("jsonrpc", JsonPrimitive("2.0"))
            put("id", JsonPrimitive(id))
            put("method", JsonPrimitive("workspace/searchSymbols"))
            put(
                "params",
                IdebpJson.encodeToJsonElement(
                    WorkspaceSearchSymbolsParams.serializer(),
                    WorkspaceSearchSymbolsParams("ws_1", "anything", limit = 10),
                ),
            )
        },
    )

    private class Backend(private val outcome: AdapterRouter.SearchOutcome?) :
        AdapterRouter.Backend {
        override fun searchSymbols(params: WorkspaceSearchSymbolsParams) = outcome

        override fun documentSymbols(workspaceId: String, uri: String) = null
        override fun documentRead(workspaceId: String, uri: String) = null
        override fun documentRevision(workspaceId: String, uri: String) = null
        override fun diagnostics(workspaceId: String, documentUris: List<String>?) = null
        override fun prepareRename(
            params: com.idebridge.jetbrains.protocol.RefactorPrepareRenameParams,
        ) = null

        override fun prepare(params: com.idebridge.jetbrains.protocol.RefactorPrepareParams) = null
        override fun locations(
            method: String,
            params: com.idebridge.jetbrains.protocol.SymbolTargetParams,
        ) = null

        override fun hierarchy(params: com.idebridge.jetbrains.protocol.SymbolHierarchyParams) = null
        override fun searchTodos(
            params: com.idebridge.jetbrains.protocol.WorkspaceSearchTodosParams,
        ) = null

        override fun listBookmarks(
            params: com.idebridge.jetbrains.protocol.WorkspaceListBookmarksParams,
        ) = null

        override fun resolveAt(params: com.idebridge.jetbrains.protocol.SymbolResolveAtParams) = null
        override fun applyPlan(params: com.idebridge.jetbrains.protocol.WorkspaceApplyPlanParams) =
            null

        override fun undo(params: com.idebridge.jetbrains.protocol.WorkspaceUndoParams) = null
        override fun discardPlan(
            params: com.idebridge.jetbrains.protocol.WorkspaceDiscardPlanParams,
        ) = null
    }

    @Test
    @DisplayName("an unbuilt index is refused as retriable, not answered empty")
    fun indexNotReadyIsRefused() {
        val answer = AdapterRouter(Backend(AdapterRouter.SearchOutcome.IndexNotReady))
            .handle("workspace/searchSymbols", request(1))

        assertTrue(answer is RpcClient.Answer.Failed, "expected a refusal, got: $answer")
        assertEquals(ErrorCode.INDEX_NOT_READY, (answer as RpcClient.Answer.Failed).code)
    }

    @Test
    @DisplayName("a workspace this adapter does not serve is still WORKSPACE_NOT_FOUND")
    fun unknownWorkspaceUnchanged() {
        val answer = AdapterRouter(Backend(null)).handle("workspace/searchSymbols", request(2))

        // The two refusals must stay distinguishable: one means "ask again shortly", the other means
        // "you are asking the wrong adapter".
        assertEquals(
            ErrorCode.WORKSPACE_NOT_FOUND,
            (answer as RpcClient.Answer.Failed).code,
        )
    }

    @Test
    @DisplayName("a found result is still forwarded as a result")
    fun foundIsForwarded() {
        val answer = AdapterRouter(
            Backend(
                AdapterRouter.SearchOutcome.Found(
                    WorkspaceSearchSymbolsResult(symbols = emptyList(), truncated = true),
                ),
            ),
        ).handle("workspace/searchSymbols", request(3))

        // An empty-but-truncated result is legitimate here (ADR-0031), so it must travel as a result
        // rather than be turned into a refusal by either side.
        assertTrue(answer is RpcClient.Answer.Result, "expected a result, got: $answer")
    }
}
