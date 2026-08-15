import type { ExtensionLogLevel } from "./configuration.js";
import type { DocumentEventDropReason, DroppableNotificationMethod } from "./event-bridge.js";

export type LifecycleLogEvent =
  | "activation-failed"
  | "adapter-connected"
  | "adapter-reconnecting"
  | "adapter-stopped"
  | "daemon-autostarted"
  | "registration-restored"
  | DroppedNotificationLogEvent;

/**
 * A notification the extension decided not to send, named by what it was and why it stopped.
 *
 * Both halves are closed vocabularies — a protocol method and one of five reasons — so the event
 * name is still a constant string from a fixed set, and the log carries no URI, no path and no file
 * content. That is the whole point of this catalogue, and the reason a drop could not simply be
 * logged with the URI that caused it.
 */
export type DroppedNotificationLogEvent =
  `dropped ${DroppableNotificationMethod} (${DocumentEventDropReason})`;

export interface LogChannelLike {
  debug(message: string): void;
  error(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface SafeLifecycleLogger {
  debug(event: LifecycleLogEvent): void;
  error(event: LifecycleLogEvent): void;
  info(event: LifecycleLogEvent): void;
  warn(event: LifecycleLogEvent): void;
}

const PRIORITY: Record<ExtensionLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export function createSafeLifecycleLogger(
  channel: LogChannelLike,
  minimumLevel: ExtensionLogLevel,
): SafeLifecycleLogger {
  const write = (level: ExtensionLogLevel, event: LifecycleLogEvent): void => {
    if (PRIORITY[level] > PRIORITY[minimumLevel]) return;
    channel[level](`[lifecycle] ${event}`);
  };
  return {
    debug: (event) => {
      write("debug", event);
    },
    error: (event) => {
      write("error", event);
    },
    info: (event) => {
      write("info", event);
    },
    warn: (event) => {
      write("warn", event);
    },
  };
}
