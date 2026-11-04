/**
 * QStash schedules as code (Onda 5b): the outbox sweeper, every 5 minutes (tracking §5.1, AC-TR-07).
 *
 * Dry-run by default: prints the plan and changes nothing. `--apply` creates or updates the schedule
 * under a fixed id, so running it twice leaves one schedule. Applying is an external action: the
 * project owner runs it (docs/how-to), never an agent.
 *
 *   node --env-file=../../.env.local scripts/qstash-schedules.ts           # plan
 *   node --env-file=../../.env.local scripts/qstash-schedules.ts --apply   # create/update
 */
import { Client } from '@upstash/qstash';
import { z } from 'zod';

const SWEEP_PATH = '/internal/v1/outbox/sweep';
const SWEEP_CRON = '*/5 * * * *';
const SWEEP_RETRIES = 3;

const envSchema = z.object({
  APP_ENV: z.enum(['development', 'preview', 'production']),
  QSTASH_URL: z.url({ protocol: /^https$/ }),
  QSTASH_TOKEN: z.string().min(1),
  PUBLIC_API_BASE_URL: z.url({ protocol: /^https$/ }),
});

interface SchedulePlan {
  readonly scheduleId: string;
  readonly destination: string;
  readonly cron: string;
}

function planFor(env: z.infer<typeof envSchema>): SchedulePlan {
  return {
    scheduleId: `lp-outbox-sweep-${env.APP_ENV}`,
    destination: new URL(SWEEP_PATH, env.PUBLIC_API_BASE_URL).toString(),
    cron: SWEEP_CRON,
  };
}

async function main(): Promise<void> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Names only, never values.
    const names = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`invalid environment for qstash-schedules: ${names}`);
  }
  const plan = planFor(parsed.data);
  process.stdout.write(`${JSON.stringify({ plan, apply: process.argv.includes('--apply') })}\n`);
  if (!process.argv.includes('--apply')) {
    return;
  }

  const client = new Client({ baseUrl: parsed.data.QSTASH_URL, token: parsed.data.QSTASH_TOKEN });
  await client.schedules.create({
    scheduleId: plan.scheduleId,
    destination: plan.destination,
    cron: plan.cron,
    method: 'POST',
    // The contract requires a JSON body; an empty body is rejected with 400 invalid_json.
    body: '{}',
    headers: { 'Content-Type': 'application/json' },
    retries: SWEEP_RETRIES,
  });
  process.stdout.write(`${JSON.stringify({ applied: plan.scheduleId })}\n`);
}

await main();
