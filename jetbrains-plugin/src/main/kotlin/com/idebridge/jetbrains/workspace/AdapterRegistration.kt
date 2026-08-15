package com.idebridge.jetbrains.workspace

import com.idebridge.jetbrains.connection.RpcClient
import com.idebridge.jetbrains.protocol.AdapterId
import com.idebridge.jetbrains.protocol.Capability
import com.idebridge.jetbrains.protocol.IdeKind
import com.idebridge.jetbrains.protocol.IdeRegisterParams
import com.idebridge.jetbrains.protocol.IdeRegisterResult
import com.idebridge.jetbrains.protocol.IdeUnregisterParams
import com.idebridge.jetbrains.protocol.IdeUnregisterResult
import com.idebridge.jetbrains.protocol.PositionEncoding
import com.idebridge.jetbrains.protocol.Support
import com.idebridge.jetbrains.protocol.Workspace

/**
 * Registers this IDE with the daemon and verifies what came back.
 *
 * Registration parameters are rebuilt from current project state on every call, never cached: after
 * a reconnect the daemon must be told what is true now, not what was true when the plugin started.
 *
 * The response is checked rather than assumed. A daemon that echoed a different adapter identity,
 * or workspaces this adapter does not own, is not a daemon this session should keep talking to.
 */
public class AdapterRegistration(
    private val adapterId: AdapterId,
    private val pluginVersion: String,
    private val ideVersion: String,
    private val ideName: String = "IDE Bridge for JetBrains",
) {
    public sealed interface Outcome {
        public data class Registered(val workspaces: List<Workspace>) : Outcome

        public data class Rejected(val detail: String) : Outcome
    }

    /**
     * Capabilities announced at registration.
     *
     * Only what the plugin actually implements may appear here. Everything still unimplemented is
     * declared `unavailable` with a reason rather than omitted, so a consumer sees a truthful
     * refusal instead of an unexplained absence.
     */
    public fun capabilities(
        implemented: Set<String> = com.idebridge.jetbrains.connection.AdapterRouter.IMPLEMENTED_METHODS,
    ): Map<String, Capability> = buildMap {
        val pending = Capability(
            support = Support.UNAVAILABLE,
            reason = "Not yet implemented by the JetBrains adapter",
        )
        val available = Capability(support = Support.NATIVE)
        // Driven by what the router actually serves: a method cannot be advertised as supported
        // unless a handler exists for it, and cannot be quietly omitted either.
        for (method in ReadinessModel.INDEX_DEPENDENT_METHODS) {
            put(method, if (method in implemented) available else pending)
        }
        for (method in listOf("document/read", "document/getRevision")) {
            put(method, if (method in implemented) available else pending)
        }
    }

    public fun register(client: RpcClient, workspaces: List<Workspace>): Outcome {
        val params = IdeRegisterParams(
            adapterId = adapterId,
            name = ideName,
            version = pluginVersion,
            ideKind = IdeKind.JETBRAINS,
            ideVersion = ideVersion,
            positionEncodings = listOf(PositionEncoding.UTF16),
            capabilities = capabilities(),
            workspaces = workspaces,
        )
        val outcome = client.call(
            "ide/register",
            params,
            IdeRegisterParams.serializer(),
            IdeRegisterResult.serializer(),
        )
        return when (outcome) {
            is RpcClient.Outcome.Ok -> verify(outcome.result, workspaces)
            is RpcClient.Outcome.Failed -> Outcome.Rejected("daemon refused: ${outcome.code}")
            is RpcClient.Outcome.Broken -> Outcome.Rejected("transport: ${outcome.reason}")
        }
    }

    public fun unregister(client: RpcClient): Boolean {
        val outcome = client.call(
            "ide/unregister",
            IdeUnregisterParams(adapterId),
            IdeUnregisterParams.serializer(),
            IdeUnregisterResult.serializer(),
        )
        return outcome is RpcClient.Outcome.Ok &&
            outcome.result.unregistered &&
            outcome.result.adapterId == adapterId
    }

    private fun verify(result: IdeRegisterResult, sent: List<Workspace>): Outcome {
        if (result.adapter.adapterId != adapterId) {
            return Outcome.Rejected("daemon echoed a different adapter identity")
        }
        val expected = sent.map { it.workspaceId }.toSet()
        val returned = result.workspaces.map { it.workspaceId }.toSet()
        if (expected != returned) {
            return Outcome.Rejected("daemon returned a different workspace set")
        }
        if (result.workspaces.any { it.adapterId != adapterId }) {
            return Outcome.Rejected("daemon assigned a workspace to another adapter")
        }
        return Outcome.Registered(result.workspaces)
    }
}
