package com.idebridge.jetbrains.symbol

import com.idebridge.jetbrains.protocol.Range
import com.idebridge.jetbrains.protocol.SymbolLocator

/**
 * Controlled relocation of a stale symbol reference (ADR-0003, amended by ADR-0018).
 *
 * A handle is a fast path bound to a session, an epoch, and a revision. When it no longer resolves,
 * the locator is the durable identity. Matching uses the locator's semantic fields — name, kind, and
 * container name when both sides declare one — inside its own document, with the selection range as
 * a tie-breaker only. Matching the fingerprint instead would fail for any symbol shifted by a single
 * line, which is exactly when a handle goes stale.
 *
 * This rule also exists in the VS Code adapter. Both are checked against
 * `packages/protocol/fixtures/vectors/symbol-relocation-vectors.json` so the same protocol cannot
 * answer differently depending on the IDE (ADR-0025).
 *
 * Nothing is ever guessed: no match fails closed, and several indistinguishable matches report every
 * candidate.
 */
public object SymbolRelocation {
    /** Upper bound on candidates reported with `AMBIGUOUS_SYMBOL`. */
    private const val MAX_CANDIDATES = 32

    /** A mapped symbol: its locator plus its declaration range and children. */
    public data class Draft(
        val locator: SymbolLocator,
        val range: Range,
        val children: List<Draft> = emptyList(),
    )

    public sealed interface Outcome {
        public data class Resolved(val draft: Draft) : Outcome

        public data object NotFound : Outcome

        public data class Ambiguous(val candidates: List<SymbolLocator>) : Outcome
    }

    public fun relocate(target: SymbolLocator, current: List<Draft>): Outcome {
        val matches = collectMatches(target, current)
        if (matches.isEmpty()) return Outcome.NotFound
        matches.singleOrNull()?.let { return Outcome.Resolved(it) }

        // Same name, kind, and container: the original selection range is the only discriminator
        // left, and it decides only when exactly one candidate still carries it.
        val exact = matches.filter { sameRange(it.locator.selectionRange, target.selectionRange) }
        exact.singleOrNull()?.let { return Outcome.Resolved(it) }
        return Outcome.Ambiguous(matches.take(MAX_CANDIDATES).map { it.locator })
    }

    private fun collectMatches(target: SymbolLocator, current: List<Draft>): List<Draft> {
        val matches = mutableListOf<Draft>()
        val pending = ArrayDeque(current)
        while (pending.isNotEmpty()) {
            val draft = pending.removeFirst()
            if (isSameIdentity(draft.locator, target)) matches.add(draft)
            pending.addAll(draft.children)
        }
        return matches
    }

    /**
     * Container name is compared as optional on both sides: a locator minted from a flat search
     * result legitimately lacks the container a hierarchical provider reports, and treating that
     * absence as a mismatch would make such a symbol unrelocatable.
     */
    private fun isSameIdentity(candidate: SymbolLocator, target: SymbolLocator): Boolean {
        if (candidate.documentUri != target.documentUri) return false
        if (candidate.name != target.name) return false
        // The declaration's syntactic form discriminates when both sides have it; `kind` does
        // the job only for adapters whose IDE supplies one, and is `unknown` for the rest.
        // Comparing `unknown` to `unknown` would make a field and a method indistinguishable.
        val candidateType = candidate.declarationType
        val targetType = target.declarationType
        if (candidateType != null && targetType != null) {
            if (candidateType != targetType) return false
        } else if (candidate.kind != target.kind) {
            return false
        }
        val candidateContainer = candidate.containerName
        val targetContainer = target.containerName
        if (candidateContainer == null || targetContainer == null) return true
        return candidateContainer == targetContainer
    }

    private fun sameRange(left: Range, right: Range): Boolean =
        left.start.line == right.start.line &&
            left.start.character == right.start.character &&
            left.end.line == right.end.line &&
            left.end.character == right.end.character
}
