package com.idebridge.jetbrains.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Symbol identity on the wire.
 *
 * A handle is the fast path, bound to an adapter, a physical session, and a workspace epoch. The
 * locator is the durable identity used to relocate a symbol when its handle no longer resolves
 * (ADR-0003, amended by ADR-0018).
 */

@Serializable
public enum class SymbolKind {
    @SerialName("file")
    FILE,

    @SerialName("module")
    MODULE,

    @SerialName("namespace")
    NAMESPACE,

    @SerialName("package")
    PACKAGE,

    @SerialName("class")
    CLASS,

    @SerialName("method")
    METHOD,

    @SerialName("property")
    PROPERTY,

    @SerialName("field")
    FIELD,

    @SerialName("constructor")
    CONSTRUCTOR,

    @SerialName("enum")
    ENUM,

    @SerialName("interface")
    INTERFACE,

    @SerialName("function")
    FUNCTION,

    @SerialName("variable")
    VARIABLE,

    @SerialName("constant")
    CONSTANT,

    @SerialName("string")
    STRING,

    @SerialName("number")
    NUMBER,

    @SerialName("boolean")
    BOOLEAN,

    @SerialName("array")
    ARRAY,

    @SerialName("object")
    OBJECT,

    @SerialName("key")
    KEY,

    @SerialName("null")
    NULL,

    @SerialName("enumMember")
    ENUM_MEMBER,

    @SerialName("struct")
    STRUCT,

    @SerialName("event")
    EVENT,

    @SerialName("operator")
    OPERATOR,

    @SerialName("typeParameter")
    TYPE_PARAMETER,

    /**
     * A named declaration whose category the host IDE does not expose.
     *
     * Not a fallback for laziness: it is the truthful answer when an IDE hands back a named
     * element without a typed classification. Reporting it as `class` or `function` would be a
     * guess, and a consumer acting on a guessed kind is worse off than one told nothing —
     * name, range and navigation all remain usable without it.
     */
    @SerialName("unknown")
    UNKNOWN,
}

@Serializable
public data class SymbolHandle(
    val adapterId: AdapterId,
    val sessionId: SessionId,
    val id: SymbolHandleId,
    val validUntilEpoch: Int,
)

@Serializable
public data class SymbolLocator(
    val documentUri: String,
    val name: String,
    val qualifiedName: String? = null,
    val kind: SymbolKind,

    /**
     * The IDE's own name for this declaration's syntactic form.
     *
     * Opaque on purpose: it is compared for equality, never interpreted. It comes from the
     * host IDE's parser, so it distinguishes a field from a method in every language without
     * this adapter knowing what either is — which is what lets relocation stay reliable when
     * `kind` is `unknown`.
     */
    val declarationType: String? = null,
    val containerName: String? = null,
    val selectionRange: Range,
    val positionEncoding: PositionEncoding,
    val fingerprint: ContentHash,
)

/** At least one of the two is present; the schema expresses that as an `anyOf`. */
@Serializable
public data class SymbolReference(
    val handle: SymbolHandle? = null,
    val locator: SymbolLocator? = null,
)

@Serializable
public data class Symbol(
    val handle: SymbolHandle,
    val locator: SymbolLocator,
    val range: Range,
    val children: List<Symbol>,
)

@Serializable
public data class SymbolLocation(val location: Location, val symbol: Symbol? = null)
