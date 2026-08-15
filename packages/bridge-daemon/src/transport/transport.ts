import type { IDEBPNotificationParams } from "@ide-bridge/protocol";

import type { AuthenticatedSession } from "../session/handshake-processor.js";

export type SessionCloseReason = IDEBPNotificationParams<"adapter/disconnected">["reason"];

export interface AuthenticatedTransportConnection {
  readonly session: AuthenticatedSession;
  send(message: unknown): Promise<void>;
  close(code?: number, reason?: string): void;
}

export interface ServerTransport {
  readonly endpoint: string | undefined;
  start(): Promise<string>;
  close(): Promise<void>;
}
