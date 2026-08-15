package com.idebridge.jetbrains.platform

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The two guards standing between an IDE's quick-fix titles and the wire.
 *
 * Both exist because of something a real run published and no test caught: an uninitialised
 * `IntentionAction` reports `(not initialized) class …QuickFix`, and some titles arrive wrapped in
 * `<html>`. Neither would have failed anything — they would simply have shipped nonsense, which is
 * why they are pinned here rather than left to the next capture to notice.
 */
class QuickFixTitleTest {

    @Test
    fun `strips the markup the platform wraps some titles in`() {
        assertEquals(
            "Migrate 'count' type to 'String'",
            IntelliJDiagnostics.plainText("<html>Migrate 'count' type to 'String'</html>"),
        )
    }

    @Test
    fun `leaves a bare title untouched`() {
        assertEquals(
            "Change field 'count' type to 'String'",
            IntelliJDiagnostics.plainText("Change field 'count' type to 'String'"),
        )
    }

    @Test
    fun `strips nested markup rather than only the outer wrapper`() {
        assertEquals(
            "Migrate count to String",
            IntelliJDiagnostics.plainText("<html><b>Migrate</b> count to <code>String</code></html>"),
        )
    }

    @Test
    fun `accepts wording a consumer can act on`() {
        assertTrue(IntelliJDiagnostics.isUsable("Change field 'count' type to 'String'"))
    }

    // An internal class name where a consumer expects a choosable fix is worse than no offer, so an
    // action that cannot name itself is dropped rather than published.
    @Test
    fun `rejects the placeholder an uninitialised action reports`() {
        assertFalse(
            IntelliJDiagnostics.isUsable(
                "(not initialized) class com.intellij.codeInsight.daemon.impl.quickfix.WrapWithAdapterMethodCallFix",
            ),
        )
    }

    @Test
    fun `rejects a bare platform class name`() {
        assertFalse(
            IntelliJDiagnostics.isUsable("class com.intellij.codeInsight.daemon.impl.quickfix.AddTypeCastFix"),
        )
    }

    // Found by running GoLand, not by a test. Preferring the descriptor's display name published
    // "Annotator" for a Go fix — that field can carry the *inspection's* label rather than the
    // fix's own wording. Two offers both called "Annotator" are as useless to choose between as two
    // class names, so the action's own text wins whenever it is usable.
    @Test
    fun `an inspection label is not a fix title`() {
        assertTrue(IntelliJDiagnostics.isUsable("Optimize imports"))
        assertTrue(IntelliJDiagnostics.isUsable("Remove unused variable 'unused'"))
    }

    @Test
    fun `rejects a title that is only markup`() {
        assertFalse(IntelliJDiagnostics.isUsable(IntelliJDiagnostics.plainText("<html></html>")))
    }
}
