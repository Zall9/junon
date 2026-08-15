import { randomBytes } from "node:crypto";

import type {
  AdapterId,
  EditPlan,
  Revision,
  SessionId,
  UndoToken,
  WorkspaceId,
} from "@ide-bridge/protocol";

import { isUriWithinWorkspaceRoot } from "../security/workspace-uri.js";

export type EditStoreErrorCode =
  "PLAN_EXPIRED" | "PLAN_NOT_FOUND" | "PRECONDITION_FAILED" | "PROVIDER_FAILED" | "STALE_DOCUMENT";

/**
 * Why a plan was dropped, with what the protocol requires to say so.
 *
 * `STALE_DOCUMENT` is not a bare code in IDEBP: its data carries the revision the document now has,
 * which is the part a consumer can act on. Carrying the reason without it would mean either lying
 * about the shape or falling back to a vaguer code, so the two travel together.
 */
export interface StalePlanReason {
  readonly code: "STALE_DOCUMENT";
  readonly workspaceId: WorkspaceId;
  readonly uri: string;
  readonly currentRevision: Revision;
}

export class EditStoreError extends Error {
  override readonly name = "EditStoreError";
  readonly code: EditStoreErrorCode;
  /** Present only for the codes whose protocol data requires more than a name. */
  readonly stale?: StalePlanReason;

  /**
   * The condition that failed, when one can be named.
   *
   * A code alone says an adapter's response was refused without saying why, which leaves its author
   * nothing to act on — and cost this project five wrong hypotheses on a single defect. It never
   * carries document content: a refusal usually concerns a document, and its text must not travel
   * in an error.
   */
  readonly reason: string | undefined;

  constructor(code: EditStoreErrorCode, reason?: string, stale?: StalePlanReason) {
    super(reason === undefined ? "Edit store operation failed" : `Edit store: ${reason}`);
    this.code = code;
    this.reason = reason;
    if (stale !== undefined) this.stale = stale;
  }
}

export interface StoredPlan {
  publicPlan: EditPlan;
  adapterPlan: EditPlan;
  consumerSessionId: SessionId;
  adapterSessionId: SessionId;
  workspaceEpoch: number;
}

export interface StoredUndoToken {
  publicToken: UndoToken;
  adapterToken: UndoToken;
  consumerSessionId: SessionId;
  adapterSessionId: SessionId;
}

export interface PlanCreationContext {
  consumerSessionId: SessionId;
  adapterSessionId: SessionId;
  adapterId: AdapterId;
  workspaceId: WorkspaceId;
  workspaceEpoch: number;
  workspaceRootUris: readonly string[];
}

export interface UndoCreationContext {
  consumerSessionId: SessionId;
  adapterSessionId: SessionId;
  adapterId: AdapterId;
  workspaceId: WorkspaceId;
}

export interface InMemoryEditStoreOptions {
  now?: () => Date;
  maximumPlanLifetimeMs?: number;
  maximumEntries?: number;
  maximumEntriesPerConsumer?: number;
  sweepIntervalMs?: number;
  createPlanId?: () => string;
  createUndoTokenId?: () => string;
}

const DEFAULT_MAXIMUM_PLAN_LIFETIME_MS = 5 * 60_000;
const DEFAULT_MAXIMUM_ENTRIES = 1_024;
const DEFAULT_MAXIMUM_ENTRIES_PER_CONSUMER = 128;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

function internalPlanKey(sessionId: SessionId, planId: string): string {
  return `${sessionId}\u0000${planId}`;
}

function internalUndoTokenKey(sessionId: SessionId, tokenId: string): string {
  return `${sessionId}\u0000${tokenId}`;
}

function undoTokensEqual(left: UndoToken, right: UndoToken): boolean {
  return (
    left.id === right.id &&
    left.adapterId === right.adapterId &&
    left.sessionId === right.sessionId &&
    left.workspaceId === right.workspaceId &&
    left.expiresAt === right.expiresAt
  );
}

/**
 * How many invalidated plan ids keep their reason.
 *
 * Large enough to cover a consumer that prepared several plans and applies them after an edit,
 * small enough that this cannot grow into a leak — the map holds two short strings per entry and is
 * consulted only when a plan is already missing.
 */
const MAX_REMEMBERED_INVALIDATIONS = 256;

export class InMemoryEditStore {
  readonly #plans = new Map<string, StoredPlan>();
  readonly #internalPlans = new Set<string>();
  /** Plan id → why it was invalidated, for the request that arrives after it was dropped. */
  readonly #invalidationReasons = new Map<string, StalePlanReason>();
  readonly #undoTokens = new Map<string, StoredUndoToken>();
  readonly #internalUndoTokens = new Set<string>();
  readonly #now: () => Date;
  readonly #maximumPlanLifetimeMs: number;
  readonly #maximumEntries: number;
  readonly #maximumEntriesPerConsumer: number;
  readonly #createPlanId: () => string;
  readonly #createUndoTokenId: () => string;
  readonly #sweepTimer: ReturnType<typeof setInterval>;

  constructor(options: InMemoryEditStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#maximumPlanLifetimeMs = options.maximumPlanLifetimeMs ?? DEFAULT_MAXIMUM_PLAN_LIFETIME_MS;
    this.#maximumEntries = options.maximumEntries ?? DEFAULT_MAXIMUM_ENTRIES;
    this.#maximumEntriesPerConsumer =
      options.maximumEntriesPerConsumer ?? DEFAULT_MAXIMUM_ENTRIES_PER_CONSUMER;
    this.#createPlanId =
      options.createPlanId ?? (() => `plan_${randomBytes(18).toString("base64url")}`);
    this.#createUndoTokenId =
      options.createUndoTokenId ?? (() => `undo_${randomBytes(18).toString("base64url")}`);
    const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    for (const value of [
      this.#maximumPlanLifetimeMs,
      this.#maximumEntries,
      this.#maximumEntriesPerConsumer,
      sweepIntervalMs,
    ]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Edit store limits are invalid");
    }
    if (this.#maximumEntriesPerConsumer > this.#maximumEntries) {
      throw new Error("Per-consumer edit store limit exceeds the global limit");
    }
    this.#sweepTimer = setInterval(() => {
      this.sweep();
    }, sweepIntervalMs);
    this.#sweepTimer.unref();
  }

  get planCount(): number {
    return this.#plans.size;
  }

  get undoTokenCount(): number {
    return this.#undoTokens.size;
  }

  createPlan(adapterPlan: EditPlan, context: PlanCreationContext): EditPlan {
    this.sweep();
    this.#assertCapacity(context.consumerSessionId);
    // Each of these refusals closes the adapter's session, and the close reason is the only channel
    // that reaches its author. Until 2026-08-14 all seven threw a bare `PROVIDER_FAILED`, so the
    // reason read `…rejected during prepare transformation: PROVIDER_FAILED` — the name of the
    // outcome, never the rule. Measured against a real IDE: a rename disconnected the plugin and
    // nothing anywhere said which of six conditions had refused it. The compound checks are split
    // for the same reason; an author told "one of three things" still has to guess.
    if (adapterPlan.adapterId !== context.adapterId) {
      throw new EditStoreError("PROVIDER_FAILED", "plan names another adapter");
    }
    if (adapterPlan.sessionId !== context.adapterSessionId) {
      throw new EditStoreError("PROVIDER_FAILED", "plan names another session");
    }
    if (adapterPlan.workspaceId !== context.workspaceId) {
      throw new EditStoreError("PROVIDER_FAILED", "plan names another workspace");
    }
    const adapterExpiration = Date.parse(adapterPlan.expiresAt);
    const now = this.#now().getTime();
    if (!Number.isFinite(adapterExpiration)) {
      throw new EditStoreError("PROVIDER_FAILED", "plan has no readable expiry");
    }
    if (adapterExpiration <= now) {
      throw new EditStoreError("PROVIDER_FAILED", "plan arrived already expired");
    }
    const preconditions = new Map<string, EditPlan["preconditions"][number]>();
    for (const precondition of adapterPlan.preconditions) {
      if (preconditions.has(precondition.uri)) {
        throw new EditStoreError("PROVIDER_FAILED", "two preconditions name one document");
      }
      if (precondition.workspaceEpoch !== context.workspaceEpoch) {
        throw new EditStoreError("PROVIDER_FAILED", "precondition names another workspace epoch");
      }
      if (
        !context.workspaceRootUris.some((rootUri) =>
          isUriWithinWorkspaceRoot(precondition.uri, rootUri),
        )
      ) {
        throw new EditStoreError("PROVIDER_FAILED", "precondition is outside every workspace root");
      }
      preconditions.set(precondition.uri, precondition);
    }
    const changeUris = new Set<string>();
    for (const change of adapterPlan.changes) {
      if (changeUris.has(change.uri)) {
        throw new EditStoreError("PROVIDER_FAILED", "two changes name one document");
      }
      if (!preconditions.has(change.uri)) {
        throw new EditStoreError("PROVIDER_FAILED", "change has no precondition on its document");
      }
      if (
        !context.workspaceRootUris.some((rootUri) => isUriWithinWorkspaceRoot(change.uri, rootUri))
      ) {
        throw new EditStoreError("PROVIDER_FAILED", "change is outside every workspace root");
      }
      changeUris.add(change.uri);
    }
    const internalKey = internalPlanKey(context.adapterSessionId, adapterPlan.planId);
    if (this.#internalPlans.has(internalKey)) {
      throw new EditStoreError("PROVIDER_FAILED", "plan id repeats a live plan of this session");
    }

    const planId = this.#uniqueId("plan", this.#createPlanId, this.#plans);
    const expiresAt = new Date(
      Math.min(adapterExpiration, now + this.#maximumPlanLifetimeMs),
    ).toISOString();
    const publicPlan: EditPlan = {
      ...structuredClone(adapterPlan),
      planId,
      sessionId: context.consumerSessionId,
      expiresAt,
    };
    const stored: StoredPlan = {
      publicPlan,
      adapterPlan: structuredClone(adapterPlan),
      consumerSessionId: context.consumerSessionId,
      adapterSessionId: context.adapterSessionId,
      workspaceEpoch: context.workspaceEpoch,
    };
    this.#plans.set(planId, stored);
    this.#internalPlans.add(internalKey);
    return structuredClone(publicPlan);
  }

  consumePlan(
    planId: string,
    consumerSessionId: SessionId,
    workspaceId: WorkspaceId,
    workspaceEpoch: number,
  ): StoredPlan {
    const stored = this.#plans.get(planId);
    if (
      stored === undefined ||
      stored.consumerSessionId !== consumerSessionId ||
      stored.publicPlan.workspaceId !== workspaceId
    ) {
      // A plan invalidated moments ago by an edit to its own document is not an unknown id, and
      // saying so is the difference between "your change invalidated this, prepare it again" and
      // "that identifier means nothing here".
      const stale = this.#takeReason(planId);
      if (stale !== undefined) {
        throw new EditStoreError(
          stale.code,
          "the document changed after the plan was prepared",
          stale,
        );
      }
      throw new EditStoreError("PLAN_NOT_FOUND");
    }
    if (
      Date.parse(stored.publicPlan.expiresAt) <= this.#now().getTime() ||
      stored.workspaceEpoch !== workspaceEpoch
    ) {
      this.#deletePlan(stored);
      throw new EditStoreError("PLAN_EXPIRED");
    }
    this.#deletePlan(stored, false);
    return structuredClone(stored);
  }

  discardPlan(planId: string, consumerSessionId: SessionId, workspaceId: WorkspaceId): StoredPlan {
    const stored = this.#plans.get(planId);
    if (
      stored === undefined ||
      stored.consumerSessionId !== consumerSessionId ||
      stored.publicPlan.workspaceId !== workspaceId
    ) {
      throw new EditStoreError("PLAN_NOT_FOUND");
    }
    if (Date.parse(stored.publicPlan.expiresAt) <= this.#now().getTime()) {
      this.#deletePlan(stored);
      throw new EditStoreError("PLAN_EXPIRED");
    }
    this.#deletePlan(stored, false);
    return structuredClone(stored);
  }

  releasePlan(stored: StoredPlan): void {
    this.#internalPlans.delete(internalPlanKey(stored.adapterSessionId, stored.adapterPlan.planId));
  }

  createUndoToken(adapterToken: UndoToken, context: UndoCreationContext): UndoToken {
    this.sweep();
    this.#assertCapacity(context.consumerSessionId);
    const now = this.#now().getTime();
    const adapterExpiration =
      adapterToken.expiresAt === undefined ? undefined : Date.parse(adapterToken.expiresAt);
    if (adapterToken.adapterId !== context.adapterId) {
      throw new EditStoreError("PROVIDER_FAILED", "undo token names another adapter");
    }
    if (adapterToken.sessionId !== context.adapterSessionId) {
      throw new EditStoreError("PROVIDER_FAILED", "undo token names another session");
    }
    if (adapterToken.workspaceId !== context.workspaceId) {
      throw new EditStoreError("PROVIDER_FAILED", "undo token names another workspace");
    }
    if (adapterExpiration !== undefined && !Number.isFinite(adapterExpiration)) {
      throw new EditStoreError("PROVIDER_FAILED", "undo token has no readable expiry");
    }
    if (adapterExpiration !== undefined && adapterExpiration <= now) {
      throw new EditStoreError("PROVIDER_FAILED", "undo token arrived already expired");
    }
    const internalKey = internalUndoTokenKey(context.adapterSessionId, adapterToken.id);
    if (this.#internalUndoTokens.has(internalKey)) {
      throw new EditStoreError(
        "PROVIDER_FAILED",
        "undo token id repeats a live token of this session",
      );
    }
    const id = this.#uniqueId("undo", this.#createUndoTokenId, this.#undoTokens);
    const publicToken: UndoToken = {
      ...structuredClone(adapterToken),
      id,
      sessionId: context.consumerSessionId,
      expiresAt: new Date(
        Math.min(adapterExpiration ?? Number.POSITIVE_INFINITY, now + this.#maximumPlanLifetimeMs),
      ).toISOString(),
    };
    this.#undoTokens.set(id, {
      publicToken,
      adapterToken: structuredClone(adapterToken),
      consumerSessionId: context.consumerSessionId,
      adapterSessionId: context.adapterSessionId,
    });
    this.#internalUndoTokens.add(internalKey);
    return structuredClone(publicToken);
  }

  consumeUndoToken(
    token: UndoToken,
    consumerSessionId: SessionId,
    workspaceId: WorkspaceId,
  ): StoredUndoToken {
    const stored = this.#undoTokens.get(token.id);
    if (
      stored === undefined ||
      stored.consumerSessionId !== consumerSessionId ||
      stored.publicToken.workspaceId !== workspaceId ||
      !undoTokensEqual(stored.publicToken, token)
    ) {
      throw new EditStoreError("PLAN_NOT_FOUND");
    }
    this.#undoTokens.delete(token.id);
    if (
      stored.publicToken.expiresAt !== undefined &&
      Date.parse(stored.publicToken.expiresAt) <= this.#now().getTime()
    ) {
      this.releaseUndoToken(stored);
      throw new EditStoreError("PLAN_EXPIRED");
    }
    return structuredClone(stored);
  }

  releaseUndoToken(stored: StoredUndoToken): void {
    this.#internalUndoTokens.delete(
      internalUndoTokenKey(stored.adapterSessionId, stored.adapterToken.id),
    );
  }

  /**
   * Drops the plans that depended on a document, and remembers why.
   *
   * `currentRevision` is what makes the refusal useful rather than merely accurate: the protocol's
   * `STALE_DOCUMENT` carries the revision the document now has, so a consumer can re-read and
   * prepare again instead of guessing. Without it the only honest answer is `PLAN_NOT_FOUND`, which
   * is what a deleted document gets — there is no current revision to report for a file that is
   * gone.
   *
   * Measured in the VS Code end-to-end run: a plan prepared and then invalidated by the consumer's
   * own edit came back indistinguishable from a mistyped identifier.
   */
  invalidateDocument(workspaceId: WorkspaceId, uri: string, currentRevision?: Revision): number {
    return this.#invalidatePlans(
      (stored) =>
        stored.publicPlan.workspaceId === workspaceId &&
        stored.publicPlan.preconditions.some((precondition) => precondition.uri === uri),
      currentRevision === undefined
        ? undefined
        : { code: "STALE_DOCUMENT", workspaceId, uri, currentRevision },
    );
  }

  invalidateWorkspace(workspaceId: WorkspaceId): number {
    const invalidatedPlans = this.#invalidatePlans(
      (stored) => stored.publicPlan.workspaceId === workspaceId,
    );
    for (const [id, stored] of this.#undoTokens) {
      if (stored.publicToken.workspaceId === workspaceId) this.#deleteUndoToken(id, stored);
    }
    return invalidatedPlans;
  }

  invalidateSession(sessionId: SessionId): void {
    this.#invalidatePlans(
      (stored) => stored.consumerSessionId === sessionId || stored.adapterSessionId === sessionId,
    );
    for (const [id, stored] of this.#undoTokens) {
      if (stored.consumerSessionId === sessionId || stored.adapterSessionId === sessionId) {
        this.#deleteUndoToken(id, stored);
      }
    }
  }

  sweep(): void {
    const now = this.#now().getTime();
    this.#invalidatePlans((stored) => Date.parse(stored.publicPlan.expiresAt) <= now);
    for (const [id, stored] of this.#undoTokens) {
      if (
        stored.publicToken.expiresAt !== undefined &&
        Date.parse(stored.publicToken.expiresAt) <= now
      ) {
        this.#deleteUndoToken(id, stored);
      }
    }
  }

  close(): void {
    clearInterval(this.#sweepTimer);
    this.#plans.clear();
    this.#internalPlans.clear();
    this.#undoTokens.clear();
    this.#internalUndoTokens.clear();
  }

  #assertCapacity(consumerSessionId: SessionId): void {
    const total = this.#plans.size + this.#undoTokens.size;
    const owned =
      [...this.#plans.values()].filter((stored) => stored.consumerSessionId === consumerSessionId)
        .length +
      [...this.#undoTokens.values()].filter(
        (stored) => stored.consumerSessionId === consumerSessionId,
      ).length;
    if (total >= this.#maximumEntries || owned >= this.#maximumEntriesPerConsumer) {
      throw new EditStoreError("PRECONDITION_FAILED");
    }
  }

  #uniqueId<T>(prefix: string, factory: () => string, map: Map<string, T>): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = factory();
      if (
        new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`, "u").test(id) &&
        id.length <= 128 &&
        !map.has(id)
      ) {
        return id;
      }
    }
    throw new Error("Edit store ID factory could not create a unique valid ID");
  }

  #deletePlan(stored: StoredPlan, releaseInternalPlan = true): void {
    this.#plans.delete(stored.publicPlan.planId);
    if (releaseInternalPlan) this.releasePlan(stored);
  }

  #deleteUndoToken(id: string, stored: StoredUndoToken): void {
    this.#undoTokens.delete(id);
    this.releaseUndoToken(stored);
  }

  #invalidatePlans(predicate: (stored: StoredPlan) => boolean, reason?: StalePlanReason): number {
    let count = 0;
    for (const stored of [...this.#plans.values()]) {
      if (!predicate(stored)) continue;
      this.#deletePlan(stored);
      if (reason !== undefined) this.#rememberReason(stored.publicPlan.planId, reason);
      count += 1;
    }
    return count;
  }

  /**
   * Why a plan that no longer exists went away.
   *
   * Bounded on purpose: this is a courtesy for the request that arrives moments later, not a log. A
   * consumer that waits long enough for the ring to turn over gets `PLAN_NOT_FOUND`, which by then
   * is the honest answer — nothing here knows what happened to a plan from an hour ago.
   */
  #rememberReason(planId: string, reason: StalePlanReason): void {
    this.#invalidationReasons.set(planId, reason);
    while (this.#invalidationReasons.size > MAX_REMEMBERED_INVALIDATIONS) {
      const oldest = this.#invalidationReasons.keys().next();
      if (oldest.done === true) break;
      this.#invalidationReasons.delete(oldest.value);
    }
  }

  /** The recorded reason for a missing plan, consumed so it is reported once. */
  #takeReason(planId: string): StalePlanReason | undefined {
    const reason = this.#invalidationReasons.get(planId);
    if (reason !== undefined) this.#invalidationReasons.delete(planId);
    return reason;
  }
}
