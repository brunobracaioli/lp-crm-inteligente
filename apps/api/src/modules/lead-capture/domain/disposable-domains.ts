/**
 * Seed list of disposable e-mail providers (open question Q3: block disposable, accept webmail).
 * A deliberately small, hand-reviewed list; extend it through a PR (a maintained feed would be a
 * new dependency and its own ADR). A domain matches itself and every subdomain of it.
 */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  '10minutemail.com',
  '10minutemail.net',
  '20minutemail.com',
  'dispostable.com',
  'emailondeck.com',
  'fakeinbox.com',
  'getairmail.com',
  'getnada.com',
  'guerrillamail.biz',
  'guerrillamail.com',
  'guerrillamail.de',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'maildrop.cc',
  'mailinator.com',
  'mailnesia.com',
  'mintemail.com',
  'mohmal.com',
  'sharklasers.com',
  'spam4.me',
  'spamgourmet.com',
  'temp-mail.org',
  'tempail.com',
  'tempmail.com',
  'tempmailo.com',
  'throwawaymail.com',
  'trashmail.com',
  'trashmail.net',
  'yopmail.com',
  'yopmail.fr',
]);

/** True when `domain` (lowercase) is a listed disposable domain or a subdomain of one. */
export function isDisposableEmailDomain(domain: string): boolean {
  const labels = domain.split('.');
  for (let start = 0; start < labels.length - 1; start += 1) {
    if (DISPOSABLE_EMAIL_DOMAINS.has(labels.slice(start).join('.'))) {
      return true;
    }
  }
  return false;
}
