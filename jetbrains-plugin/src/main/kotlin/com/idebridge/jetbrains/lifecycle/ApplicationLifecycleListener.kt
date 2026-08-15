package com.idebridge.jetbrains.lifecycle

import com.idebridge.jetbrains.service.BridgeDaemonConnectionService
import com.intellij.ide.AppLifecycleListener
import com.intellij.openapi.diagnostic.logger

/**
 * Disconnects cleanly when the application closes.
 *
 * Only the shutdown half remains here. Startup moved to [BridgeStartupActivity] because
 * `appStarted` is `@ApiStatus.Internal`; `appClosing` is public API and has no equivalent
 * elsewhere, so it stays.
 */
class ApplicationLifecycleListener : AppLifecycleListener {

    private val logger = logger<ApplicationLifecycleListener>()

    override fun appClosing() {
        logger.info("[IDE Bridge] Application closing — disconnecting from daemon")
        BridgeDaemonConnectionService.getInstance().disconnectAll()
    }
}
