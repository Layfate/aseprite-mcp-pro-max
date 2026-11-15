export type ErrorCode =
  | "ASEPRITE_NOT_FOUND"
  | "ASEPRITE_FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "PATH_OUTSIDE_WORKSPACE"
  | "FILE_NOT_FOUND"
  | "FILE_EXISTS"
  | "CONFLICT"
  | "STALE_VERSION"
  | "INVALID_INPUT"
  | "UNKNOWN_OPERATION"
  | "SCRIPT_ERROR"
  | "NO_CHECKPOINT"
  | "DISABLED"
  | "LIMIT"
  | "PROVIDER_FAILED"
  | "NOT_FOUND";

/** An error whose message is safe and useful to show to the model/user. */
export class McpToolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}
