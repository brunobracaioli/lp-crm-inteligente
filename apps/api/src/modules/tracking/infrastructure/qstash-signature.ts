import { createHash, timingSafeEqual } from 'node:crypto';
import { errors, jwtVerify } from 'jose';
import type {
  SignatureVerificationRequest,
  SignatureVerifier,
} from '#/modules/tracking/application/ports.ts';
import type { Logger } from '#/platform/logger/logger.ts';
import type { Metrics } from '#/platform/metrics/metrics.ts';
import type { Clock } from '#/shared/time.ts';

/**
 * Verifier for the `Upstash-Signature` header of messages QStash delivers to
 * `/internal/v1/outbox/*` (tracking §6, ADR-0004). The header is an HS256 JWT signed with the
 * current or the next signing key (rotation) whose claims are:
 *   iss = "Upstash", sub = the exact destination URL, exp / nbf, body = base64url(SHA-256(raw body)).
 *
 * Nothing about the network, the IP or a shared header is trusted: only a valid signature over this
 * URL and this exact body authenticates the call. Any failure yields `false` (the route answers a
 * generic 401) plus a `warn` log and an `auth.qstash_signature_invalid` metric carrying a
 * low-cardinality reason, never the token.
 */

const ISSUER = 'Upstash';
const ALGORITHM = 'HS256';
const REQUIRED_CLAIMS = ['iss', 'sub', 'exp', 'nbf', 'body'];
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5;
/** A QStash JWT is a few hundred bytes; anything larger is rejected before any crypto work. */
const MAX_SIGNATURE_LENGTH = 4096;
const BASE64_PADDING = /=+$/u;

export type SignatureRejectionReason =
  | 'missing_signature'
  | 'malformed'
  | 'bad_signature'
  | 'bad_algorithm'
  | 'expired'
  | 'not_yet_valid'
  | 'bad_issuer'
  | 'url_mismatch'
  | 'missing_claim'
  | 'body_mismatch';

export interface QstashSignatureVerifierConfig {
  readonly currentSigningKey: string;
  readonly nextSigningKey: string;
  /** Allowed clock skew in seconds for `exp` / `nbf`. */
  readonly clockToleranceSeconds?: number | undefined;
}

export interface QstashSignatureVerifierDeps {
  readonly clock: Pick<Clock, 'now'>;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

function reasonFor(error: unknown): SignatureRejectionReason {
  if (error instanceof errors.JWTExpired) return 'expired';
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.reason === 'missing') return 'missing_claim';
    switch (error.claim) {
      case 'nbf':
        return 'not_yet_valid';
      case 'iss':
        return 'bad_issuer';
      case 'sub':
        return 'url_mismatch';
      default:
        return 'missing_claim';
    }
  }
  if (error instanceof errors.JOSEAlgNotAllowed) return 'bad_algorithm';
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'bad_signature';
  return 'malformed';
}

function bodyHashMatches(claim: unknown, rawBody: string): boolean {
  if (typeof claim !== 'string') return false;
  const expected = Buffer.from(createHash('sha256').update(rawBody, 'utf8').digest('base64url'));
  // QStash's own SDK tolerates trailing '=' padding in the claim; so do we.
  const received = Buffer.from(claim.replace(BASE64_PADDING, ''));
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export class QstashSignatureVerifier implements SignatureVerifier {
  private readonly keys: readonly Uint8Array[];
  private readonly clockToleranceSeconds: number;
  private readonly deps: QstashSignatureVerifierDeps;

  constructor(config: QstashSignatureVerifierConfig, deps: QstashSignatureVerifierDeps) {
    if (config.currentSigningKey === '' || config.nextSigningKey === '') {
      throw new Error('Invalid QStash signature verifier config: signing keys must not be empty');
    }
    const encoder = new TextEncoder();
    // Order matters: the current key is the common case, the next key covers rotation.
    this.keys = [encoder.encode(config.currentSigningKey), encoder.encode(config.nextSigningKey)];
    this.clockToleranceSeconds = config.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
    this.deps = deps;
  }

  async verify(request: SignatureVerificationRequest): Promise<boolean> {
    const rejection = await this.check(request);
    if (rejection === null) return true;
    this.deps.metrics.record('auth.qstash_signature_invalid', 1, { reason: rejection });
    this.deps.logger.warn({ reason: rejection }, 'qstash signature rejected');
    return false;
  }

  private async check(
    request: SignatureVerificationRequest,
  ): Promise<SignatureRejectionReason | null> {
    const { signature } = request;
    if (signature === null || signature === '') return 'missing_signature';
    if (signature.length > MAX_SIGNATURE_LENGTH) return 'malformed';

    let rejection: SignatureRejectionReason = 'bad_signature';
    for (const key of this.keys) {
      try {
        // jose authenticates the token before validating claims, so a claim error below means the
        // signature was genuine and trying the other key would not change the verdict.
        const { payload } = await jwtVerify(signature, key, {
          algorithms: [ALGORITHM],
          issuer: ISSUER,
          subject: request.url,
          requiredClaims: REQUIRED_CLAIMS,
          clockTolerance: this.clockToleranceSeconds,
          currentDate: this.deps.clock.now(),
        });
        return bodyHashMatches(payload.body, request.rawBody) ? null : 'body_mismatch';
      } catch (error) {
        rejection = reasonFor(error);
        if (rejection !== 'bad_signature') return rejection;
      }
    }
    return rejection;
  }
}
