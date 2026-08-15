package com.idebridge.jetbrains.platform

import com.idebridge.jetbrains.edit.EditScheduler
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.project.Project

/**
 * Runs an edit on the dispatch thread inside a write command.
 *
 * A daemon request arrives on a background thread, and the platform forbids mutating PSI there. The
 * command wrapper is what puts the change in the IDE's own undo stack, so a user can undo an
 * agent's refactoring exactly as they would their own — which is also what makes `workspace/undo`
 * meaningful rather than a second, parallel history.
 *
 * `invokeAndWait` blocks until the edit is done: returning earlier would let the adapter report a
 * modification the consumer could not yet observe.
 */
public class IntelliJEditScheduler(
    private val project: Project,
    private val commandName: String = "IDE Bridge edit",
) : EditScheduler {

    override fun <T> runWrite(block: () -> T): T {
        var result: Result<T>? = null
        ApplicationManager.getApplication().invokeAndWait {
            result = runCatching {
                WriteCommandAction.writeCommandAction(project)
                    .withName(commandName)
                    .compute<T, RuntimeException> { block() }
            }
        }
        // A failure inside the write action is rethrown on the calling thread rather than swallowed,
        // so the router answers with a refusal instead of a success carrying nothing.
        return checkNotNull(result) { "The edit never ran on the dispatch thread" }.getOrThrow()
    }
}
