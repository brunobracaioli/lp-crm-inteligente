import { describe, expect, it } from 'vitest';
import type { RawBody } from '#/modules/crm/application/commands/failures.ts';
import type { StaffActor } from '#/modules/crm/application/commands/ports.ts';
import type { AddLeadNoteCommand } from '#/modules/crm/application/commands/add-lead-note.ts';
import {
  ADMIN_USER,
  CORRELATION,
  KEY_1,
  KEY_2,
  OTHER_SALES_USER,
  SALES_USER,
  VIEWER_USER,
  WORKSPACE_A,
  WORKSPACE_B,
  createCommandHarness,
} from '#test/fakes/crm-commands.ts';

const json = (value: unknown): RawBody => ({ kind: 'json', value });
const adminActor: StaffActor = { userId: ADMIN_USER, workspaceId: WORKSPACE_A, role: 'admin' };
const salesActor: StaffActor = { userId: SALES_USER, workspaceId: WORKSPACE_A, role: 'sales' };

function command(
  overrides: Partial<AddLeadNoteCommand> & Pick<AddLeadNoteCommand, 'leadId'>,
): AddLeadNoteCommand {
  return {
    actor: adminActor,
    body: json({ body: 'Ligar na segunda.' }),
    idempotencyKey: KEY_1,
    correlationId: CORRELATION,
    ...overrides,
  };
}

const noteOf = (text: string): RawBody => json({ body: text });

describe('addLeadNote', () => {
  it('appends a note_added activity, leaves the version and owner alone, audits without the text', async () => {
    // arrange
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);
    // act
    const result = await h.addLeadNote(command({ leadId: lead.id, actor: salesActor }));
    // assert
    expect(result).toMatchObject({
      ok: true,
      value: { body: 'Ligar na segunda.', actorId: SALES_USER },
    });
    expect(h.activities.records).toEqual([
      expect.objectContaining({
        type: 'note_added',
        actorType: 'user',
        actorId: SALES_USER,
        data: { body: 'Ligar na segunda.' },
      }),
    ]);
    expect(h.leads.all()[0]).toMatchObject({ version: 3, ownerUserId: null });
    expect(h.audit.entries).toHaveLength(1);
    expect(h.audit.entries[0]).toMatchObject({ action: 'lead.note_added', result: 'success' });
    expect(JSON.stringify(h.audit.entries)).not.toContain('Ligar');
    expect(h.audit.entries[0]?.metadata).toEqual({
      activity_id: h.activities.records[0]?.id,
      length: 17,
    });
    expect(h.leadReader.lockedReads).toBe(1);
  });

  it('requires an Idempotency-Key (ST-24) after the resource checks', async () => {
    const h = createCommandHarness();
    const lead = h.seed(WORKSPACE_A);
    const foreign = h.seed(WORKSPACE_B);

    const missing = await h.addLeadNote(command({ leadId: lead.id, idempotencyKey: null }));
    const foreignMissing = await h.addLeadNote(
      command({ leadId: foreign.id, idempotencyKey: null }),
    );

    expect(missing).toEqual({ ok: false, error: { code: 'idempotency_key_missing' } });
    expect(foreignMissing).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(h.activities.records).toHaveLength(0);
  });

  describe('text pipeline (ST-39)', () => {
    it('normalizes to NFC, trims and turns CRLF into LF', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);

      const result = await h.addLeadNote(
        command({ leadId: lead.id, body: noteOf('  José\r\nlinha 2  ') }),
      );

      expect(result).toMatchObject({ ok: true, value: { body: 'José\nlinha 2' } });
    });

    it('stores markup literally (the UI renders it as text)', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      const markup = '<script>alert(1)</script><img src=x onerror=alert(1)>';

      const result = await h.addLeadNote(command({ leadId: lead.id, body: noteOf(markup) }));

      expect(result).toMatchObject({ ok: true, value: { body: markup } });
    });

    it.each([
      ['a bidi override (Trojan Source)', 'pagar‮aha'],
      ['a zero-width space', 'pa​gar'],
      ['a control character', 'pa\u0007gar'],
      ['a tab', 'pa\tgar'],
      ['U+FFFD', 'pa�gar'],
      ['a lone surrogate', 'pa\ud800gar'],
    ])('rejects %s with body/not_allowed_characters', async (_label, text) => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);

      const result = await h.addLeadNote(command({ leadId: lead.id, body: noteOf(text) }));

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'validation_failed',
          errors: [{ field: 'body', code: 'not_allowed_characters' }],
        },
      });
      expect(h.activities.records).toHaveLength(0);
    });

    it.each([
      ['empty', '', 'required'],
      ['only spaces', '   \n  ', 'required'],
      ['5001 code points', 'a'.repeat(5001), 'too_long'],
      // 4 000 code points × 3 bytes = 12 000 bytes: inside 5000 characters, over the 8 KB jsonb CHECK
      ['more than 8000 UTF-8 bytes', '日'.repeat(4000), 'too_long'],
    ])('rejects a note that is %s', async (_label, text, code) => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);

      const result = await h.addLeadNote(command({ leadId: lead.id, body: noteOf(text) }));

      expect(result).toEqual({
        ok: false,
        error: { code: 'validation_failed', errors: [{ field: 'body', code }] },
      });
    });

    it('accepts exactly 5000 ASCII characters', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);

      const result = await h.addLeadNote(
        command({ leadId: lead.id, body: noteOf('a'.repeat(5000)) }),
      );

      expect(result.ok).toBe(true);
    });

    it.each([
      [{ body: 42 }, 'body', 'invalid_format'],
      [{}, 'body', 'required'],
      [{ body: 'ok', stage: 'won' }, 'stage', 'not_allowed'],
      [{ body: 'ok', owner_user_id: SALES_USER }, 'owner_user_id', 'not_allowed'],
    ])('validates the strict body %j', async (body, field, code) => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);

      const result = await h.addLeadNote(command({ leadId: lead.id, body: json(body) }));

      expect(result).toEqual({
        ok: false,
        error: { code: 'validation_failed', errors: [{ field, code }] },
      });
    });
  });

  describe('authorization', () => {
    it('lets sales annotate an unowned lead without becoming its owner', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);

      await h.addLeadNote(command({ leadId: lead.id, actor: salesActor }));

      expect(h.leads.all()[0]?.ownerUserId).toBeNull();
    });

    it('refuses sales on a lead owned by someone else and audits the denial', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A, { ownerUserId: OTHER_SALES_USER });

      const result = await h.addLeadNote(command({ leadId: lead.id, actor: salesActor }));

      expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
      expect(h.activities.records).toHaveLength(0);
      expect(h.audit.entries[0]).toMatchObject({ action: 'lead.note_added', result: 'denied' });
    });

    it('refuses viewer', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);

      const result = await h.addLeadNote(
        command({
          leadId: lead.id,
          actor: { userId: VIEWER_USER, workspaceId: WORKSPACE_A, role: 'viewer' },
        }),
      );

      expect(result).toEqual({ ok: false, error: { code: 'forbidden' } });
    });

    it('answers not_found for a lead of another workspace (AC-CRM-06)', async () => {
      const h = createCommandHarness();
      const foreign = h.seed(WORKSPACE_B);

      const result = await h.addLeadNote(command({ leadId: foreign.id }));

      expect(result).toEqual({ ok: false, error: { code: 'not_found' } });
      expect(h.activities.records).toHaveLength(0);
    });

    it('refuses an anonymized lead', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A, { anonymizedAt: new Date('2026-11-04T00:00:00Z') });

      const result = await h.addLeadNote(command({ leadId: lead.id }));

      expect(result).toEqual({ ok: false, error: { code: 'lead_anonymized' } });
      expect(h.activities.records).toHaveLength(0);
    });
  });

  describe('idempotency (ST-24)', () => {
    it('returns the same note for a repeated key and writes once', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      const cmd = command({ leadId: lead.id });

      const first = await h.addLeadNote(cmd);
      const second = await h.addLeadNote(cmd);

      expect(first.ok && second.ok).toBe(true);
      expect(second).toEqual(first);
      expect(h.activities.records).toHaveLength(1);
      expect(h.audit.entries).toHaveLength(1);
    });

    it('rejects the same key with another text', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      await h.addLeadNote(command({ leadId: lead.id }));

      const result = await h.addLeadNote(command({ leadId: lead.id, body: noteOf('outro texto') }));

      expect(result).toEqual({ ok: false, error: { code: 'idempotency_key_reused' } });
      expect(h.activities.records).toHaveLength(1);
    });

    it('writes a second note for a new key', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      await h.addLeadNote(command({ leadId: lead.id }));

      await h.addLeadNote(command({ leadId: lead.id, idempotencyKey: KEY_2 }));

      expect(h.activities.records).toHaveLength(2);
    });

    it('refuses to write when the idempotency store is down (a retry could duplicate)', async () => {
      const h = createCommandHarness();
      h.idempotency.unavailable = true;
      const lead = h.seed(WORKSPACE_A);

      const result = await h.addLeadNote(command({ leadId: lead.id }));

      expect(result).toEqual({ ok: false, error: { code: 'idempotency_unavailable' } });
      expect(h.activities.records).toHaveLength(0);
    });

    it('releases the claim after a validation failure so the client can fix and retry', async () => {
      const h = createCommandHarness();
      const lead = h.seed(WORKSPACE_A);
      await h.addLeadNote(command({ leadId: lead.id, body: noteOf('') }));

      const retried = await h.addLeadNote(command({ leadId: lead.id }));

      expect(retried.ok).toBe(true);
    });
  });
});
