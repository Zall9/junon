package com.idebridge.jetbrains.ui

import com.idebridge.jetbrains.lifecycle.OpenProjectsListener
import com.idebridge.jetbrains.service.BridgeDaemonConnectionService
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.idebridge.jetbrains.service.IndexHealthNotifier
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import javax.swing.JButton
import javax.swing.SwingUtilities

/**
 * The panel that decides which projects this IDE bridges.
 *
 * Linking used to be implicit and unexplained: the first project opened took the single
 * application-wide connection, and every project after it was silently ignored (ADR-0033). Which
 * project a consumer can reach is a decision about what this IDE exposes, so it belongs to the person
 * sitting in front of it — and it has to be visible, because "nothing came back" and "this project is
 * not linked" are answers a consumer cannot tell apart.
 *
 * It states whether a daemon is reachable at all, and then gives **every open project** a row: its
 * name, whether it is linked and to which workspace, and the one action that changes that. A panel
 * that could only link its own project left the other windows' projects describable but not
 * reachable — a user had to walk to another frame to link a project this one can already name.
 */
class BridgeToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = BridgePanel(project)
        val content = ContentFactory.getInstance().createContent(panel, null, false)
        // Disposing the content is what removes the listener: a panel that outlived its project
        // would keep being asked to repaint a window that no longer exists.
        content.setDisposer(panel)
        toolWindow.contentManager.addContent(content)
    }

    private class BridgePanel(private val project: Project) :
        JBPanel<BridgePanel>(BorderLayout()), Disposable {

        private val service = BridgeDaemonConnectionService.getInstance()
        private val daemonState = JBLabel()

        /** One line per open project, rebuilt on every refresh rather than patched in place. */
        private val rows = JBPanel<JBPanel<*>>(GridBagLayout())

        /** Links to running JUNON dashboards, or a line saying none are. */
        private val dashboards = JBPanel<JBPanel<*>>(BorderLayout()).apply {
            border = JBUI.Borders.emptyBottom(10)
        }

        /**
         * What is in flight, per project. EDT only.
         *
         * Kept here rather than on the buttons because a refresh replaces them: another project
         * linking repaints this panel, and a row mid-link has to survive that with its action still
         * disabled.
         */
        private val pending = mutableMapOf<Project, BridgePanelModel.Pending>()

        /** The last refusal per project, so a row can say why a click changed nothing. EDT only. */
        private val refusals = mutableMapOf<Project, BridgeDaemonConnectionService.Outcome.Refusal>()

        private val listener: () -> Unit = { SwingUtilities.invokeLater { refresh() } }
        private val connection = ApplicationManager.getApplication().messageBus.connect()

        /**
         * Whether the plugin warns about a project the index cannot answer for (ADR-0034).
         *
         * Here rather than only in the IDE's settings because this panel is where the consequence
         * shows up: the warning explains an empty search result, and the person reading the empty
         * result is the person reading this.
         */
        private val warnUnindexed = JBCheckBox("Warn when a project has no indexed source root")

        init {
            border = JBUI.Borders.empty(10)
            daemonState.border = JBUI.Borders.emptyBottom(8)
            add(daemonState, BorderLayout.NORTH)
            // The rows sit at the top of what is left rather than spreading through it; a tool
            // window is usually taller than three projects.
            add(
                JBPanel<JBPanel<*>>(BorderLayout()).apply { add(rows, BorderLayout.NORTH) },
                BorderLayout.CENTER,
            )

            add(notifications(), BorderLayout.SOUTH)

            service.addChangeListener(listener)
            // Two separate facts, so two separate signals: the service says when a *link* changed,
            // the topic says when the set of *open projects* did. A project that opens and is
            // refused a link changes only the second.
            connection.subscribe(
                OpenProjectsListener.TOPIC,
                OpenProjectsListener { SwingUtilities.invokeLater { refresh() } },
            )
            refresh()
        }

        override fun dispose() {
            service.removeChangeListener(listener)
            connection.disconnect()
        }

        /**
         * Links or unlinks [target], which may be any open project rather than only this panel's.
         *
         * Linking opens a socket and completes a handshake, so it runs off the EDT and reports back.
         * The row's action is disabled while that is in flight rather than left clickable: a second
         * click would start a second link for the same project, and the service would have to
         * refuse it.
         */
        private fun toggle(target: Project) {
            val linking = !service.isLinked(target)
            pending[target] = if (linking) {
                BridgePanelModel.Pending.LINKING
            } else {
                BridgePanelModel.Pending.UNLINKING
            }
            // The previous refusal is this project's, and it is about to be answered again. Leaving
            // it on screen next to "linking…" would state a reason that no longer applies.
            refusals.remove(target)
            refresh()

            ApplicationManager.getApplication().executeOnPooledThread {
                // A project other than this panel's can be closed between the click and this
                // thread running. Linking it would ask a disposed project for a model it no longer
                // has, so the refresh below is all that is left to do.
                val outcome = when {
                    target.isDisposed -> null
                    linking -> service.link(target)
                    else -> null.also { service.unlink(target) }
                }
                SwingUtilities.invokeLater {
                    pending.remove(target)
                    if (outcome is BridgeDaemonConnectionService.Outcome.Refused) {
                        refusals[target] = outcome.reason
                    }
                    refresh()
                }
            }
        }

        private fun refresh() {
            val available = service.daemonAvailable()
            daemonState.text = BridgePanelModel.daemonLine(available)
            // Re-read rather than trusted: the setting is application-wide, so another window's panel
            // may have changed it since this one was drawn.
            warnUnindexed.isSelected = IndexHealthNotifier.isEnabled()
            refreshDashboards()

            val projects = openProjects()
            // Only projects still open can be acted on, so anything remembered about the others is
            // remembered about nothing — and a closed project's `Project` is worth releasing.
            val open = projects.toSet()
            pending.keys.retainAll(open)
            refusals.keys.retainAll(open)

            rows.removeAll()
            if (projects.isEmpty()) {
                rows.add(JBLabel("No projects are open."), cell(x = 0, y = 0, width = 3))
            }
            // Each project is carried alongside its facts rather than looked up again from the row:
            // two windows can be open on two directories of the same name, and a row found by its
            // title would then act on whichever of them sorted first.
            projects.map { it to facts(it) }
                .sortedWith(compareBy(BridgePanelModel.ORDER) { it.second })
                .forEachIndexed { index, (target, facts) ->
                    addRow(BridgePanelModel.row(facts, available), target, index)
                }
            rows.revalidate()
            rows.repaint()
        }

        /**
         * The notification settings this plugin owns, and a pointer to the one it does not.
         *
         * Whether a balloon also becomes an operating-system notification is the IDE's decision, per
         * notification group, in its own settings — registering the group is what puts `IDE Bridge`
         * there. Reproducing that switch here would be a second control over one setting, and the
         * loser of a disagreement between them would be the user (ADR-0034).
         */
        private fun notifications(): JBPanel<JBPanel<*>> {
            warnUnindexed.isSelected = IndexHealthNotifier.isEnabled()
            warnUnindexed.addActionListener {
                IndexHealthNotifier.setEnabled(warnUnindexed.isSelected)
            }
            val hint = JBLabel(
                "System notifications: Settings → Appearance & Behavior → Notifications → IDE Bridge",
            ).apply {
                foreground = com.intellij.util.ui.UIUtil.getContextHelpForeground()
                border = JBUI.Borders.emptyTop(2)
            }
            return JBPanel<JBPanel<*>>(BorderLayout()).apply {
                border = JBUI.Borders.emptyTop(12)
                add(dashboards, BorderLayout.NORTH)
                add(
                    JBPanel<JBPanel<*>>(BorderLayout()).apply {
                        add(
                            JBLabel("Notifications").apply { border = JBUI.Borders.emptyBottom(4) },
                            BorderLayout.NORTH,
                        )
                        add(warnUnindexed, BorderLayout.CENTER)
                        add(hint, BorderLayout.SOUTH)
                    },
                    BorderLayout.CENTER,
                )
            }
        }

        /**
         * Links to the JUNON dashboards currently running.
         *
         * Rebuilt on every refresh rather than filled once: a dashboard is started and stopped
         * independently of the IDE, so a link fixed at panel-creation time would be right only by
         * luck. When none are running the section stays and says so, because a section that
         * disappears and a plugin that broke are indistinguishable from the outside.
         */
        private fun refreshDashboards() {
            dashboards.removeAll()
            val running = JunonDashboards.running()
            dashboards.isVisible = true
            dashboards.add(
                JBLabel(BridgePanelModel.dashboardLine(running.size)).apply {
                    border = JBUI.Borders.emptyBottom(4)
                    if (running.isEmpty()) foreground = com.intellij.ui.JBColor.GRAY
                },
                BorderLayout.NORTH,
            )
            if (running.isEmpty()) {
                dashboards.revalidate()
                dashboards.repaint()
                return
            }
            val links = JBPanel<JBPanel<*>>(GridBagLayout())
            for ((index, dashboard) in running.withIndex()) {
                val label = dashboard.project?.let { "$it — ${dashboard.url}" } ?: dashboard.url
                links.add(
                    com.intellij.ui.components.ActionLink(label) {
                        com.intellij.ide.BrowserUtil.browse(dashboard.url)
                    },
                    cell(x = 0, y = index, width = 3),
                )
            }
            dashboards.add(links, BorderLayout.CENTER)
            dashboards.revalidate()
            dashboards.repaint()
        }

        private fun facts(target: Project) = BridgePanelModel.Facts(
            name = target.name,
            isPanelProject = target === project,
            workspaceId = service.workspaceIdOf(target),
            pending = pending[target],
            refusal = refusals[target],
        )

        private fun addRow(row: BridgePanelModel.Row, target: Project, index: Int) {
            rows.add(JBLabel(row.title), cell(x = 0, y = index))
            rows.add(JBLabel(row.state), cell(x = 1, y = index, weight = 1.0))
            rows.add(
                JButton(row.action).apply {
                    isEnabled = row.actionEnabled
                    addActionListener { toggle(target) }
                },
                cell(x = 2, y = index),
            )
        }

        /**
         * The projects a row is offered for.
         *
         * A disposed project is dropped rather than drawn: a refresh can be reached from a project
         * closing, and a row for one that is already gone invites a click that can only fail.
         */
        private fun openProjects(): List<Project> =
            ProjectManager.getInstance().openProjects.filter { !it.isDisposed }

        private fun cell(x: Int, y: Int, weight: Double = 0.0, width: Int = 1) =
            GridBagConstraints().apply {
                gridx = x
                gridy = y
                gridwidth = width
                weightx = weight
                anchor = GridBagConstraints.LINE_START
                fill = GridBagConstraints.HORIZONTAL
                insets = JBUI.insets(2, 0, 2, 8)
            }
    }
}
