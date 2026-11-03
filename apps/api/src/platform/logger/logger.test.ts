import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, redactLine } from '#/platform/logger/logger.ts';
import { REDACTED, redactDeep } from '#/platform/logger/redact.ts';

function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger({ level: 'info', appEnv: 'test', destination });
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, records };
}

const PII = {
  email: 'maria@empresa.com.br',
  whatsapp: '+5511912345678',
  first_name: 'Maria',
  token: 'fake-token-value',
  client_ip: '203.0.113.7',
};

describe('createLogger', () => {
  it('redacts email, whatsapp, names, ip and tokens at the top level', () => {
    // arrange
    const { logger, lines } = captureLogger();
    // act
    logger.info(PII, 'lead received');
    // assert
    const output = lines.join('');
    for (const value of Object.values(PII)) expect(output).not.toContain(value);
    expect(output).toContain(REDACTED);
    expect(output).toContain('lead received');
  });

  it('redacts nested objects, arrays and child bindings', () => {
    const { logger, lines } = captureLogger();

    logger
      .child({ authorization: 'Bearer secret-jwt' })
      .warn({ request: { headers: { cookie: 'sid=1' } }, leads: [{ email: PII.email }] }, 'nested');

    const output = lines.join('');
    expect(output).not.toContain('secret-jwt');
    expect(output).not.toContain('sid=1');
    expect(output).not.toContain(PII.email);
  });

  it('keeps internal identifiers and emits JSON with level labels', () => {
    const { logger, records } = captureLogger();

    logger.info({ lead_id: '0190a3c2-0000-7000-8000-000000000001', outcome: 'accepted' }, 'ok');

    const [record] = records();
    expect(record).toMatchObject({
      level: 'info',
      service: 'lp-crm-api',
      lead_id: '0190a3c2-0000-7000-8000-000000000001',
      outcome: 'accepted',
      message: 'ok',
    });
  });
});

describe('redactDeep', () => {
  it('serialises errors without throwing and truncates very deep objects', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 20; level += 1) deep = { next: deep };

    expect(redactDeep(new Error('boom'))).toMatchObject({ type: 'Error', message: 'boom' });
    expect(JSON.stringify(redactDeep(deep))).toContain('[TRUNCATED]');
  });
});

describe('redactLine', () => {
  it('drops a line that is not valid JSON instead of passing it through', () => {
    const output = redactLine('not json maria@empresa.com.br');
    expect(output).not.toContain('maria@');
    expect(output).toContain('log line dropped');
  });
});
