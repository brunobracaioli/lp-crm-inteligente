import { describe, expect, it } from 'vitest';
import { stageEventId, uuidV5 } from '#/modules/crm/infrastructure/postgres-stage-change-outbox.ts';

const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidV5', () => {
  it('matches the RFC 9562 reference vector', () => {
    // python3: uuid.uuid5(uuid.NAMESPACE_DNS, 'www.example.com')
    expect(uuidV5('www.example.com', NAMESPACE_DNS)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });
});

describe('stageEventId', () => {
  const leadId = '0194f1c2-7a3b-7c11-8f00-5b6f4e1d2a10';

  it('is a deterministic v5 UUID of lead and stage', () => {
    expect(stageEventId(leadId, 'qualified')).toMatch(UUID_V5);
    expect(stageEventId(leadId, 'qualified')).toBe(stageEventId(leadId, 'qualified'));
  });

  it('differs per stage and per lead', () => {
    expect(stageEventId(leadId, 'qualified')).not.toBe(stageEventId(leadId, 'won'));
    expect(stageEventId(leadId, 'won')).not.toBe(
      stageEventId('0194f1c2-7a3b-7c11-8f00-5b6f4e1d2a11', 'won'),
    );
  });
});
