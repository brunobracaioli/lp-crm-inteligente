import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { firewallFileSchema, monitorsFileSchema } from '#scripts/vercel-ops-schema.ts';

const OPS_DIR = new URL('../../ops/vercel/', import.meta.url);
const SRC_DIR = new URL('../../src/', import.meta.url).pathname;

function load(file: string): unknown {
  return JSON.parse(readFileSync(new URL(file, OPS_DIR), 'utf8')) as unknown;
}

/** Every `metrics.record('<name>'` in production sources. */
function emittedMetricNames(dir: string): Set<string> {
  const names = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const source = readFileSync(join(entry.parentPath, entry.name), 'utf8');
    for (const match of source.matchAll(/record\('([A-Za-z0-9_.\-/]+)'/g)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return names;
}

describe('ops/vercel/firewall-rules.json', () => {
  const file = firewallFileSchema.parse(load('firewall-rules.json'));

  it('has unique managed rule names', () => {
    const names = file.rules.map((rule) => rule.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('never limits /v1/leads harder at the edge than the app does (5 per 10 min per IP)', () => {
    const leadsRate = file.rules.find((rule) => rule.name === 'lp-leads-ip-rate');
    const mitigate = leadsRate?.action.mitigate;
    expect(mitigate?.action).toBe('rate_limit');
    if (mitigate?.action === 'rate_limit') {
      const perTenMinutes = (mitigate.rateLimit.limit * 600) / mitigate.rateLimit.window;
      expect(perTenMinutes).toBeGreaterThan(5);
    }
  });

  it('keeps POST and the CORS preflight open on /v1/leads', () => {
    const methods = file.rules.find((rule) => rule.name === 'lp-leads-methods');
    const values = methods?.conditionGroup.flatMap((group) =>
      group.conditions.filter((c) => c.type === 'method').map((c) => `${c.op}:${c.value ?? ''}`),
    );
    expect(values).toEqual(['neq:POST', 'neq:OPTIONS']);
  });
});

describe('ops/vercel/monitors.json', () => {
  const file = monitorsFileSchema.parse(load('monitors.json'));
  const emitted = emittedMetricNames(SRC_DIR);

  it('has unique managed monitor names', () => {
    const names = file.monitors.map((monitor) => monitor.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('only watches custom metrics the code actually emits', () => {
    const custom = file.monitors
      .flatMap((monitor) => Object.values(monitor.evaluation.query.metrics))
      .map((query) => query.metric)
      .filter((metric) => !metric.startsWith('vercel.'));
    expect(custom.length).toBeGreaterThan(0);
    for (const metric of custom) {
      expect(emitted, `metric ${metric} is not emitted by src/`).toContain(metric);
    }
  });

  it('covers every alert of Onda 6b', () => {
    expect(file.monitors.map((monitor) => monitor.name).sort()).toEqual([
      'lp-antibot-failures',
      'lp-api-5xx',
      'lp-deliveries-dead',
      'lp-outbox-dead',
      'lp-outbox-lag',
    ]);
  });
});
