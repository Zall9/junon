package com.idebridge.jetbrains.workspace

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/**
 * Workspace URI containment, in Kotlin.
 *
 * This is a second implementation of a rule the daemon also enforces. An adapter whose rule is
 * looser returns URIs the daemon rejects as a policy violation and loses its session, so the two
 * must agree exactly. They are checked against one shared vector file —
 * `packages/protocol/fixtures/vectors/uri-containment-vectors.json` — rather than against cases
 * written twice (ADR-0025).
 *
 * Neither URI is ever converted to a local filesystem path. Percent-encoding and dot segments are
 * normalized for authorization only; the original URI remains what travels on the wire.
 */
public object WorkspaceUri {
    public fun isWithinRoot(documentUri: String, rootUri: String): Boolean {
        val document = parse(documentUri) ?: return false
        val root = parse(rootUri) ?: return false

        if (document.scheme != root.scheme) return false
        if (document.rawAuthority.orEmpty() != root.rawAuthority.orEmpty()) return false
        // A query or fragment is not part of a document identity here; refusing rather than
        // ignoring keeps this aligned with the daemon.
        if (document.rawQuery != null || root.rawQuery != null) return false
        if (document.rawFragment != null || root.rawFragment != null) return false

        val documentSegments = normalizedSegments(document.rawPath) ?: return false
        val rootSegments = normalizedSegments(root.rawPath) ?: return false
        if (rootSegments.size > documentSegments.size) return false
        return rootSegments.indices.all { documentSegments[it] == rootSegments[it] }
    }

    /** True when the value parses as a URI with a scheme — what the wire requires of any root. */
    public fun hasScheme(value: String): Boolean = parse(value) != null

    private class Parsed(
        val scheme: String?,
        val rawAuthority: String?,
        val rawPath: String,
        val rawQuery: String?,
        val rawFragment: String?,
    )

    private fun parse(value: String): Parsed? {
        if (value.isEmpty()) return null
        val uri = runCatching { URI(value) }.getOrNull() ?: return null
        if (uri.scheme == null) return null
        return Parsed(uri.scheme, uri.rawAuthority, uri.rawPath ?: "", uri.rawQuery, uri.rawFragment)
    }

    /**
     * Decodes the path, then resolves dot segments. Returns `null` when the path cannot be decoded,
     * contains a NUL or a backslash, or escapes above the root — all of which fail closed.
     */
    private fun normalizedSegments(rawPath: String): List<String>? {
        val decoded =
            runCatching { URLDecoder.decode(rawPath, StandardCharsets.UTF_8) }.getOrNull()
                ?: return null
        if (decoded.contains('\u0000') || decoded.contains('\\')) return null

        val segments = mutableListOf<String>()
        for (segment in decoded.split('/')) {
            when {
                segment.isEmpty() || segment == "." -> continue
                segment == ".." -> {
                    if (segments.isEmpty()) return null
                    segments.removeAt(segments.size - 1)
                }
                else -> segments.add(segment)
            }
        }
        return segments
    }
}
