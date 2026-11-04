import { HttpProblem } from '#/platform/errors/problem.ts';
import type { SubmitLeadFailure } from '#/modules/lead-capture/application/submit-lead.ts';

/** `Retry-After` when Turnstile is unreachable (lead-capture §3: 503 + Retry-After). */
export const BOT_VERIFICATION_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * Maps every business refusal of `SubmitLead` to its client-facing problem (lead-capture §3).
 * The `switch` is exhaustive: adding a failure code without mapping it breaks the type check.
 * `bot_verification_failed.reason` is deliberately dropped: it must never reach the client.
 */
export function failureToProblem(failure: SubmitLeadFailure): HttpProblem {
  switch (failure.code) {
    case 'rate_limited':
      return new HttpProblem(429, 'rate_limited', { retryAfterSeconds: failure.retryAfterSeconds });
    case 'validation_failed':
      return new HttpProblem(400, 'validation_failed', { errors: failure.errors });
    case 'form_not_found':
      return new HttpProblem(404, 'form_not_found');
    case 'origin_not_allowed':
      return new HttpProblem(403, 'origin_not_allowed');
    case 'bot_verification_failed':
      return new HttpProblem(403, 'bot_verification_failed');
    case 'bot_verification_unavailable':
      return new HttpProblem(503, 'bot_verification_unavailable', {
        retryAfterSeconds: BOT_VERIFICATION_UNAVAILABLE_RETRY_AFTER_SECONDS,
      });
    case 'idempotency_in_progress':
      return new HttpProblem(409, 'idempotency_in_progress', {
        retryAfterSeconds: failure.retryAfterSeconds,
      });
    case 'idempotency_key_reused':
      return new HttpProblem(422, 'idempotency_key_reused');
  }
}
