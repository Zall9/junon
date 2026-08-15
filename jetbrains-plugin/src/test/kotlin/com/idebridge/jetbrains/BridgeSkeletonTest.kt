package com.idebridge.jetbrains

import com.idebridge.jetbrains.service.BridgeDaemonConnectionService
import com.idebridge.jetbrains.service.ReadinessManager
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test

/**
 * Smoke test for the IDE Bridge JetBrains plugin skeleton.
 *
 * This test verifies:
 * 1. Service classes can be instantiated (lifecycle smoke).
 * 2. DiscoveryInfo serialization round-trips (kotlinx.serialization).
 * 3. ReadinessManager state transitions work correctly.
 * 4. BridgeDaemonConnectionService initial state is disconnected.
 *
 * These are pure unit tests (no IntelliJ Platform application context required)
 * to validate the skeleton without needing a full IDE test harness.
 */
@DisplayName("IDE Bridge Plugin Skeleton Smoke Tests")
class BridgeSkeletonTest {

    @Test
    @DisplayName("ReadinessManager starts in DISCONNECTED state")
    fun readinessManagerInitialState() {
        val manager = ReadinessManager()
        assertEquals(
            ReadinessManager.ReadinessState.DISCONNECTED,
            manager.getState(),
            "ReadinessManager must start in DISCONNECTED state"
        )
    }

    @Test
    @DisplayName("ReadinessManager transitions between states")
    fun readinessManagerStateTransition() {
        val manager = ReadinessManager()
        manager.setState(ReadinessManager.ReadinessState.INITIALIZING)
        assertEquals(ReadinessManager.ReadinessState.INITIALIZING, manager.getState())

        manager.setState(ReadinessManager.ReadinessState.INDEXING)
        assertEquals(ReadinessManager.ReadinessState.INDEXING, manager.getState())
        assertFalse(manager.isIndexReady(), "Index must not be ready during INDEXING state")

        manager.setState(ReadinessManager.ReadinessState.READY)
        assertEquals(ReadinessManager.ReadinessState.READY, manager.getState())
        assertTrue(manager.isIndexReady(), "Index must be ready in READY state")

        manager.setState(ReadinessManager.ReadinessState.DEGRADED)
        assertEquals(ReadinessManager.ReadinessState.DEGRADED, manager.getState())
        assertTrue(manager.isIndexReady(), "Index must be ready in DEGRADED state")
    }

    @Test
    @DisplayName("ReadinessManager ignores redundant state transitions")
    fun readinessManagerRedundantTransition() {
        val manager = ReadinessManager()
        manager.setState(ReadinessManager.ReadinessState.READY)
        manager.setState(ReadinessManager.ReadinessState.READY)
        assertEquals(
            ReadinessManager.ReadinessState.READY,
            manager.getState(),
            "Setting the same state should be idempotent"
        )
    }

    @Test
    @DisplayName("BridgeDaemonConnectionService starts with no project linked")
    fun daemonConnectionServiceInitialState() {
        val service = BridgeDaemonConnectionService()
        // The single application-wide `connected` flag this used to assert is what made a dead
        // session look like a live one (ADR-0033). What matters now is which projects are linked,
        // and at the start that is none.
        assertTrue(service.linkedProjects().isEmpty(), "Service must start with no links")
    }

    @Test
    @DisplayName("BridgeDaemonConnectionService releasing links is safe when there are none")
    fun daemonConnectionServiceDisconnectWhenNotConnected() {
        val service = BridgeDaemonConnectionService()
        service.disconnectAll()
        assertTrue(service.linkedProjects().isEmpty(), "Releasing nothing should be safe")
    }

    // The `DiscoveryInfo` round-trip test that stood here covered a placeholder type on the
    // skeleton service. That type is gone now that the service reads discovery through
    // `DiscoveryReader`, and the property it guarded — a token never surfacing — is covered
    // against the real reader by `DiscoveryReaderTest.never surfaces file contents in a failure`.

    @Test
    @DisplayName("WorkspaceInfo serializes and deserializes correctly")
    fun workspaceInfoSerializationRoundTrip() {
        val info = com.idebridge.jetbrains.service.BridgeProjectService.WorkspaceInfo(
            workspaceId = "ws_42",
            rootUri = "file:///home/user/project",
            displayName = "test-project"
        )

        val json = kotlinx.serialization.json.Json.encodeToString(
            com.idebridge.jetbrains.service.BridgeProjectService.WorkspaceInfo.serializer(),
            info
        )
        val decoded = kotlinx.serialization.json.Json.decodeFromString(
            com.idebridge.jetbrains.service.BridgeProjectService.WorkspaceInfo.serializer(),
            json
        )

        assertEquals(info.workspaceId, decoded.workspaceId)
        assertEquals(info.rootUri, decoded.rootUri)
        assertEquals(info.displayName, decoded.displayName)
    }

    @Test
    @DisplayName("ReadinessState enum has all five required IDEBP states")
    fun readinessStateHasAllIdbpStates() {
        val states = ReadinessManager.ReadinessState.values().map { it.name }.toSet()
        val required = setOf("INITIALIZING", "INDEXING", "READY", "DEGRADED", "DISCONNECTED")
        assertEquals(required, states, "ReadinessState must have exactly the five IDEBP states from TASK.md §13")
    }
}
