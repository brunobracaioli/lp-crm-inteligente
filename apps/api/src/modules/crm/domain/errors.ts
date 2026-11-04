/**
 * Business-rule violations of the crm domain. Returned inside `Result`, never thrown: the caller
 * (use case or, in Wave 9, the HTTP layer) maps the stable `code` to its own response.
 */
export const DOMAIN_ERROR_CODES = [
  'invalid_stage_transition',
  'lost_reason_required',
  'lost_reason_not_allowed',
  'invalid_lost_reason',
  'reopen_not_allowed',
  'lead_anonymized',
  'email_mismatch',
  'invalid_email',
  'invalid_whatsapp',
  'invalid_person_name',
  'invalid_company_profile',
] as const;
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainError {
  readonly code: DomainErrorCode;
  /** Technical hint for logs; never contains PII (field names and limits only). */
  readonly detail?: string;
}

export function domainError(code: DomainErrorCode, detail?: string): DomainError {
  return detail === undefined ? { code } : { code, detail };
}
