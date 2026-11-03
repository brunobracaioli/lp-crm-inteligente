import { registerOTel } from '@vercel/otel';

/** OpenTelemetry via @vercel/otel (traces exported by the Vercel runtime). Call once at boot. */
export function registerTelemetry(): void {
  registerOTel({ serviceName: 'lp-crm-api' });
}
