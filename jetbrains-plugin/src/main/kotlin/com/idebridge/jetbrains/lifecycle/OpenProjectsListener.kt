package com.idebridge.jetbrains.lifecycle

import com.intellij.openapi.application.ApplicationManager
import com.intellij.util.messages.Topic

/**
 * Announced when the set of projects this IDE has open changes.
 *
 * The tool window offers a row per open project, so it has to hear about that set — not only about
 * links. A project that opens and is *refused* a link changes no link at all, and a panel listening
 * only to `BridgeDaemonConnectionService` would go on showing a list that is missing it. The two
 * facts are separate: which projects are open, and which of them are linked.
 *
 * The platform states the change in two different places, and this is where they meet.
 * `ProjectManagerListener.projectOpened` is deprecated for removal, so opening arrives as a
 * `ProjectActivity` ([BridgeStartupActivity]) while closing stays a listener
 * ([ProjectLifecycleListener]) — the split `plugin.xml` already records. A subscriber gets one topic
 * instead of reproducing it.
 *
 * Application-level and non-broadcasting: every open project's panel is a subscriber, and each reads
 * the whole set for itself.
 */
fun interface OpenProjectsListener {

    fun openProjectsChanged()

    companion object {

        @JvmField
        @Topic.AppLevel
        val TOPIC: Topic<OpenProjectsListener> =
            Topic(OpenProjectsListener::class.java, Topic.BroadcastDirection.NONE)

        /**
         * Announces the change, from any thread.
         *
         * Silent when there is no application to announce to. A project also closes while the IDE
         * itself is shutting down, and by then the bus this would publish on may already be gone —
         * an announcement nobody can hear is not worth an error in the log.
         */
        @JvmStatic
        fun announce() {
            val application = ApplicationManager.getApplication() ?: return
            if (application.isDisposed) return
            application.messageBus.syncPublisher(TOPIC).openProjectsChanged()
        }
    }
}
