package com.idebridge.jetbrains.service

import com.idebridge.jetbrains.connection.AdapterRouter
import com.idebridge.jetbrains.connection.DiscoveryReader
import com.idebridge.jetbrains.connection.HandshakeClient
import com.idebridge.jetbrains.connection.RpcClient
import com.idebridge.jetbrains.connection.WebSocketTransport
import com.idebridge.jetbrains.platform.DaemonAnalysisTracker
import com.idebridge.jetbrains.platform.IntelliJProjectSnapshot
import com.idebridge.jetbrains.protocol.DocumentEventParams
import com.idebridge.jetbrains.protocol.EndpointTopology
import com.idebridge.jetbrains.protocol.EnvironmentKind
import com.idebridge.jetbrains.protocol.HostKind
import com.idebridge.jetbrains.protocol.PeerInfo
import com.idebridge.jetbrains.protocol.SessionRole
import com.idebridge.jetbrains.protocol.WorkspaceReadinessChangedParams
import com.idebridge.jetbrains.workspace.AdapterRegistration
import com.idebridge.jetbrains.workspace.ReadinessModel
import com.idebridge.jetbrains.workspace.ReadinessWatchdog
import com.idebridge.jetbrains.workspace.WorkspaceModel
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.FileDocumentManagerListener
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileDeleteEvent
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.vfs.newvfs.events.VFileMoveEvent
import com.intellij.openapi.vfs.newvfs.events.VFilePropertyChangeEvent
import com.idebridge.jetbrains.protocol.DiagnosticsChangedParams
import com.idebridge.jetbrains.protocol.DocumentDeletedParams
import com.idebridge.jetbrains.protocol.DocumentRenamedParams
import com.intellij.openapi.application.ReadAction
import com.intellij.util.concurrency.AppExecutorUtil
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import com.intellij.util.messages.MessageBusConnection
import java.nio.file.Path
import java.nio.file.Paths
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Owns the plugin's sessions with the daemon — **one per linked project**.
 *
 * A link connects, registers that project as a workspace, and then **serves**: the daemon routes a
 * consumer's request here and waits for an answer. Serving runs on its own thread, so the dispatch
 * thread stays free — an edit needs the EDT, and an adapter that occupied it while waiting on its
 * own edit would deadlock.
 *
 * **Why a session per project rather than several workspaces on one.** `ide/register` creates an
 * adapter *and* its workspaces in a single call, and the protocol has no route that adds a workspace
 * to a live session; announcing a second project on one session would therefore need a protocol
 * change, not an adapter change (ADR-0033). The daemon already accepts many adapter sessions — that
 * is how two IDEs connect at once — so one per project is the arrangement that exists today.
 *
 * **What this replaces.** A single application-wide `connected` flag, one socket, and one workspace,
 * with `disconnect()` reached only at IDE shutdown. Measured in a real IDE on 2026-08-10: closing a
 * project killed the serving thread and the daemon dropped the adapter, while the flag stayed `true`,
 * so `connect()` returned early — **without logging** — and no project ever registered again until
 * the IDE restarted. Readiness reported `DISCONNECTED` while the service believed it was connected.
 * Links are now per project, released when a project closes, and every refusal has a reason a caller
 * can show.
 *
 * Nothing here logs the token or any file content (AGENTS.md §4).
 */
@Service(Service.Level.APP)
class BridgeDaemonConnectionService(
    /**
     * Where the discovery file is looked for.
     *
     * A parameter with a default rather than a hard-coded path, so a test states which daemon it is
     * talking about. The first version of this class's tests asserted "no daemon is running", which
     * passed on a clean machine and failed on the developer's — where a daemon *was* running and the
     * fixture project genuinely linked to it. A test whose result depends on what else is running on
     * the machine is not a test of this code. Kotlin keeps the no-argument constructor the platform
     * needs to instantiate the service.
     */
    private val discoveryPathProvider: () -> Path = ::defaultDiscoveryPath,
    /**
     * How the analysis tracker is made, so a test can watch it being disposed.
     *
     * The same reason as the path above: a lifecycle that only the platform can observe is a
     * lifecycle nothing can hold to account. This one exists because the tracker was created on
     * every link attempt, refused ones included, and released by nothing.
     */
    private val trackerFactory: (Project) -> DaemonAnalysisTracker = { DaemonAnalysisTracker(it) },
) {

    private val logger = logger<BridgeDaemonConnectionService>()

    /** One project's live session. */
    private class Link(
        val adapterId: String,
        val workspaceId: String,
        val transport: WebSocketTransport,
        /** Kept so readiness can be announced after linking, not only served on request. */
        val client: RpcClient,
        /** The project's subscription to indexing transitions; disconnected when the link ends. */
        val indexing: MessageBusConnection,
        /** Announces readiness, and notices when the IDE stops answering at all. */
        val watchdog: ReadinessWatchdog,
        /** Coalesces the user's typing into one `document/changed` per document. */
        val announcer: DocumentChangeAnnouncer,
        /** The same, for `diagnostics/changed`. */
        val diagnosticsAnnouncer: DocumentChangeAnnouncer,
        /** Reads documents for the announcements above, through the same route consumers use. */
        val backend: AdapterBackend,
        /** Holds the editor listener; disposed when the link ends. */
        val documentListeners: Disposable,
        /** The analysis subscription; disposed when the link ends, or it outlives every link. */
        val tracker: Disposable,
    ) {
        /** Set once the thread exists; the thread needs the link, and the link needs the thread. */
        @Volatile
        var serving: Thread? = null

        /** The periodic probe; cancelled when the link ends. */
        @Volatile
        var heartbeat: ScheduledFuture<*>? = null

        /** The periodic file-system refresh; cancelled with the link. */
        @Volatile
        var refresh: ScheduledFuture<*>? = null
    }

    /**
     * What linking did, or why it did not.
     *
     * A refusal carries its reason so the tool window can state it. Returning a bare `false` is what
     * let a broken link look like a quiet decision not to link.
     */
    sealed interface Outcome {
        data class Linked(val workspaceId: String) : Outcome

        data class AlreadyLinked(val workspaceId: String) : Outcome

        enum class Refusal {
            /** No daemon is running, or its discovery file is not usable. */
            NO_DAEMON,

            /** The project publishes no content root, so there is no workspace to register. */
            NO_CONTENT_ROOT,

            /** The discovery file names an endpoint that refused the socket. */
            UNREACHABLE,

            HANDSHAKE_REFUSED,
            REGISTRATION_REFUSED,
        }

        data class Refused(val reason: Refusal) : Outcome
    }

    private val links = ConcurrentHashMap<Project, Link>()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    private fun discoveryPath(): Path = discoveryPathProvider()

    /**
     * Links [project]: connects, registers it as a workspace, and serves. Must be called off the EDT.
     *
     * Idempotent, and says which case it took: a project already linked reports the workspace it is
     * serving rather than silently doing nothing.
     */
    fun link(project: Project): Outcome {
        links[project]?.let { return Outcome.AlreadyLinked(it.workspaceId) }

        val path = discoveryPath()
        val discovery = DiscoveryReader.read(path)
        if (discovery !is DiscoveryReader.Outcome.Ready) {
            logger.info("[IDE Bridge] no usable discovery file at $path: $discovery")
            return Outcome.Refused(Outcome.Refusal.NO_DAEMON)
        }

        val snapshot = IntelliJProjectSnapshot.capture(project)
        val adapterId = WorkspaceModel.createIdentifier("adapter_")
        val model = WorkspaceModel(adapterId)
        val workspace = model.snapshot(snapshot)
        if (workspace == null) {
            logger.info("[IDE Bridge] ${project.name} has no content root; nothing to publish")
            return Outcome.Refused(Outcome.Refusal.NO_CONTENT_ROOT)
        }

        val socket = runCatching { WebSocketTransport.connect(discovery.discovery.endpoint) }
            .getOrElse {
                logger.info("[IDE Bridge] daemon endpoint unreachable")
                return Outcome.Refused(Outcome.Refusal.UNREACHABLE)
            }

        val topology = EndpointTopology(
            hostKind = HostKind.LOCAL,
            environmentKind = EnvironmentKind.LOCAL,
            uriSchemes = workspace.roots.map { it.uri.substringBefore("://") }.distinct(),
        )
        val handshake = HandshakeClient(PeerInfo(PLUGIN_NAME, PLUGIN_VERSION)).connect(
            socket,
            discovery.discovery,
            SessionRole.ADAPTER,
            topology,
            WorkspaceModel.createIdentifier("conn_"),
        )
        if (handshake !is HandshakeClient.Outcome.Established) {
            logger.warn("[IDE Bridge] handshake refused: $handshake")
            socket.close()
            return Outcome.Refused(Outcome.Refusal.HANDSHAKE_REFUSED)
        }


        // Disposed with the link, and on every failure below. It subscribes to the analysis daemon
        // for the project's lifetime otherwise: each attempt — including each refused one — left
        // another listener accumulating URLs in the user's IDE, and nothing ever released them.
        // Re-linking is now ordinary rather than rare, since a session the daemon closes releases
        // its link, so this accumulates where it used to merely linger.
        val tracker = trackerFactory(project).also { it.start() }
        val backend = AdapterBackend(
            project = project,
            workspace = workspace,
            adapterId = adapterId,
            sessionId = handshake.session.sessionId,
            workspaceEpoch = workspace.workspaceEpoch,
            tracker = tracker,
        )
        val client = RpcClient(socket, onRequest = AdapterRouter(backend))
        // Set after the client exists, because the client is built with the backend. Until this
        // adapter sent it, the daemon never learned that an edit it had routed changed a document,
        // so its own plans against that document stayed live (TASK.md §12, ADR-0038).
        backend.announceChange = { content ->
            runCatching {
                client.notify(
                    "document/changed",
                    DocumentEventParams(content.document),
                    DocumentEventParams.serializer(),
                )
            }.onFailure {
                logger.info("[IDE Bridge] could not announce a document change: $it")
            }
        }
        val registration = AdapterRegistration(adapterId, PLUGIN_VERSION, ideVersion())
            .register(client, listOf(workspace))
        if (registration !is AdapterRegistration.Outcome.Registered) {
            logger.warn("[IDE Bridge] registration refused: $registration")
            socket.close()
            Disposer.dispose(tracker)
            return Outcome.Refused(Outcome.Refusal.REGISTRATION_REFUSED)
        }

        // Indexing transitions are the only thing that moves a workspace between `indexing` and
        // `ready`, and nothing was watching them: the state was set once at start-up and never
        // again, so `workspace/getStatus` answered `initializing` indefinitely while search and
        // symbols worked perfectly. Measured on a real IDE, twenty minutes after it had settled.
        val indexing = project.messageBus.connect()
        indexing.subscribe(
            DumbService.DUMB_MODE,
            object : DumbService.DumbModeListener {
                override fun enteredDumbMode() = announceReadiness(project)
                override fun exitDumbMode() = announceReadiness(project)
            },
        )

        val watchdog = ReadinessWatchdog(
            probe = { canServe() },
            indexState = { IntelliJProjectSnapshot.indexState(project) },
            publish = { state -> publishReadiness(project, state) },
        )

        val documentListeners = Disposer.newDisposable("idebp-document-listeners")
        // What the user types, coalesced. Until this existed the daemon heard only about edits the
        // bridge itself made, so a plan prepared before someone typed stayed live there and was
        // caught only by the adapter's own precondition check (TASK.md §12, ADR-0038).
        val announcer = DocumentChangeAnnouncer(
            schedule = { task ->
                AppExecutorUtil.getAppScheduledExecutorService()
                    .schedule(task, CHANGE_DEBOUNCE_MS, TimeUnit.MILLISECONDS)
            },
            announce = { uri -> announceDocumentChange(project, uri) },
        )
        // Diagnostics coalesce on the same rule and the same interval; a separate instance so a
        // file's typing and its analysis do not cancel each other's notification.
        val diagnosticsAnnouncer = DocumentChangeAnnouncer(
            schedule = { task ->
                AppExecutorUtil.getAppScheduledExecutorService()
                    .schedule(task, CHANGE_DEBOUNCE_MS, TimeUnit.MILLISECONDS)
            },
            announce = { uri -> announceDiagnosticsChanged(project, uri) },
        )
        subscribeToEditorEvents(project, documentListeners, diagnosticsAnnouncer)
        // The application-wide multicaster, filtered to this project's workspace. A per-editor
        // listener would miss documents changed without an editor, which is how a refactoring
        // rewrites a file nobody has open.
        EditorFactory.getInstance().eventMulticaster.addDocumentListener(
            object : DocumentListener {
                override fun documentChanged(event: DocumentEvent) {
                    // Runs on the IDE's event thread, on every keystroke in the whole application.
                    // Everything here is O(1) and allocation-light on purpose; the mapping and the
                    // send happen later, on a pooled thread.
                    val uri = FileDocumentManager.getInstance().getFile(event.document)?.url
                        ?: return
                    announcer.noteChanged(uri)
                }
            },
            documentListeners,
        )
        val link = Link(
            adapterId,
            workspace.workspaceId,
            socket,
            client,
            indexing,
            watchdog,
            announcer,
            diagnosticsAnnouncer,
            backend,
            documentListeners,
            tracker,
        )
        // Registered before the thread starts. A daemon that closes the session immediately would
        // otherwise finish serving before this entry existed, and the release below would find
        // nothing to release — leaving the very stale entry it is there to prevent.
        links[project] = link
        link.serving = Thread(
            {
                runCatching { client.serve() }
                // `serve` returns when the transport closes, and the daemon closes it deliberately
                // when it refuses a response. Until 2026-08-14 nothing noticed: the thread ended,
                // this entry stayed, and the plugin reported a workspace the daemon had forgotten —
                // READY, linked, and serving nothing, until the IDE restarted. Measured with a real
                // IDE after a refused rename (ADR-0033 states the invariant this broke).
                releaseDeadLink(project, link)
            },
            "idebp-adapter-serve",
        ).apply {
            isDaemon = true
            start()
        }
        // Indexing transitions are announced as they happen; this covers everything else. An IDE
        // that stops answering — a modal dialog is the common way — announces nothing on its own,
        // and readiness would otherwise describe the last good moment for ever.
        link.heartbeat = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(
            { runCatching { announceReadiness(project) } },
            PROBE_INTERVAL_MS,
            PROBE_INTERVAL_MS,
            TimeUnit.MILLISECONDS,
        )
        link.refresh = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(
            { runCatching { refreshWorkspaceFromDisk(project) } },
            REFRESH_INTERVAL_MS,
            REFRESH_INTERVAL_MS,
            TimeUnit.MILLISECONDS,
        )
        logger.info(
            "[IDE Bridge] linked ${project.name}; serving workspace ${workspace.workspaceId}",
        )
        warnIfNothingToSearch(project)
        refreshReadiness()
        announceReadiness(project)
        return Outcome.Linked(workspace.workspaceId)
    }

    /**
     * Releases [project]'s link. Safe from any thread, and safe to call for a project never linked.
     *
     * Called when a project closes, which is what stops a dead session from being mistaken for a
     * live one: the serving thread of a closing project dies on its disposed `Project`, and nothing
     * else here would have noticed.
     */
    /**
     * Releases a link whose session the daemon ended, if it is still the one on record.
     *
     * The identity check is what makes this safe to call from the serving thread: `unlink` may have
     * removed the entry already, or the project may have been linked again since, and neither of
     * those is this thread's session to close.
     */
    private fun releaseDeadLink(project: Project, dead: Link) {
        if (!links.remove(project, dead)) return
        dead.heartbeat?.cancel(false)
        dead.refresh?.cancel(false)
        dead.announcer.cancel()
        dead.diagnosticsAnnouncer.cancel()
        Disposer.dispose(dead.documentListeners)
        Disposer.dispose(dead.tracker)
        runCatching { dead.indexing.disconnect() }
        runCatching { dead.transport.close() }
        logger.warn(
            "[IDE Bridge] the daemon ended the session for ${project.name}; " +
                "workspace ${dead.workspaceId} is no longer served. Reconnecting.",
        )
        refreshReadiness()
        scheduleRelink(project, attempt = 1)
    }

    /**
     * Tries to link again after a session ended, with a widening delay.
     *
     * Until now the plugin noticed a dead session and stopped there, so a user whose daemon had been
     * restarted — or whose adapter the daemon had disconnected over one refused response — had a
     * dead bridge until they re-linked by hand, and nothing on screen said so unless they looked.
     *
     * Widening, capped, and bounded on purpose. The daemon closes a session when it *refuses*
     * something; retrying that instantly, for ever, would turn one bad response into a flood. After
     * the last attempt the plugin stays quiet and the tool window reports `DISCONNECTED`, which is
     * the honest end state: something is wrong that reconnecting will not fix.
     */
    private fun scheduleRelink(project: Project, attempt: Int) {
        val delay = relinkDelayMs(attempt)
        if (delay == null) {
            logger.warn(
                "[IDE Bridge] gave up reconnecting ${project.name} after $MAX_RELINK_ATTEMPTS " +
                    "attempts; link it again from the IDE Bridge tool window.",
            )
            return
        }
        AppExecutorUtil.getAppScheduledExecutorService().schedule(
            {
                // A project that closed, or that someone linked in the meantime, is not ours to
                // reconnect: `link` answers `AlreadyLinked` for the second and would fail for the
                // first, and either way retrying is wrong.
                if (project.isDisposed || links.containsKey(project)) return@schedule
                val outcome = runCatching { link(project) }.getOrNull()
                if (outcome is Outcome.Linked) {
                    logger.info("[IDE Bridge] reconnected ${project.name} on attempt $attempt")
                } else {
                    scheduleRelink(project, attempt + 1)
                }
            },
            delay,
            TimeUnit.MILLISECONDS,
        )
    }

    fun unlink(project: Project) {
        val link = links.remove(project) ?: return
        // Before the transport, so no readiness announcement races a closing socket.
        link.heartbeat?.cancel(false)
        link.refresh?.cancel(false)
        link.announcer.cancel()
        link.diagnosticsAnnouncer.cancel()
        Disposer.dispose(link.documentListeners)
        Disposer.dispose(link.tracker)
        runCatching { link.indexing.disconnect() }
        link.serving?.interrupt()
        runCatching { link.transport.close() }
        // Forgotten on unlink so a project that is fixed and linked again is warned again if it was
        // not fixed after all. The once-per-project guard is about not repeating on every search, not
        // about warning only once ever.
        IndexHealthNotifier.forget(project)
        logger.info("[IDE Bridge] unlinked ${project.name}")
        refreshReadiness()
    }

    /**
     * Warns, once the project settles, if the thing just linked cannot be searched.
     *
     * Linking is when a project becomes a promise to a consumer, so it is when this belongs: waiting
     * for a search meant the warning arrived only after something had already failed, which is how a
     * project was exposed and found unusable with nothing said in between (measured 2026-08-11).
     *
     * Deferred to smart mode rather than checked here, and that is the load-bearing part: a Gradle
     * project has no source root *yet* at open, and acquires one when its import finishes — measured
     * on 2026-08-10, where the same project answered nothing at open and seventeen hits the next day.
     * Checking immediately would have warned about a state that was about to fix itself, which is the
     * fastest way to teach someone to ignore a warning.
     */
    private fun warnIfNothingToSearch(project: Project) {
        DumbService.getInstance(project).runWhenSmart {
            if (!project.isDisposed && !IntelliJProjectSnapshot.hasSourceRoots(project)) {
                IndexHealthNotifier.warnNoSourceRoots(project)
            }
        }
    }

    /** Releases every link. For application shutdown. */
    fun disconnectAll() {
        for (project in links.keys.toList()) unlink(project)
        logger.info("[IDE Bridge] all links released")
    }

    fun isLinked(project: Project): Boolean = links.containsKey(project)

    fun workspaceIdOf(project: Project): String? = links[project]?.workspaceId

    /** Every linked project, so a caller can show what this IDE is currently serving. */
    fun linkedProjects(): List<Project> = links.keys.toList()

    /** Whether a daemon is discoverable at all, which is the difference the UI has to explain. */
    fun daemonAvailable(): Boolean = DiscoveryReader.read(discoveryPath()) is DiscoveryReader.Outcome.Ready

    /** Notifies [listener] whenever a link appears or disappears. */
    fun addChangeListener(listener: () -> Unit) {
        listeners.add(listener)
    }

    fun removeChangeListener(listener: () -> Unit) {
        listeners.remove(listener)
    }

    /**
     * Keeps the reported readiness equal to the facts.
     *
     * The old flag and this state could disagree — the state said `DISCONNECTED` while the service
     * believed it was connected — and a disagreement between the two is how the silent failure stayed
     * invisible.
     */
    /**
     * Tells the daemon what this workspace's readiness actually is, now.
     *
     * The notification has always been in the protocol and the daemon has always handled it; the
     * adapter never sent one, so every consumer of `workspace/getStatus` read a value fixed at
     * start-up. The state is computed here rather than remembered, because a remembered readiness
     * is wrong the moment indexing starts and nobody is told.
     *
     * Failures are logged and dropped: a workspace whose status could not be announced is still a
     * workspace that works, and every route already reports its own readiness when asked.
     */
    private fun announceReadiness(project: Project) {
        val link = links[project] ?: return
        link.watchdog.tick()
    }

    /** Sends one readiness state, whatever decided it. */
    private fun publishReadiness(project: Project, state: ReadinessModel.IndexState) {
        val link = links[project] ?: return
        runCatching {
            link.client.notify(
                "workspace/readinessChanged",
                WorkspaceReadinessChangedParams(ReadinessModel.status(link.workspaceId, state)),
                WorkspaceReadinessChangedParams.serializer(),
            )
            logger.info("[IDE Bridge] ${project.name} is ${state.name.lowercase()}")
        }.onFailure {
            logger.info("[IDE Bridge] could not announce readiness for ${project.name}: $it")
        }
    }

    /**
     * Subscribes to the editor events the protocol names, for one link.
     *
     * TASK.md §12 lists these, and this adapter sent none of them: a consumer tracking what the IDE
     * has open, or waiting to re-read diagnostics, heard nothing and had to poll. Each listener does
     * the least possible on the IDE's own threads — it takes a URI and hands off — because the work
     * behind these notifications needs a read action and the event thread is the user's.
     */
    private fun subscribeToEditorEvents(
        project: Project,
        where: Disposable,
        diagnostics: DocumentChangeAnnouncer,
    ) {
        val application = ApplicationManager.getApplication()

        project.messageBus.connect(where).subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun fileOpened(source: FileEditorManager, file: VirtualFile) {
                    later { announceDocumentEvent(project, "document/opened", file.url) }
                }

                override fun fileClosed(source: FileEditorManager, file: VirtualFile) {
                    later { announceDocumentEvent(project, "document/closed", file.url) }
                }
            },
        )

        application.messageBus.connect(where).subscribe(
            FileDocumentManagerListener.TOPIC,
            object : FileDocumentManagerListener {
                override fun beforeDocumentSaving(document: Document) {
                    val url = FileDocumentManager.getInstance().getFile(document)?.url ?: return
                    later { announceDocumentEvent(project, "document/saved", url) }
                }
            },
        )

        application.messageBus.connect(where).subscribe(
            VirtualFileManager.VFS_CHANGES,
            object : BulkFileListener {
                // `before`, not `after`: a deleted file still has a URL here, and the whole point of
                // the notification is to name the document that is going away.
                override fun before(events: List<VFileEvent>) {
                    for (event in events) {
                        if (event !is VFileDeleteEvent) continue
                        val url = event.file.url
                        later { announceDocumentDeleted(project, url) }
                    }
                }

                override fun after(events: List<VFileEvent>) {
                    for (event in events) {
                        val renamed = when {
                            event is VFilePropertyChangeEvent &&
                                event.propertyName == VirtualFile.PROP_NAME ->
                                event.file.parent?.url?.let { "$it/${event.oldValue}" }

                            event is VFileMoveEvent ->
                                "${event.oldParent.url}/${event.file.name}"

                            else -> null
                        } ?: continue
                        val now = event.file?.url ?: continue
                        later { announceDocumentRenamed(project, renamed, now) }
                    }
                }
            },
        )

        // The IDE has finished analysing something, which is the only honest moment to say its
        // diagnostics changed — and it finishes a file again on every pause in typing, so this is
        // coalesced exactly like the typing itself. Announcing per event would put one broadcast per
        // keystroke-pause on every consumer's connection.
        project.messageBus.connect(where).subscribe(
            DaemonCodeAnalyzer.DAEMON_EVENT_TOPIC,
            object : DaemonCodeAnalyzer.DaemonListener {
                override fun daemonFinished(fileEditors: Collection<FileEditor>) {
                    for (editor in fileEditors) {
                        diagnostics.noteChanged(editor.file?.url ?: continue)
                    }
                }
            },
        )
    }

    /** Runs work off the IDE's event thread, where a read action may block. */
    private fun later(work: () -> Unit) {
        AppExecutorUtil.getAppExecutorService().execute { runCatching { work() } }
    }

    /**
     * Asks the IDE to look at the file system, because nothing else will.
     *
     * IntelliJ refreshes its virtual file system when its frame regains focus. An IDE driven by an
     * agent may never be focused at all, and then an edit made on disk reaches it on no schedule
     * worth relying on: measured on 2026-08-14, `document/getRevision` still reported the old
     * content ninety seconds after a write, and forty-five in another run. Every route reads that
     * same stale view.
     *
     * Asynchronous and scoped to the workspace's own roots — this runs on a timer, and a synchronous
     * recursive refresh of a large project on a timer would be its own defect. The refresh itself is
     * incremental: the platform compares timestamps and only reports what moved.
     */
    private fun refreshWorkspaceFromDisk(project: Project) {
        val link = links[project] ?: return
        val roots = ReadAction.compute<List<VirtualFile>, RuntimeException> {
            IntelliJProjectSnapshot.capture(project).rootUris.mapNotNull {
                VirtualFileManager.getInstance().findFileByUrl(it)
            }
        }
        if (roots.isEmpty()) return
        runCatching { VfsUtil.markDirtyAndRefresh(true, true, false, *roots.toTypedArray()) }
            .onFailure { logger.info("[IDE Bridge] could not refresh ${link.workspaceId}: $it") }
    }

    /** One `document/opened`, `document/saved` or `document/closed`. */
    private fun announceDocumentEvent(project: Project, method: String, uri: String) {
        val link = links[project] ?: return
        val content = link.backend.documentRead(link.workspaceId, uri) ?: return
        notify(project, method, DocumentEventParams(content.document), DocumentEventParams.serializer())
    }

    private fun announceDocumentDeleted(project: Project, uri: String) {
        val link = links[project] ?: return
        // A deleted document has an identity but no content, so it carries no revision (ADR-0022) —
        // and its containment cannot be re-read from a file that is gone, so it is checked here.
        if (!link.backend.withinWorkspace(uri)) return
        notify(
            project,
            "document/deleted",
            DocumentDeletedParams(link.workspaceId, uri),
            DocumentDeletedParams.serializer(),
        )
    }

    private fun announceDocumentRenamed(project: Project, previousUri: String, uri: String) {
        val link = links[project] ?: return
        val content = link.backend.documentRead(link.workspaceId, uri) ?: return
        if (!link.backend.withinWorkspace(previousUri)) return
        notify(
            project,
            "document/renamed",
            DocumentRenamedParams(link.workspaceId, previousUri, content.document),
            DocumentRenamedParams.serializer(),
        )
    }

    private fun announceDiagnosticsChanged(project: Project, uri: String) {
        val link = links[project] ?: return
        val content = link.backend.documentRead(link.workspaceId, uri) ?: return
        notify(
            project,
            "diagnostics/changed",
            DiagnosticsChangedParams(link.workspaceId, uri, content.document.revision),
            DiagnosticsChangedParams.serializer(),
        )
    }

    /** Sends one notification, or logs why it could not be sent. */
    private fun <P> notify(
        project: Project,
        method: String,
        params: P,
        serializer: kotlinx.serialization.KSerializer<P>,
    ) {
        val link = links[project] ?: return
        runCatching { link.client.notify(method, params, serializer) }
            .onFailure { logger.info("[IDE Bridge] could not announce $method: $it") }
    }

    /**
     * Sends `document/changed` for one document the user edited.
     *
     * Off the event thread, after the debounce: reading the document's content needs a read action,
     * and a URI outside this workspace's roots is dropped rather than announced — the daemon closes
     * the session over a document it did not authorise.
     */
    private fun announceDocumentChange(project: Project, uri: String) {
        val link = links[project] ?: return
        runCatching {
            val content = link.backend.documentRead(link.workspaceId, uri) ?: return
            link.client.notify(
                "document/changed",
                DocumentEventParams(content.document),
                DocumentEventParams.serializer(),
            )
        }.onFailure {
            logger.info("[IDE Bridge] could not announce a document change: $it")
        }
    }

    /**
     * Whether the IDE can run a read action right now.
     *
     * The same question every route asks, deliberately: a probe measuring something else would
     * report health the routes do not have. An IDE waiting on a modal dialog fails this while
     * looking perfectly alive from outside.
     */
    private fun canServe(): Boolean {
        val probe = ReadAction.nonBlocking<Boolean> { true }
            .submit(AppExecutorUtil.getAppExecutorService())
        return try {
            probe.blockingGet(PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS) == true
        } catch (_: Exception) {
            // Cancelled, not merely abandoned. A blocked IDE fails this probe every five seconds for
            // as long as it stays blocked, and each abandoned promise would sit in the read queue
            // waiting for a lock that is not coming — a slow leak in exactly the situation the
            // watchdog exists to survive.
            probe.cancel(true)
            false
        }
    }

    private fun refreshReadiness() {
        ReadinessManager.getInstance().setState(
            if (links.isEmpty()) {
                ReadinessManager.ReadinessState.DISCONNECTED
            } else {
                ReadinessManager.ReadinessState.READY
            },
        )
        for (listener in listeners) runCatching { listener() }
    }

    private fun ideVersion(): String = runCatching {
        ApplicationInfo.getInstance().build.asString()
    }.getOrDefault("unknown")

    companion object {
        private const val PLUGIN_NAME = "ide-bridge-jetbrains"
        // Internal rather than private: a test asserts it equals the repository's VERSION file, and a
        // number the plugin announces to the daemon is exactly the kind that drifts unobserved.
        internal const val PLUGIN_VERSION = "0.2.1"

        /**
         * How long a read action may take before the IDE counts as not answering.
         *
         * Generous on purpose: a busy but working IDE takes milliseconds, and the failure this
         * detects lasts until someone clicks a dialog. Calling a slow moment "degraded" would trade
         * one wrong answer for another.
         */
        private const val PROBE_TIMEOUT_MS = 2_000

        /** Far below the daemon's 30 s route timeout, so a consumer learns before its call fails. */
        private const val PROBE_INTERVAL_MS = 5_000L

        /**
         * How long typing must pause before a document is announced.
         *
         * Longer than VS Code's 75 ms on purpose: TASK.md §12 does not ask for every text change,
         * the daemon broadcasts each notification to every consumer, and what matters is that a
         * plan is invalidated before anyone applies it — not that every keystroke is relayed.
         */
        private const val CHANGE_DEBOUNCE_MS = 400L

        /**
         * How often to ask the IDE to look at the file system.
         *
         * Slower than the readiness probe on purpose: this walks the workspace's roots, where the
         * probe only asks whether a read action can run. Fifteen seconds is well inside the patience
         * of an agent that has just written a file and is about to ask about it, and far cheaper
         * than the minute-plus an unfocused IDE would otherwise take to notice.
         */
        private const val REFRESH_INTERVAL_MS = 15_000L

        /** First reconnection delay; each attempt doubles it, up to the cap below. */
        private const val RELINK_BASE_DELAY_MS = 2_000L

        /** Long enough that a daemon being restarted by hand is still caught. */
        private const val RELINK_MAX_DELAY_MS = 30_000L

        /** ~2 minutes of trying in total, then silence and an honest DISCONNECTED. */
        private const val MAX_RELINK_ATTEMPTS = 6

        /**
         * How long to wait before reconnection attempt [attempt], or `null` to stop trying.
         *
         * Separated from the scheduling so the bounds can be proved without waiting out two minutes
         * of real delays — the schedule around it is what a live test exercises, and this is what
         * says when to give up.
         */
        @JvmStatic
        public fun relinkDelayMs(attempt: Int): Long? =
            if (attempt > MAX_RELINK_ATTEMPTS) {
                null
            } else {
                (RELINK_BASE_DELAY_MS shl (attempt - 1)).coerceAtMost(RELINK_MAX_DELAY_MS)
            }

        /**
         * The daemon's own default location, overridable by `IDE_BRIDGE_DISCOVERY_FILE`.
         *
         * A variable set to nothing means nothing was configured. `getenv` returns `""` for it, and
         * `Paths.get("")` is an empty *relative* path that resolves against whatever directory the
         * IDE was launched from — so the override would point somewhere arbitrary instead of being
         * ignored. The VS Code adapter made exactly this mistake in the other direction and spent
         * three days testing a daemon nobody had built (ADR-0037).
         */
        @JvmStatic
        @JvmOverloads
        fun defaultDiscoveryPath(
            environment: (String) -> String? = System::getenv,
            homeDirectory: String = System.getProperty("user.home"),
        ): Path =
            environment("IDE_BRIDGE_DISCOVERY_FILE")
                ?.takeIf { it.isNotBlank() }
                ?.let { Paths.get(it) }
                ?: Paths.get(homeDirectory, ".ide-bridge", "discovery.json")

        @JvmStatic
        fun getInstance(): BridgeDaemonConnectionService =
            ApplicationManager.getApplication().getService(BridgeDaemonConnectionService::class.java)
    }
}
