/**
 * Vercel Firewall rules and Monitors as code (Onda 6b). Prints a plan and changes nothing: the
 * owner runs the printed commands, reviews `vercel firewall diff` and publishes (external action,
 * never an agent). See docs/how-to/apply-firewall-and-monitors.md.
 *
 *   node scripts/vercel-ops.ts firewall [--edit=lp-a,lp-b]   # CLI commands (add, or edit for existing)
 *   node scripts/vercel-ops.ts monitors --project <name> --out <dir>   # body files + CLI commands
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firewallFileSchema, monitorsFileSchema } from './vercel-ops-schema.ts';

const OPS_DIR = new URL('../ops/vercel/', import.meta.url);

function load(file: string): unknown {
  return JSON.parse(readFileSync(new URL(file, OPS_DIR), 'utf8')) as unknown;
}

/** POSIX single-quote escaping, so the JSON payload reaches the CLI byte for byte. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function planFirewall(): string[] {
  const { rules } = firewallFileSchema.parse(load('firewall-rules.json'));
  const existing = new Set((option('edit') ?? '').split(',').filter((name) => name !== ''));
  const commands = rules.map((rule) => {
    const payload = shellQuote(JSON.stringify({ ...rule, active: true }));
    return existing.has(rule.name)
      ? `vercel firewall rules edit ${rule.name} --json ${payload} --yes`
      : `vercel firewall rules add --json ${payload} --yes`;
  });
  return [
    ...commands,
    'vercel firewall diff',
    '# review the diff, then: vercel firewall publish --yes',
  ];
}

function planMonitors(): string[] {
  const project = option('project');
  const out = option('out');
  if (project === undefined || out === undefined) {
    throw new Error('monitors: --project <name> and --out <dir> are required');
  }
  const { monitors } = monitorsFileSchema.parse(load('monitors.json'));
  mkdirSync(out, { recursive: true });
  return monitors.map((monitor) => {
    const file = join(out, `${monitor.name}.json`);
    writeFileSync(file, `${JSON.stringify(monitor, null, 2)}\n`);
    return `vercel monitors add --project ${shellQuote(project)} --body ${shellQuote(file)}`;
  });
}

function main(): void {
  const command = process.argv[2];
  const lines =
    command === 'firewall' ? planFirewall() : command === 'monitors' ? planMonitors() : undefined;
  if (lines === undefined) {
    throw new Error('usage: vercel-ops.ts firewall|monitors [options]');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

main();
