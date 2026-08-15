/**
 * Workspace URI containment.
 *
 * Adapters and the daemon must agree byte-for-byte on what "inside a workspace root" means:
 * an adapter that returns a URI its own check accepts but the daemon rejects is treated as a
 * policy violation and loses its session. The rule therefore lives in the protocol package,
 * which has no IDE or daemon dependencies.
 */

function normalizedUriSegments(pathname: string): string[] | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\u0000") || decoded.includes("\\")) return undefined;
  const segments: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments;
}

/**
 * Checks URI containment without converting either URI to a local filesystem path.
 * Percent-encoded separators and dot segments are normalized for authorization only;
 * the original URI remains the value forwarded on the wire.
 */
export function isUriWithinWorkspaceRoot(documentUri: string, rootUri: string): boolean {
  try {
    const document = new URL(documentUri);
    const root = new URL(rootUri);
    if (
      document.protocol !== root.protocol ||
      document.username !== root.username ||
      document.password !== root.password ||
      document.host !== root.host ||
      document.search !== root.search ||
      document.hash !== root.hash
    ) {
      return false;
    }
    const documentSegments = normalizedUriSegments(document.pathname);
    const rootSegments = normalizedUriSegments(root.pathname);
    if (documentSegments === undefined || rootSegments === undefined) return false;
    return rootSegments.every((segment, index) => documentSegments[index] === segment);
  } catch {
    return false;
  }
}
