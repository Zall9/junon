package com.idebridge.jetbrains.connection

import com.idebridge.jetbrains.protocol.DiscoveryFile
import com.idebridge.jetbrains.protocol.IdebpJson
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermission

/**
 * Reads the private daemon discovery file.
 *
 * The file carries the authentication token, so its contents are never logged and its permissions
 * are checked rather than assumed (AGENTS.md §4). The endpoint is re-validated as loopback here
 * even though the daemon wrote it and the schema constrains it: a file on disk is untrusted input,
 * and connecting anywhere else would defeat the transport's only boundary.
 */
public object DiscoveryReader {
    /** A 32-byte token is 43 base64url characters; anything larger is not a discovery file. */
    private const val MAX_DISCOVERY_BYTES: Long = 4096

    /** Mirrors the canonical schema pattern; loopback hosts only, always on `/rpc`. */
    private val LOOPBACK_ENDPOINT =
        Regex("""^ws://(127\.0\.0\.1|\[::1]):(\d{1,5})/rpc$""")

    public sealed interface Outcome {
        public data class Ready(val discovery: DiscoveryFile) : Outcome

        /** Carries no file content: a failure must not become a way to leak the token. */
        public data class Unusable(val reason: Reason) : Outcome
    }

    public enum class Reason {
        MISSING,
        NOT_A_REGULAR_FILE,
        TOO_LARGE,
        PERMISSIONS_TOO_OPEN,
        MALFORMED,
        ENDPOINT_NOT_LOOPBACK,
    }

    public fun read(path: Path): Outcome {
        // Resolve without following a symlink: a symlinked discovery file would let another user
        // redirect this plugin at an endpoint of their choosing.
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return Outcome.Unusable(Reason.MISSING)
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            return Outcome.Unusable(Reason.NOT_A_REGULAR_FILE)
        }
        if (Files.size(path) > MAX_DISCOVERY_BYTES) return Outcome.Unusable(Reason.TOO_LARGE)
        if (!hasPrivatePermissions(path)) return Outcome.Unusable(Reason.PERMISSIONS_TOO_OPEN)

        val discovery =
            try {
                IdebpJson.decodeFromString(DiscoveryFile.serializer(), Files.readString(path))
            } catch (_: Exception) {
                // Deliberately swallowing the cause: a parse error message can echo file content.
                return Outcome.Unusable(Reason.MALFORMED)
            }
        if (!isLoopbackEndpoint(discovery.endpoint)) {
            return Outcome.Unusable(Reason.ENDPOINT_NOT_LOOPBACK)
        }
        return Outcome.Ready(discovery)
    }

    /** True when no group or other bits are set. Non-POSIX filesystems cannot be checked. */
    public fun hasPrivatePermissions(path: Path): Boolean {
        val view = Files.getFileAttributeView(
            path,
            java.nio.file.attribute.PosixFileAttributeView::class.java,
            LinkOption.NOFOLLOW_LINKS,
        ) ?: return true
        val permissions = view.readAttributes().permissions()
        val shared = setOf(
            PosixFilePermission.GROUP_READ,
            PosixFilePermission.GROUP_WRITE,
            PosixFilePermission.GROUP_EXECUTE,
            PosixFilePermission.OTHERS_READ,
            PosixFilePermission.OTHERS_WRITE,
            PosixFilePermission.OTHERS_EXECUTE,
        )
        return permissions.none { it in shared }
    }

    public fun isLoopbackEndpoint(endpoint: String): Boolean {
        val match = LOOPBACK_ENDPOINT.matchEntire(endpoint) ?: return false
        val port = match.groupValues[2].toIntOrNull() ?: return false
        return port in 1..65535
    }
}
