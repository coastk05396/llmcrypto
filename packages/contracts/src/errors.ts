import { z } from "zod";

/** Single source of truth for console error codes and their HTTP status. */
export const ERROR_CODES = {
  BAD_REQUEST: { status: 400, description: "Malformed input" },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, description: "Idempotency-Key header missing on an operation that requires it" },
  UNAUTHENTICATED: { status: 401, description: "Missing or invalid session or credential" },
  CHALLENGE_INVALID: { status: 401, description: "Wallet challenge unknown, expired, consumed or signature rejected" },
  FORBIDDEN: { status: 403, description: "Authenticated but operation not permitted" },
  STEP_UP_REQUIRED: { status: 403, description: "Recent sign-in required for this privileged operation" },
  NOT_FOUND: { status: 404, description: "Resource does not exist or is not accessible to the caller" },
  FEATURE_DISABLED: { status: 404, description: "This beta feature is switched off in this deployment; off means unavailable, not complete" },
  IDEMPOTENCY_CONFLICT: { status: 409, description: "Idempotency-Key reused with a different payload" },
  IN_PROGRESS: { status: 409, description: "An identical request with this Idempotency-Key is still running" },
  IDENTITY_CONFLICT: { status: 409, description: "Identity is already linked to another account; accounts are never merged automatically" },
  LAST_AUTH_METHOD: { status: 409, description: "Removing this identity would leave the user with no sign-in method" },
  VERSION_CONFLICT: { status: 409, description: "expectedVersion does not match the current version" },
  INSUFFICIENT_FUNDS: { status: 409, description: "Available balance or budget cannot cover the operation" },
  PAYLOAD_TOO_LARGE: { status: 413, description: "Request body exceeds the documented size limit" },
  VALIDATION_FAILED: { status: 422, description: "Well-formed input failed semantic validation; see fieldErrors" },
  RATE_LIMITED: { status: 429, description: "Limit exceeded; honour the Retry-After header" },
  INTERNAL: { status: 500, description: "Unexpected server failure" },
  UPSTREAM_ERROR: { status: 502, description: "Dependency returned an invalid or failed response" },
  UNAVAILABLE: { status: 503, description: "Dependency or service temporarily unavailable" },
  UPSTREAM_TIMEOUT: { status: 504, description: "Dependency timed out" },
} as const satisfies Record<string, { status: number; description: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;
export const errorCodeValues = Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]];
export const ErrorCodeSchema = z.enum(errorCodeValues);

export const FieldError = z.object({ field: z.string().min(1), message: z.string().min(1) });
export type FieldError = z.infer<typeof FieldError>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1),
    fieldErrors: z.array(FieldError).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_CODES[code].status;
}
