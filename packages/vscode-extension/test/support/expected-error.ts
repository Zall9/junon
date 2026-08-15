import type { BridgeAdapterRequestError } from "@ide-bridge/bridge-client";

/**
 * `toMatchObject` compares nested objects partially, so an expected value is a
 * recursive partial — not a `Partial<…>` of the top level only. Protocol error
 * variants such as `StaleDocumentErrorData` require `details.currentRevision`,
 * which assertions deliberately leave unspecified.
 */
type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Expected shape for a rejected adapter request passed to `toMatchObject`. */
export type ExpectedAdapterError = DeepPartial<BridgeAdapterRequestError>;
