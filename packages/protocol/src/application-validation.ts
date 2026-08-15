import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import errorResponseSchema from "../schemas/error/error-response.schema.json" with { type: "json" };
import bridgeMethodSchema from "../schemas/method/bridge.schema.json" with { type: "json" };
import diagnosticsMethodSchema from "../schemas/method/diagnostics.schema.json" with { type: "json" };
import documentMethodSchema from "../schemas/method/document.schema.json" with { type: "json" };
import editMethodSchema from "../schemas/method/edit.schema.json" with { type: "json" };
import lifecycleMethodSchema from "../schemas/method/lifecycle.schema.json" with { type: "json" };
import symbolMethodSchema from "../schemas/method/symbol.schema.json" with { type: "json" };
import workspaceMethodSchema from "../schemas/method/workspace.schema.json" with { type: "json" };
import cancelRequestSchema from "../schemas/notification/cancel-request.schema.json" with { type: "json" };
import eventsSchema from "../schemas/notification/events.schema.json" with { type: "json" };
import type {
  AdapterCapabilitiesChangedNotification,
  AdapterDisconnectedNotification,
  BridgeGetStatusRequest,
  BridgeGetStatusResponse,
  BridgeListAdaptersRequest,
  BridgeListAdaptersResponse,
  BridgeListSessionsRequest,
  BridgeListSessionsResponse,
  CancelRequestNotification,
  DiagnosticsChangedNotification,
  DiagnosticsGetSnapshotRequest,
  DiagnosticsGetSnapshotResponse,
  DocumentChangedNotification,
  DocumentClosedNotification,
  DocumentDeletedNotification,
  DocumentGetRevisionRequest,
  DocumentGetRevisionResponse,
  DocumentGetSymbolsRequest,
  DocumentGetSymbolsResponse,
  DocumentOpenedNotification,
  DocumentReadRequest,
  DocumentReadResponse,
  DocumentRenamedNotification,
  DocumentSavedNotification,
  IDEBPJSONRPCErrorResponse,
  IdeGetCapabilitiesRequest,
  IdeGetCapabilitiesResponse,
  IdePingRequest,
  IdePingResponse,
  IdeRegisterRequest,
  IdeRegisterResponse,
  IdeUnregisterRequest,
  IdeUnregisterResponse,
  RefactorPrepareRequest,
  RefactorPrepareRenameRequest,
  RefactorPrepareResponse,
  RefactorPrepareRenameResponse,
  SymbolGetDefinitionRequest,
  SymbolGetDefinitionResponse,
  SymbolGetHierarchyRequest,
  SymbolGetImplementationsRequest,
  SymbolGetHierarchyResponse,
  SymbolGetImplementationsResponse,
  SymbolGetReferencesRequest,
  SymbolGetReferencesResponse,
  SymbolResolveAtRequest,
  SymbolResolveAtResponse,
  WorkspaceApplyPlanRequest,
  WorkspaceApplyPlanResponse,
  WorkspaceClosedNotification,
  WorkspaceDiscardPlanRequest,
  WorkspaceDiscardPlanResponse,
  WorkspaceGetRequest,
  WorkspaceGetResponse,
  WorkspaceGetStatusRequest,
  WorkspaceGetStatusResponse,
  WorkspaceListRequest,
  WorkspaceListResponse,
  WorkspaceOpenedNotification,
  WorkspaceReadinessChangedNotification,
  WorkspaceTrustChangedNotification,
  WorkspaceRootsChangedNotification,
  WorkspaceSearchSymbolsRequest,
  WorkspaceListBookmarksRequest,
  WorkspaceSearchTodosRequest,
  WorkspaceSearchSymbolsResponse,
  WorkspaceListBookmarksResponse,
  WorkspaceSearchTodosResponse,
  WorkspaceUndoRequest,
  WorkspaceUndoResponse,
} from "./generated.js";

import adapterSessionSchema from "../schemas/common/adapter-session.schema.json" with { type: "json" };
import capabilitySchema from "../schemas/common/capability.schema.json" with { type: "json" };
import diagnosticSchema from "../schemas/common/diagnostic.schema.json" with { type: "json" };
import documentSchema from "../schemas/common/document.schema.json" with { type: "json" };
import editPlanSchema from "../schemas/common/edit-plan.schema.json" with { type: "json" };
import identifiersSchema from "../schemas/common/identifiers.schema.json" with { type: "json" };
import jsonRpcIdSchema from "../schemas/common/json-rpc-id.schema.json" with { type: "json" };
import positionSchema from "../schemas/common/position.schema.json" with { type: "json" };
import protocolVersionSchema from "../schemas/common/protocol-version.schema.json" with { type: "json" };
import readinessSchema from "../schemas/common/readiness.schema.json" with { type: "json" };
import revisionSchema from "../schemas/common/revision.schema.json" with { type: "json" };
import sessionRoleSchema from "../schemas/common/session-role.schema.json" with { type: "json" };
import symbolSchema from "../schemas/common/symbol.schema.json" with { type: "json" };
import workspaceSchema from "../schemas/common/workspace.schema.json" with { type: "json" };

export interface IDEBPApplicationRequestByMethod {
  "bridge/getStatus": BridgeGetStatusRequest;
  "bridge/listAdapters": BridgeListAdaptersRequest;
  "bridge/listSessions": BridgeListSessionsRequest;
  "diagnostics/getSnapshot": DiagnosticsGetSnapshotRequest;
  "document/read": DocumentReadRequest;
  "document/getRevision": DocumentGetRevisionRequest;
  "document/getSymbols": DocumentGetSymbolsRequest;
  "refactor/prepare": RefactorPrepareRequest;
  "refactor/prepareRename": RefactorPrepareRenameRequest;
  "workspace/applyPlan": WorkspaceApplyPlanRequest;
  "workspace/discardPlan": WorkspaceDiscardPlanRequest;
  "workspace/undo": WorkspaceUndoRequest;
  "ide/register": IdeRegisterRequest;
  "ide/unregister": IdeUnregisterRequest;
  "ide/ping": IdePingRequest;
  "ide/getCapabilities": IdeGetCapabilitiesRequest;
  "workspace/searchSymbols": WorkspaceSearchSymbolsRequest;
  "workspace/searchTodos": WorkspaceSearchTodosRequest;
  "workspace/listBookmarks": WorkspaceListBookmarksRequest;
  "symbol/resolveAt": SymbolResolveAtRequest;
  "symbol/getDefinition": SymbolGetDefinitionRequest;
  "symbol/getReferences": SymbolGetReferencesRequest;
  "symbol/getImplementations": SymbolGetImplementationsRequest;
  "symbol/getHierarchy": SymbolGetHierarchyRequest;
  "workspace/list": WorkspaceListRequest;
  "workspace/get": WorkspaceGetRequest;
  "workspace/getStatus": WorkspaceGetStatusRequest;
}

export interface IDEBPApplicationResponseByMethod {
  "bridge/getStatus": BridgeGetStatusResponse;
  "bridge/listAdapters": BridgeListAdaptersResponse;
  "bridge/listSessions": BridgeListSessionsResponse;
  "diagnostics/getSnapshot": DiagnosticsGetSnapshotResponse;
  "document/read": DocumentReadResponse;
  "document/getRevision": DocumentGetRevisionResponse;
  "document/getSymbols": DocumentGetSymbolsResponse;
  "refactor/prepare": RefactorPrepareResponse;
  "refactor/prepareRename": RefactorPrepareRenameResponse;
  "workspace/applyPlan": WorkspaceApplyPlanResponse;
  "workspace/discardPlan": WorkspaceDiscardPlanResponse;
  "workspace/undo": WorkspaceUndoResponse;
  "ide/register": IdeRegisterResponse;
  "ide/unregister": IdeUnregisterResponse;
  "ide/ping": IdePingResponse;
  "ide/getCapabilities": IdeGetCapabilitiesResponse;
  "workspace/searchSymbols": WorkspaceSearchSymbolsResponse;
  "workspace/searchTodos": WorkspaceSearchTodosResponse;
  "workspace/listBookmarks": WorkspaceListBookmarksResponse;
  "symbol/resolveAt": SymbolResolveAtResponse;
  "symbol/getDefinition": SymbolGetDefinitionResponse;
  "symbol/getReferences": SymbolGetReferencesResponse;
  "symbol/getImplementations": SymbolGetImplementationsResponse;
  "symbol/getHierarchy": SymbolGetHierarchyResponse;
  "workspace/list": WorkspaceListResponse;
  "workspace/get": WorkspaceGetResponse;
  "workspace/getStatus": WorkspaceGetStatusResponse;
}

export interface IDEBPNotificationByMethod {
  "$/cancelRequest": CancelRequestNotification;
  "adapter/capabilitiesChanged": AdapterCapabilitiesChangedNotification;
  "adapter/disconnected": AdapterDisconnectedNotification;
  "workspace/opened": WorkspaceOpenedNotification;
  "workspace/closed": WorkspaceClosedNotification;
  "workspace/rootsChanged": WorkspaceRootsChangedNotification;
  "workspace/readinessChanged": WorkspaceReadinessChangedNotification;
  "workspace/trustChanged": WorkspaceTrustChangedNotification;
  "document/opened": DocumentOpenedNotification;
  "document/changed": DocumentChangedNotification;
  "document/saved": DocumentSavedNotification;
  "document/closed": DocumentClosedNotification;
  "document/deleted": DocumentDeletedNotification;
  "document/renamed": DocumentRenamedNotification;
  "diagnostics/changed": DiagnosticsChangedNotification;
}

export type IDEBPApplicationMethod = keyof IDEBPApplicationRequestByMethod;
export type IDEBPNotificationMethod = keyof IDEBPNotificationByMethod;
export type IDEBPRequestParams<M extends IDEBPApplicationMethod> =
  IDEBPApplicationRequestByMethod[M]["params"];
export type IDEBPResponseResult<M extends IDEBPApplicationMethod> =
  IDEBPApplicationResponseByMethod[M]["result"];
export type IDEBPNotificationParams<M extends IDEBPNotificationMethod> = NonNullable<
  IDEBPNotificationByMethod[M]["params"]
>;

interface ContractReferences {
  request: string;
  response: string;
}

const applicationContractReferences: Record<IDEBPApplicationMethod, ContractReferences> = {
  "bridge/getStatus": refs(bridgeMethodSchema.$id, "bridgeGetStatus"),
  "bridge/listAdapters": refs(bridgeMethodSchema.$id, "bridgeListAdapters"),
  "bridge/listSessions": refs(bridgeMethodSchema.$id, "bridgeListSessions"),
  "diagnostics/getSnapshot": refs(diagnosticsMethodSchema.$id, "diagnosticsGetSnapshot"),
  "document/read": refs(documentMethodSchema.$id, "documentRead"),
  "document/getRevision": refs(documentMethodSchema.$id, "documentGetRevision"),
  "document/getSymbols": refs(documentMethodSchema.$id, "documentGetSymbols"),
  "refactor/prepare": refs(editMethodSchema.$id, "refactorPrepare"),
  "refactor/prepareRename": refs(editMethodSchema.$id, "refactorPrepareRename"),
  "workspace/applyPlan": refs(editMethodSchema.$id, "workspaceApplyPlan"),
  "workspace/discardPlan": refs(editMethodSchema.$id, "workspaceDiscardPlan"),
  "workspace/undo": refs(editMethodSchema.$id, "workspaceUndo"),
  "ide/register": refs(lifecycleMethodSchema.$id, "ideRegister"),
  "ide/unregister": refs(lifecycleMethodSchema.$id, "ideUnregister"),
  "ide/ping": refs(lifecycleMethodSchema.$id, "idePing"),
  "ide/getCapabilities": refs(lifecycleMethodSchema.$id, "ideGetCapabilities"),
  "workspace/searchSymbols": refs(symbolMethodSchema.$id, "workspaceSearchSymbols"),
  "workspace/searchTodos": refs(workspaceMethodSchema.$id, "workspaceSearchTodos"),
  "workspace/listBookmarks": refs(workspaceMethodSchema.$id, "workspaceListBookmarks"),
  "symbol/resolveAt": refs(symbolMethodSchema.$id, "symbolResolveAt"),
  "symbol/getDefinition": refs(symbolMethodSchema.$id, "symbolGetDefinition"),
  "symbol/getReferences": refs(symbolMethodSchema.$id, "symbolGetReferences"),
  "symbol/getImplementations": refs(symbolMethodSchema.$id, "symbolGetImplementations"),
  "symbol/getHierarchy": refs(symbolMethodSchema.$id, "symbolGetHierarchy"),
  "workspace/list": refs(workspaceMethodSchema.$id, "workspaceList"),
  "workspace/get": refs(workspaceMethodSchema.$id, "workspaceGet"),
  "workspace/getStatus": refs(workspaceMethodSchema.$id, "workspaceGetStatus"),
};

const notificationContractReferences: Record<IDEBPNotificationMethod, string> = {
  "$/cancelRequest": cancelRequestSchema.$id,
  "adapter/capabilitiesChanged": eventRef("adapterCapabilitiesChanged"),
  "adapter/disconnected": eventRef("adapterDisconnected"),
  "workspace/opened": eventRef("workspaceOpened"),
  "workspace/closed": eventRef("workspaceClosed"),
  "workspace/rootsChanged": eventRef("workspaceRootsChanged"),
  "workspace/readinessChanged": eventRef("workspaceReadinessChanged"),
  "workspace/trustChanged": eventRef("workspaceTrustChanged"),
  "document/opened": eventRef("documentOpened"),
  "document/changed": eventRef("documentChanged"),
  "document/saved": eventRef("documentSaved"),
  "document/closed": eventRef("documentClosed"),
  "document/deleted": eventRef("documentDeleted"),
  "document/renamed": eventRef("documentRenamed"),
  "diagnostics/changed": eventRef("diagnosticsChanged"),
};

export const IDEBP_APPLICATION_METHODS = Object.freeze(
  Object.keys(applicationContractReferences) as IDEBPApplicationMethod[],
);
export const IDEBP_NOTIFICATION_METHODS = Object.freeze(
  Object.keys(notificationContractReferences) as IDEBPNotificationMethod[],
);

export const IDEBP_ADAPTER_ORIGINATED_METHODS = Object.freeze([
  "ide/register",
  "ide/unregister",
  "ide/ping",
] as const satisfies readonly IDEBPApplicationMethod[]);

export const IDEBP_CONSUMER_LOCAL_METHODS = Object.freeze([
  "bridge/getStatus",
  "bridge/listAdapters",
  "bridge/listSessions",
  "ide/getCapabilities",
  "workspace/list",
  "workspace/get",
  "workspace/getStatus",
] as const satisfies readonly IDEBPApplicationMethod[]);

export const IDEBP_ROUTED_METHODS = Object.freeze([
  "document/read",
  "document/getRevision",
  "document/getSymbols",
  "workspace/searchSymbols",
  "workspace/searchTodos",
  "workspace/listBookmarks",
  "symbol/resolveAt",
  "symbol/getDefinition",
  "symbol/getReferences",
  "symbol/getImplementations",
  "symbol/getHierarchy",
  "diagnostics/getSnapshot",
  "refactor/prepare",
  "refactor/prepareRename",
  "workspace/applyPlan",
  "workspace/discardPlan",
  "workspace/undo",
] as const satisfies readonly IDEBPApplicationMethod[]);

export type IDEBPRoutedMethod = (typeof IDEBP_ROUTED_METHODS)[number];

export const IDEBP_ADAPTER_OUTBOUND_NOTIFICATION_METHODS = Object.freeze([
  "adapter/capabilitiesChanged",
  "workspace/opened",
  "workspace/closed",
  "workspace/rootsChanged",
  "workspace/readinessChanged",
  "workspace/trustChanged",
  "document/opened",
  "document/changed",
  "document/saved",
  "document/closed",
  "document/deleted",
  "document/renamed",
  "diagnostics/changed",
] as const satisfies readonly IDEBPNotificationMethod[]);

export const IDEBP_CONSUMER_INBOUND_NOTIFICATION_METHODS = Object.freeze([
  ...IDEBP_ADAPTER_OUTBOUND_NOTIFICATION_METHODS,
  "adapter/disconnected",
] as const satisfies readonly IDEBPNotificationMethod[]);

function refs(schemaId: string, prefix: string): ContractReferences {
  return {
    request: `${schemaId}#/$defs/${prefix}Request`,
    response: `${schemaId}#/$defs/${prefix}Response`,
  };
}

function eventRef(definition: string): string {
  return `${eventsSchema.$id}#/$defs/${definition}`;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
for (const schema of [
  adapterSessionSchema,
  capabilitySchema,
  diagnosticSchema,
  documentSchema,
  editPlanSchema,
  identifiersSchema,
  jsonRpcIdSchema,
  positionSchema,
  protocolVersionSchema,
  readinessSchema,
  revisionSchema,
  sessionRoleSchema,
  symbolSchema,
  workspaceSchema,
  bridgeMethodSchema,
  diagnosticsMethodSchema,
  documentMethodSchema,
  editMethodSchema,
  lifecycleMethodSchema,
  symbolMethodSchema,
  workspaceMethodSchema,
  cancelRequestSchema,
  eventsSchema,
  errorResponseSchema,
]) {
  ajv.addSchema(schema);
}

function requireValidator(reference: string): ValidateFunction {
  const validator = ajv.getSchema(reference);
  if (validator === undefined) throw new Error(`Canonical validator is missing for ${reference}`);
  return validator;
}

const requestValidators = Object.fromEntries(
  IDEBP_APPLICATION_METHODS.map((method) => [
    method,
    requireValidator(applicationContractReferences[method].request),
  ]),
) as Record<IDEBPApplicationMethod, ValidateFunction>;
const responseValidators = Object.fromEntries(
  IDEBP_APPLICATION_METHODS.map((method) => [
    method,
    requireValidator(applicationContractReferences[method].response),
  ]),
) as Record<IDEBPApplicationMethod, ValidateFunction>;
const notificationValidators = Object.fromEntries(
  IDEBP_NOTIFICATION_METHODS.map((method) => [
    method,
    requireValidator(notificationContractReferences[method]),
  ]),
) as Record<IDEBPNotificationMethod, ValidateFunction>;
const validateErrorResponse = requireValidator(errorResponseSchema.$id);

export function isIDEBPApplicationMethod(value: string): value is IDEBPApplicationMethod {
  return Object.hasOwn(applicationContractReferences, value);
}

export function isIDEBPNotificationMethod(value: string): value is IDEBPNotificationMethod {
  return Object.hasOwn(notificationContractReferences, value);
}

export function isIDEBPApplicationRequest<M extends IDEBPApplicationMethod>(
  method: M,
  value: unknown,
): value is IDEBPApplicationRequestByMethod[M] {
  return requestValidators[method](value);
}

export function isIDEBPApplicationResponse<M extends IDEBPApplicationMethod>(
  method: M,
  value: unknown,
): value is IDEBPApplicationResponseByMethod[M] {
  return responseValidators[method](value);
}

/**
 * Why a response failed its schema, in one short phrase.
 *
 * The boolean check above says a payload was refused without saying which rule refused it, which is
 * the failure mode this project has now paid for twice — once on `workspace/undo`, and again on a
 * diagnostics snapshot carrying quick-fix offers. AJV already knows the answer; it was simply being
 * discarded. Only the first error and only its location and keyword travel: an AJV message can
 * quote the offending value, and a response often contains document text.
 */
export function describeApplicationResponseFailure(
  method: IDEBPApplicationMethod,
  value: unknown,
): string | undefined {
  const validator = responseValidators[method];
  if (validator(value)) return undefined;
  const first = validator.errors?.[0];
  if (first === undefined) return "failed its response schema";
  const where = first.instancePath === "" ? "the response" : first.instancePath;
  return `${where} violates ${first.keyword}`;
}

export function isIDEBPJSONRPCErrorResponse(value: unknown): value is IDEBPJSONRPCErrorResponse {
  return validateErrorResponse(value);
}

export type IDEBPNotificationValidation =
  | {
      kind: "valid";
      method: IDEBPNotificationMethod;
      notification: IDEBPNotificationByMethod[IDEBPNotificationMethod];
    }
  | { kind: "unknown" }
  | { kind: "invalid" };

export function classifyIDEBPNotification(value: unknown): IDEBPNotificationValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid" };
  }
  const method = Reflect.get(value, "method") as unknown;
  if (typeof method !== "string") return { kind: "invalid" };
  if (!isIDEBPNotificationMethod(method)) return { kind: "unknown" };
  if (!notificationValidators[method](value)) return { kind: "invalid" };
  return {
    kind: "valid",
    method,
    notification: value as IDEBPNotificationByMethod[IDEBPNotificationMethod],
  };
}
