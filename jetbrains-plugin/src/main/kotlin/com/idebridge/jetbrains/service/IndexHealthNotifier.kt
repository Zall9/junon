package com.idebridge.jetbrains.service

import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import java.util.concurrent.ConcurrentHashMap

/**
 * Tells the person in the IDE when a symbol search cannot answer, and why.
 *
 * The wire carries this too — `INDEX_NOT_READY` while indexing, `truncated` when a project has no
 * source root (ADR-0034) — but neither reaches the only party who can fix the second one. A project
 * whose files are in a content root that no module marks as sources is fully indexed *for nothing*: the
 * IDE's own Go-to-Symbol finds nothing in it either, so no amount of retrying helps. That state cost an
 * hour to identify by hand on 2026-08-10; the notification is that hour, given back.
 *
 * **Once per project, and only for what a person can act on.** Indexing finishes by itself, so it is
 * reported on the wire and not as a balloon; a missing source root does not, so it is. Repeating either
 * on every search would train the user to dismiss them.
 *
 * Whether these appear at all is the user's, twice over: the checkbox in the `IDE Bridge` panel, and —
 * for whether a balloon also becomes an operating-system notification — the IDE's own
 * Settings → Appearance & Behavior → Notifications, which owns that decision for every plugin. Forcing
 * a system notification from here would be deciding it for them.
 */
public object IndexHealthNotifier {

    /**
     * The group id, matching `<notificationGroup>` in `plugin.xml`.
     *
     * The product name carries into it, and into every notification title, so a balloon says which
     * product it came from before it says what it wants. The group id is also what the user sees in
     * Settings → Notifications, where they silence it.
     */
    private const val GROUP = "Junon - IDE Bridge"

    /** Prefixed onto every title, so the source is stated even where the group name is not shown. */
    private const val PREFIX = "Junon - IDE Bridge"

    /** Persisted app-wide, so the choice survives a restart the way any other IDE setting does. */
    public const val ENABLED_KEY: String = "ide-bridge.notify.index-health"

    private val warned = ConcurrentHashMap.newKeySet<String>()

    public fun isEnabled(): Boolean =
        PropertiesComponent.getInstance().getBoolean(ENABLED_KEY, true)

    public fun setEnabled(enabled: Boolean) {
        PropertiesComponent.getInstance().setValue(ENABLED_KEY, enabled, true)
    }

    /**
     * Warns that [project] has no indexed source root, at most once per project per session.
     *
     * Says what to do rather than what happened: the two fixes are marking a directory as sources or
     * finishing the project import, and a message that only reported "search returned nothing" would
     * leave the reader exactly where the measurement started.
     */
    public fun warnNoSourceRoots(project: Project) {
        if (!isEnabled()) return
        if (project.isDisposed) return
        if (!warned.add(key(project))) return

        NotificationGroupManager.getInstance()
            .getNotificationGroup(GROUP)
            .createNotification(
                "$PREFIX: symbol search cannot answer for this project",
                "No directory in ${project.name} is indexed as a source root, so the IDE's own symbol " +
                    "index holds nothing for it — Go to Symbol finds nothing here either. Mark a " +
                    "directory as Sources Root, or finish the project import, then search again.",
                NotificationType.WARNING,
            )
            .notify(project)
    }

    /** Forgets what a project was warned about, so a fixed project can warn again if it regresses. */
    public fun forget(project: Project) {
        warned.remove(key(project))
    }

    // Keyed by name and location rather than by the `Project` object: a project that closes and
    // reopens is a different instance, and holding the old one here would keep it from being
    // collected for as long as the IDE runs.
    private fun key(project: Project): String = "${project.name}@${project.locationHash}"
}
