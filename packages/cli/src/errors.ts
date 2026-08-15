export type CliOperationalErrorCode =
  | "already-running"
  | "daemon-unavailable"
  | "discovery-unavailable"
  | "internal-error"
  | "ownership-invalid"
  | "platform-unsupported"
  | "protocol-incompatible";

export class CliOperationalError extends Error {
  override readonly name = "CliOperationalError";
  readonly code: CliOperationalErrorCode;

  constructor(code: CliOperationalErrorCode) {
    super("IDE Bridge command failed");
    this.code = code;
  }
}
