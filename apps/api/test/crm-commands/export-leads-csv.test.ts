import { describe, expect, it } from 'vitest';
import type { StaffActor } from '#/modules/crm/application/commands/ports.ts';
import {
  EXPORT_COLUMNS,
  EXPORT_MAX_ROWS,
  type ExportLeadsCsvCommand,
} from '#/modules/crm/application/commands/export-leads-csv.ts';
import { DependencyUnavailableError } from '#/platform/errors/dependency-unavailable.ts';
import {
  ADMIN_USER,
  CORRELATION,
  SALES_USER,
  WORKSPACE_A,
  WORKSPACE_B,
  createCommandHarness,
  toExportRow,
  aStoredLead,
} from '#test/fakes/crm-commands.ts';

const adminActor: StaffActor = { userId: ADMIN_USER, workspaceId: WORKSPACE_A, role: 'admin' };
const query = (entries: Record<string, string[]> = {}): ExportLeadsCsvCommand['query'] =>
  new Map(Object.entries(entries));

const run = (h: ReturnType<typeof createCommandHarness>, q = query(), actor = adminActor) =>
  h.exportLeadsCsv({ actor, query: q, correlationId: CORRELATION });

/** Minimal RFC 4180 reader, used to prove the encoder round-trips. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] ?? '';
    if (quoted) {
      if (char === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else {
      cell += char;
    }
  }
  return rows;
}

describe('exportLeadsCsv', () => {
  it("neutralizes formulas: =1+1 is exported as '=1+1 (AC-CRM-07)", async () => {
    // arrange
    const h = createCommandHarness();
    h.seed(WORKSPACE_A, { firstName: '=1+1', jobTitle: '@SUM(A1)', companyName: '+cmd|calc' });
    // act
    const result = await run(h);
    // assert
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [header, row] = parseCsv(result.value.csv);
    expect(header).toEqual([...EXPORT_COLUMNS]);
    expect(row?.[header?.indexOf('first_name') ?? -1]).toBe("'=1+1");
    expect(row?.[header?.indexOf('job_title') ?? -1]).toBe("'@SUM(A1)");
    expect(row?.[header?.indexOf('company_name') ?? -1]).toBe("'+cmd|calc");
    // the WhatsApp number starts with "+" and is neutralized too (documented side effect)
    expect(row?.[header?.indexOf('whatsapp') ?? -1]).toBe("'+5511912345678");
  });

  it('writes BOM, CRLF, ISO dates, booleans and empty cells for nulls', async () => {
    const h = createCommandHarness();
    h.seed(WORKSPACE_A, { jobTitle: null, marketingOptIn: false });

    const result = await run(h);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.csv.startsWith('﻿')).toBe(true);
    expect(result.value.csv.endsWith('\r\n')).toBe(true);
    const [header, row] = parseCsv(result.value.csv);
    const at = (column: string): string | undefined => row?.[header?.indexOf(column) ?? -1];
    expect(at('created_at')).toBe('2026-11-03T12:00:00.000Z');
    expect(at('marketing_opt_in')).toBe('false');
    expect(at('job_title')).toBe('');
    expect(at('score')).toBe('42');
    expect(at('anonymized_at')).toBe('');
    expect(at('first_touch_utm_source')).toBe('meta');
  });

  it('never exports IP, user agent, message, click ids or notes', () => {
    const forbidden = ['ip', 'user_agent', 'message', 'gclid', 'fbclid', 'fbp', 'fbc', 'note'];
    for (const column of EXPORT_COLUMNS) {
      expect(forbidden.some((word) => column.includes(word))).toBe(false);
    }
    expect(JSON.stringify(Object.keys(toExportRow(aStoredLead(WORKSPACE_A))))).not.toMatch(
      /clientIp|userAgent|message|gclid|fbclid/,
    );
  });

  it('marks anonymized leads with their placeholders and anonymized_at', async () => {
    const h = createCommandHarness();
    h.seed(WORKSPACE_A, {
      firstName: 'Anonymized',
      anonymizedAt: new Date('2026-11-04T08:00:00Z'),
    });

    const result = await run(h);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [header, row] = parseCsv(result.value.csv);
    expect(row?.[header?.indexOf('anonymized_at') ?? -1]).toBe('2026-11-04T08:00:00.000Z');
  });

  it('exports only the workspace of the credential (AC-CRM-06)', async () => {
    const h = createCommandHarness();
    h.seed(WORKSPACE_A);
    h.seed(WORKSPACE_B, { firstName: 'Estranho' });

    const result = await run(h);

    expect(result.ok && result.value.rowCount).toBe(1);
    expect(result.ok && result.value.csv).not.toContain('Estranho');
  });

  it('passes the filters through, resolving "me" to the caller', async () => {
    const h = createCommandHarness();
    h.seed(WORKSPACE_A, { ownerUserId: ADMIN_USER, stage: 'qualified', scoreBand: 'A' });
    h.seed(WORKSPACE_A, { ownerUserId: SALES_USER, stage: 'qualified', scoreBand: 'A' });
    h.seed(WORKSPACE_A, { ownerUserId: ADMIN_USER, stage: 'new', scoreBand: 'A' });

    const result = await run(h, query({ stage: ['qualified'], owner: ['me'], score_band: ['A'] }));

    expect(result.ok && result.value.rowCount).toBe(1);
    expect(h.exportReader.lastFilter).toEqual({
      stage: 'qualified',
      scoreBand: 'A',
      owner: { kind: 'user', userId: ADMIN_USER },
    });
  });

  it('supports owner=unassigned', async () => {
    const h = createCommandHarness();
    h.seed(WORKSPACE_A, { ownerUserId: ADMIN_USER });
    h.seed(WORKSPACE_A);

    const result = await run(h, query({ owner: ['unassigned'] }));

    expect(result.ok && result.value.rowCount).toBe(1);
  });

  it.each([
    ['an unknown parameter', { q: ['maria@empresa.com.br'] }, 'q', 'not_allowed'],
    ['a repeated parameter', { stage: ['new', 'won'] }, 'stage', 'not_allowed'],
    ['an invalid stage', { stage: ['bogus'] }, 'stage', 'invalid_choice'],
    ['an invalid owner', { owner: ['someone'] }, 'owner', 'invalid_format'],
    ['an invalid band', { score_band: ['Z'] }, 'score_band', 'invalid_choice'],
  ])('rejects %s with 400 before taking the lock', async (_label, entries, field, code) => {
    const h = createCommandHarness();

    const result = await run(h, query(entries));

    expect(result).toEqual({
      ok: false,
      error: { code: 'validation_failed', errors: [{ field, code }] },
    });
    expect(h.exportLock.acquired).toBe(0);
    expect(h.audit.entries).toHaveLength(0);
  });

  describe('ceiling (ST-20)', () => {
    it('cuts at 10 000 rows and flags the truncation', async () => {
      // arrange
      const h = createCommandHarness();
      const template = toExportRow(aStoredLead(WORKSPACE_A));
      h.exportReader.extraRows = Array.from({ length: EXPORT_MAX_ROWS + 5 }, () => template);
      // act
      const result = await run(h);
      // assert
      expect(result.ok && result.value.rowCount).toBe(EXPORT_MAX_ROWS);
      expect(result.ok && result.value.truncated).toBe(true);
      expect(h.exportReader.lastLimit).toBe(EXPORT_MAX_ROWS + 1);
      expect(h.audit.entries[0]?.metadata).toMatchObject({
        row_count: EXPORT_MAX_ROWS,
        truncated: true,
      });
    });

    it('is not truncated at exactly 10 000 rows', async () => {
      const h = createCommandHarness();
      const template = toExportRow(aStoredLead(WORKSPACE_A));
      h.exportReader.extraRows = Array.from({ length: EXPORT_MAX_ROWS }, () => template);

      const result = await run(h);

      expect(result.ok && result.value.truncated).toBe(false);
      expect(result.ok && result.value.rowCount).toBe(EXPORT_MAX_ROWS);
    });
  });

  describe('audit and lock (ST-21)', () => {
    it('audits row count and filter names, never values or PII', async () => {
      const h = createCommandHarness();
      h.seed(WORKSPACE_A, { firstName: 'Carla', ownerUserId: ADMIN_USER });

      await run(h, query({ stage: ['new'], owner: ['me'] }));

      expect(h.audit.entries).toHaveLength(1);
      expect(h.audit.entries[0]).toMatchObject({
        action: 'lead.exported',
        result: 'success',
        actorId: ADMIN_USER,
        resourceType: 'lead_export',
        metadata: { row_count: 1, truncated: false, filters: 'owner,stage' },
      });
      expect(JSON.stringify(h.audit.entries)).not.toMatch(/Carla|empresa|\+55/);
    });

    it('answers export_in_progress while the user has another export running', async () => {
      const h = createCommandHarness();
      await h.exportLock.acquire(WORKSPACE_A, ADMIN_USER);

      const result = await run(h);

      expect(result).toEqual({
        ok: false,
        error: { code: 'export_in_progress', retryAfterSeconds: 10 },
      });
      expect(h.audit.entries).toHaveLength(0);
    });

    it('lets another user export while the first one is running', async () => {
      const h = createCommandHarness();
      await h.exportLock.acquire(WORKSPACE_A, ADMIN_USER);

      const result = await run(h, query(), { ...adminActor, userId: SALES_USER, role: 'owner' });

      expect(result.ok).toBe(true);
    });

    it('releases the lock after a success and after a failure', async () => {
      const h = createCommandHarness();
      await run(h);
      expect(h.exportLock.held.size).toBe(0);

      h.audit.append = () => Promise.reject(new Error('audit store down'));
      await expect(run(h)).rejects.toThrow('audit store down');
      expect(h.exportLock.held.size).toBe(0);
      expect(h.exportLock.released).toBe(2);
    });

    it('does not export when the audit row cannot be written (nothing leaves unrecorded)', async () => {
      const h = createCommandHarness();
      h.seed(WORKSPACE_A);
      h.audit.append = () => Promise.reject(new Error('audit store down'));

      await expect(run(h)).rejects.toThrow('audit store down');
    });

    it('is fail-closed when the lock backend is unavailable', async () => {
      const h = createCommandHarness();
      h.exportLock.failure = new DependencyUnavailableError('cache');

      await expect(run(h)).rejects.toBeInstanceOf(DependencyUnavailableError);
      expect(h.audit.entries).toHaveLength(0);
    });
  });

  it.each([
    ['sales', { ...adminActor, role: 'sales' as const }],
    ['viewer', { ...adminActor, role: 'viewer' as const }],
  ])('refuses %s', async (_label, actor) => {
    const h = createCommandHarness();

    const result = await run(h, query(), actor);

    expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
    expect(h.exportLock.acquired).toBe(0);
  });
});
