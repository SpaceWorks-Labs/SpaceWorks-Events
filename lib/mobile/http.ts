import { NextResponse } from "next/server";
import type { ZodError, ZodType } from "zod";
import { readBoundedBody } from "./boundedBody";

/*
 * Response envelope for /api/mobile/v1 (the Space Works apps, Android and iOS).
 * Success: { ok: true, data }. Failure: { ok: false, error: { code, message,
 * fieldErrors? } }. Every response is `no-store`.
 */

export type MobileErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHENTICATED"
  | "MFA_REQUIRED"
  | "EMAIL_VERIFICATION_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "NEEDS_FORCE"
  | "RATE_LIMITED"
  | "TEAM_REQUIRED"
  | "TEAM_MEMBER"
  | "TEAM_INCOMPLETE"
  | "CAPACITY_FULL"
  | "JUDGING_CLOSED"
  | "INCOMPLETE_SCORES"
  | "NOT_VISIBLE"
  | "INTERNAL_ERROR"
  | "STAFF_MFA_REQUIRED"
  | "STAFF_MFA_ENROLMENT_REQUIRED"
  | "EMAIL_CODE_REQUIRED"
  | "TOO_MANY_ATTEMPTS"
  | "REAUTH_REQUIRED"
  | "PAID_ORDER"
  | "REGISTRATION_CLOSED"
  | "ADMISSION_MANAGED"
  | "PAYMENT_UNAVAILABLE"
  | "PAYLOAD_TOO_LARGE"
  | "IDEMPOTENCY_STALE"
  | "OPEN_CLAIMS";

export const MOBILE_ERROR_STATUS: Record<MobileErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 401,
  EMAIL_VERIFICATION_REQUIRED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  NEEDS_FORCE: 409,
  RATE_LIMITED: 429,
  TEAM_REQUIRED: 409,
  TEAM_MEMBER: 409,
  TEAM_INCOMPLETE: 409,
  CAPACITY_FULL: 409,
  JUDGING_CLOSED: 409,
  INCOMPLETE_SCORES: 409,
  NOT_VISIBLE: 404,
  INTERNAL_ERROR: 500,
  STAFF_MFA_REQUIRED: 403,
  STAFF_MFA_ENROLMENT_REQUIRED: 403,
  EMAIL_CODE_REQUIRED: 401,
  TOO_MANY_ATTEMPTS: 429,
  REAUTH_REQUIRED: 401,
  PAID_ORDER: 409,
  REGISTRATION_CLOSED: 409,
  ADMISSION_MANAGED: 409,
  PAYMENT_UNAVAILABLE: 503,
  PAYLOAD_TOO_LARGE: 413,
  IDEMPOTENCY_STALE: 409,
  OPEN_CLAIMS: 409,
};

const DEFAULT_MESSAGES: Record<MobileErrorCode, string> = {
  INVALID_REQUEST: "The request is invalid.",
  UNAUTHENTICATED: "Sign in again to continue.",
  MFA_REQUIRED: "Enter the code from your authenticator app.",
  EMAIL_VERIFICATION_REQUIRED: "Verify your email address before signing in.",
  FORBIDDEN: "You do not have permission to do that.",
  NOT_FOUND: "Not found.",
  CONFLICT: "That change could not be made.",
  NEEDS_FORCE: "This guest needs a staff override to check in.",
  RATE_LIMITED: "Too many requests. Try again shortly.",
  TEAM_REQUIRED: "This event registers teams only. Register on the event website to create or join a team.",
  TEAM_MEMBER: "This registration belongs to a team. Approve, reject or promote the whole team.",
  TEAM_INCOMPLETE: "This team is below the minimum team size, so it can't be approved yet.",
  CAPACITY_FULL: "The event is at capacity.",
  JUDGING_CLOSED: "Judging is not open.",
  INCOMPLETE_SCORES: "Score every criterion before submitting your review.",
  NOT_VISIBLE: "This submission is not available to you.",
  INTERNAL_ERROR: "That didn't work. Please try again.",
  STAFF_MFA_REQUIRED: "Confirm the code from your authenticator app to use organiser tools.",
  STAFF_MFA_ENROLMENT_REQUIRED: "Set up an authenticator app on the website to use organiser tools.",
  EMAIL_CODE_REQUIRED: "We emailed you a sign-in code. Enter it to continue.",
  TOO_MANY_ATTEMPTS: "Too many attempts. Try again later.",
  REAUTH_REQUIRED: "Sign in again to do that.",
  PAID_ORDER: "This ticket was paid for. Cancel it from its order, under the refund policy.",
  REGISTRATION_CLOSED: "Registration is closed.",
  ADMISSION_MANAGED: "This is an application: decide it from the Applications tab.",
  PAYMENT_UNAVAILABLE: "Payments can't be taken right now. Try again in a moment.",
  PAYLOAD_TOO_LARGE: "Request is too large.",
  IDEMPOTENCY_STALE: "An earlier try of this change never finished. Refresh to check whether it happened, then try again if it did not.",
  OPEN_CLAIMS: "This ticket has expense claims in progress, so it can't be transferred.",
};

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function mobileOk<T>(data: T, status = 200) {
  return NextResponse.json({ ok: true, data }, { status, headers: NO_STORE });
}

export function mobileError(
  code: MobileErrorCode,
  message?: string,
  options: { fieldErrors?: Record<string, string[]>; retryAfter?: number } = {},
) {
  const headers: Record<string, string> = { ...NO_STORE };
  if (code === "UNAUTHENTICATED") headers["WWW-Authenticate"] = 'Bearer realm="Space Works mobile"';
  if (code === "RATE_LIMITED" || code === "TOO_MANY_ATTEMPTS") headers["Retry-After"] = String(options.retryAfter ?? 60);
  return NextResponse.json(
    {
      ok: false,
      error: {
        code,
        message: message ?? DEFAULT_MESSAGES[code],
        ...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
      },
    },
    { status: MOBILE_ERROR_STATUS[code], headers },
  );
}

export const unauthenticated = () => mobileError("UNAUTHENTICATED");
export const notFound = () => mobileError("NOT_FOUND");

/** Core refusal codes passed through unchanged (ActionErrorCode, JudgingRefusalCode). */
const PASS_THROUGH_CODES = ["TEAM_REQUIRED", "TEAM_MEMBER", "TEAM_INCOMPLETE", "CAPACITY_FULL", "JUDGING_CLOSED", "INCOMPLETE_SCORES", "NOT_VISIBLE", "PAID_ORDER", "REGISTRATION_CLOSED", "ADMISSION_MANAGED", "OPEN_CLAIMS"] as const;
type PassThroughCode = (typeof PASS_THROUGH_CODES)[number];

type FailedActionResult = { ok: false; error: string; fieldErrors?: Record<string, string[]>; needsForce?: boolean; reauthRequired?: boolean; code?: string };

/**
 * Map a Server Action failure (UI-safe message) to a mobile error code. The
 * message is passed through unchanged; only the classification is added.
 */
export function classifyActionError(result: FailedActionResult): MobileErrorCode {
  const message = result.error;
  if (result.needsForce) return "NEEDS_FORCE";
  if (result.reauthRequired) return "REAUTH_REQUIRED";
  if (result.code && (PASS_THROUGH_CODES as readonly string[]).includes(result.code)) return result.code as PassThroughCode;
  if (/^You must be signed in/i.test(message)) return "UNAUTHENTICATED";
  if (/^Too many/i.test(message)) return "RATE_LIMITED";
  if (result.fieldErrors) return "INVALID_REQUEST";
  // Another organisation's event or a guest you can't see looks like nothing at all.
  if (/^You don't have access|^You do not have access/i.test(message)) return "NOT_FOUND";
  if (/not found\.?$|no longer exists|is not for this event|No matching ticket|^Invalid registration/i.test(message)) return "NOT_FOUND";
  if (/permission|^Only owners and admins|can only cancel your own|^Verify your own email/i.test(message)) return "FORBIDDEN";
  if (/^Unknown criterion|go up to \d+\.$/i.test(message)) return "INVALID_REQUEST";
  if (/^Invalid|^Check the|^Missing|^Choose|is required|^Enter |^Could not read|^The message is empty/i.test(message)) return "INVALID_REQUEST";
  if (/^Could not (queue|save|restore|update)|could not be completed/i.test(message)) return "INTERNAL_ERROR";
  return "CONFLICT";
}

export function mobileActionError(result: FailedActionResult) {
  const code = classifyActionError(result);
  return mobileError(code, result.error, result.fieldErrors ? { fieldErrors: result.fieldErrors } : {});
}

export function zodFieldErrors(error: ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "_root";
    (out[path] ??= []).push(issue.message);
  }
  return out;
}

export const MAX_BODY_BYTES = 256 * 1024;

/** Read a bounded JSON body (streamed with a hard cap). Returns `{ value }` or a ready error response. */
export async function readJsonBody(request: Request, maxBytes = MAX_BODY_BYTES): Promise<{ value: unknown } | { response: Response }> {
  const bytes = await readBoundedBody(request, maxBytes);
  if (bytes === "too_large") return { response: mobileError("PAYLOAD_TOO_LARGE") };
  if (bytes === "unreadable") return { response: mobileError("INVALID_REQUEST", "Invalid request body.") };
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return { value: {} };
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { response: mobileError("INVALID_REQUEST", "Invalid JSON.") };
  }
}

/** A multipart form, streamed with a hard cap before it is parsed (receipt uploads). */
export async function readFormBody(request: Request, maxBytes: number): Promise<{ form: FormData } | { response: Response }> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;/i.test(type)) return { response: mobileError("INVALID_REQUEST", "Send a multipart form.") };
  const bytes = await readBoundedBody(request, maxBytes);
  if (bytes === "too_large") return { response: mobileError("PAYLOAD_TOO_LARGE") };
  if (bytes === "unreadable") return { response: mobileError("INVALID_REQUEST", "Invalid request body.") };
  const form = await new Response(Buffer.from(bytes), { headers: { "content-type": type } }).formData().catch(() => null);
  return form ? { form } : { response: mobileError("INVALID_REQUEST", "Send a multipart form.") };
}

/** Parse a JSON body against a schema, producing an INVALID_REQUEST with field errors on failure. */
export async function parseJsonBody<T>(request: Request, schema: ZodType<T>): Promise<{ data: T } | { response: Response }> {
  const body = await readJsonBody(request);
  if ("response" in body) return body;
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) return { response: mobileError("INVALID_REQUEST", undefined, { fieldErrors: zodFieldErrors(parsed.error) }) };
  return { data: parsed.data };
}

export function parseQuery<T>(request: Request, schema: ZodType<T>): { data: T } | { response: Response } {
  const raw = Object.fromEntries(new URL(request.url).searchParams.entries());
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { response: mobileError("INVALID_REQUEST", undefined, { fieldErrors: zodFieldErrors(parsed.error) }) };
  return { data: parsed.data };
}
