// loggable-endpoint.ts is a byte copy of telemetry-otel's, so this package need not depend on it: keep the two identical.
import { loggableReason } from "./loggable-endpoint.js";

/** What a failed export may hand to the logger: not the error itself, whose request config holds the endpoint and the headers. */
export interface ILoggableExportError {
  name: string;
  message: string;
  code?: string;
  status?: number;
}

export function loggableExportError(error: unknown, endpoint: string): ILoggableExportError {
  const result: ILoggableExportError = {
    name: error instanceof Error ? error.name : "Error",
    // A string reason is redacted without the `Name: ` prefix, which is a field of its own here.
    message: loggableReason(error instanceof Error ? error.message : String(error), endpoint),
  };
  if (typeof error !== "object" || error === null) return result;
  if ("code" in error && typeof error.code === "string") result.code = error.code;
  const response = "response" in error ? error.response : undefined;
  if (typeof response === "object" && response !== null && "status" in response && typeof response.status === "number") result.status = response.status;
  return result;
}
