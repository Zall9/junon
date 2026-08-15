/**
 * Workspace URI containment is defined by the protocol package so that the daemon and every
 * adapter apply exactly the same rule. Re-exported here to keep the daemon's security surface
 * addressable from one module.
 */
export { isUriWithinWorkspaceRoot } from "@ide-bridge/protocol";
