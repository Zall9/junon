package com.idebridge.jetbrains.protocol

import kotlinx.serialization.Serializable

/**
 * The private daemon discovery file.
 *
 * It carries the authentication token, so it is `0600` on Unix and its contents must never be
 * logged (AGENTS.md §4). The endpoint is validated as loopback before use — the schema constrains
 * it, and the connection layer checks it again rather than trusting the file.
 */
@Serializable
public data class DiscoveryFile(
    val protocolVersion: String,
    val endpoint: String,
    val token: String,
    val pid: Int,
    val startedAt: String,
)
