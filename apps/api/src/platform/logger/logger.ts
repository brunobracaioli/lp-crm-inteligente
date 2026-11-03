import { pino, type DestinationStream, type Logger, type LevelWithSilent } from 'pino';
import { redactDeep } from '#/platform/logger/redact.ts';

export type { Logger } from 'pino';

export interface LoggerOptions {
  readonly level: LevelWithSilent;
  readonly appEnv: string;
  /** Test hook: capture output instead of writing to stdout. */
  readonly destination?: DestinationStream;
}

const UNSERIALIZABLE_LINE = `${JSON.stringify({ level: 'error', message: 'log line dropped: not valid JSON' })}\n`;

/** Re-parses each JSON line and redacts it, so child bindings and nested objects are covered too. */
export function redactLine(line: string): string {
  try {
    return `${JSON.stringify(redactDeep(JSON.parse(line)))}\n`;
  } catch {
    // Fail closed: an unparseable line could carry PII verbatim.
    return UNSERIALIZABLE_LINE;
  }
}

function redactingDestination(target: DestinationStream): DestinationStream {
  return {
    write(line: string) {
      target.write(redactLine(line));
    },
  };
}

/**
 * Structured JSON logger with PII redaction at any depth, including child bindings
 * (000-overview §5.3, AC-LC-17). Messages must stay free of PII by convention: only IDs and codes.
 */
export function createLogger(options: LoggerOptions): Logger {
  const target = options.destination ?? pino.destination({ dest: 1, sync: true });
  return pino(
    {
      level: options.level,
      base: { service: 'lp-crm-api', env: options.appEnv },
      messageKey: 'message',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      // Errors keep only type/message/stack: driver fields such as `detail` may echo row values.
      serializers: { err: (error: unknown) => redactDeep(error) },
    },
    redactingDestination(target),
  );
}
