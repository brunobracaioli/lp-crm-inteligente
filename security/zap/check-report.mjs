// Gate for a ZAP JSON report (Onda 6b acceptance: "zap baseline reports 0 High/Medium").
// Usage: node security/zap/check-report.mjs <report.json>
// Exit codes: 0 = no High/Medium alert, 1 = at least one, 2 = unreadable report.
// Prints rule id, risk, name and instance count only: never request/response bodies.
import { readFileSync } from 'node:fs';

const MEDIUM_RISK_CODE = 2;
const RISK_LABELS = { 0: 'Informational', 1: 'Low', 2: 'Medium', 3: 'High' };

const reportPath = process.argv[2];
if (reportPath === undefined) {
  process.stderr.write('usage: node security/zap/check-report.mjs <report.json>\n');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch {
  process.stderr.write(`cannot read ZAP report: ${reportPath}\n`);
  process.exit(2);
}

const alerts = (Array.isArray(report.site) ? report.site : []).flatMap((site) =>
  Array.isArray(site.alerts) ? site.alerts : [],
);

const blocking = alerts.filter((alert) => Number(alert.riskcode) >= MEDIUM_RISK_CODE);

process.stdout.write(`ZAP alerts: ${alerts.length} total, ${blocking.length} High/Medium\n`);
for (const alert of blocking) {
  const risk = RISK_LABELS[Number(alert.riskcode)] ?? String(alert.riskcode);
  process.stdout.write(
    `  [${risk}] ${alert.pluginid} ${alert.name} (${alert.count ?? '?'} instance(s))\n`,
  );
}

process.exit(blocking.length > 0 ? 1 : 0);
