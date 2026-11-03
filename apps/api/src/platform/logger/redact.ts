export const REDACTED = '[REDACTED]';

/**
 * Keys whose values are PII or credentials (000-overview §5.3). Matched case-insensitively at any
 * depth: email, whatsapp/phone, *_name / name, ip / *_ip, *token*, authorization, cookie, secrets.
 */
const SENSITIVE_KEY =
  /^(e-?mail|.*_email|whatsapp|.*whatsapp.*|phone|.*_phone|name|.*_name|first_?name|last_?name|ip|.*_ip|ip_address|remote_?ip|.*token.*|authorization|proxy-authorization|cookie|set-cookie|password|.*secret.*|.*api_?key.*|user_agent|user-agent)$/i;

const MAX_DEPTH = 8;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Returns a deep copy with sensitive keys replaced. Errors are kept as {name, message, stack}. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (value instanceof Error) {
    return { type: value.name, message: value.message, stack: value.stack };
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? REDACTED : redactDeep(child, depth + 1);
    }
    return output;
  }
  return value;
}
