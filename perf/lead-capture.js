// k6 load test for POST /v1/leads — acceptance criterion AC-LC-19 (docs/specs/lead-capture.md §9):
// on a Vercel preview, 20 VUs for 1 minute must give p95 <= 800 ms and 0% 5xx.
//
// k6 is an external binary (https://grafana.com/docs/k6/latest/set-up/install-k6/); this repo adds
// no npm dependency for it. See perf/README.md for how to run against a local Prism mock and
// against a preview (the latter needs the project owner's confirmation).
//
// Environment variables (all optional):
//   BASE_URL                 API origin, no trailing slash. Default http://localhost:4010 (Prism).
//   CONFIRM_REMOTE           Must be "yes" when BASE_URL is not loopback (owner confirmation guard).
//   ORIGIN                   Origin header; must be in CORS_ALLOWED_ORIGINS and form.allowed_origins.
//   FORM_KEY                 Public form key. Default frm_lp_principal (supabase/seed.sql).
//   TURNSTILE_TOKEN          Sent as turnstile_token. Default is Cloudflare's documented dummy token;
//                            it only passes when the target runs Turnstile test keys.
//   EMAIL_DOMAIN             Domain of the synthetic e-mails. Default example.com (RFC 2606).
//   CONSENT                  "denied" (default) or "granted". Keep "denied" unless the target sends
//                            server-side conversions to a Meta TEST event code only (no real ads data).
//   VERCEL_PROTECTION_BYPASS Optional Vercel "Protection Bypass for Automation" secret, sent as the
//                            x-vercel-protection-bypass header (set in your shell, never in a file).
//   SCENARIO                 steady (default) | spike | all.
//   VUS / DURATION_SECONDS   Steady load. Defaults 20 / 60 (the AC-LC-19 profile).
//   THINK_TIME_SECONDS       Pause between iterations of one VU. Default 5 (keeps the steady profile
//                            near 240 req/min, under the 300 req/min per-form limit).
//   SPIKE_VUS                Peak VUs of the spike scenario. Default 60.
//   SPIKE_THINK_TIME_SECONDS Default 0.5.
//   P95_MS                   Steady p95 threshold for accepted (202) responses. Default 800.
//   SPIKE_P95_MS             Spike p95 threshold for accepted responses. Default 2000.
//   MIN_ACCEPTED_RATE        Minimum share of 202 among all steady responses. Default 0.95. A run that
//                            is mostly 429/403 measured the guards, not the accepted path, and fails.
//
// All data is synthetic: fixed names, a reserved e-mail domain and a fictional phone number.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:4010').replace(/\/+$/, '');
const ORIGIN = __ENV.ORIGIN || 'http://localhost:4321';
const FORM_KEY = __ENV.FORM_KEY || 'frm_lp_principal';
const TURNSTILE_TOKEN = __ENV.TURNSTILE_TOKEN || 'XXXX.DUMMY.TOKEN.XXXX';
const EMAIL_DOMAIN = (__ENV.EMAIL_DOMAIN || 'example.com').toLowerCase();
const CONSENT_VALUE = __ENV.CONSENT === 'granted' ? 'granted' : 'denied';
const SCENARIO = __ENV.SCENARIO || 'steady';
const PROTECTION_BYPASS = __ENV.VERCEL_PROTECTION_BYPASS || '';

const VUS = Number(__ENV.VUS || 20);
const DURATION_SECONDS = Number(__ENV.DURATION_SECONDS || 60);
const THINK_TIME_SECONDS = Number(__ENV.THINK_TIME_SECONDS || 5);
const SPIKE_VUS = Number(__ENV.SPIKE_VUS || 60);
const SPIKE_THINK_TIME_SECONDS = Number(__ENV.SPIKE_THINK_TIME_SECONDS || 0.5);
const P95_MS = Number(__ENV.P95_MS || 800);
const SPIKE_P95_MS = Number(__ENV.SPIKE_P95_MS || 2000);
const MIN_ACCEPTED_RATE = Number(__ENV.MIN_ACCEPTED_RATE || 0.95);

const SPIKE_GAP_SECONDS = 30;
const LOOPBACK_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(\/|$)/;

if (!['steady', 'spike', 'all'].includes(SCENARIO)) {
  throw new Error('SCENARIO must be steady, spike or all');
}
const runSteady = SCENARIO === 'steady' || SCENARIO === 'all';
const runSpike = SCENARIO === 'spike' || SCENARIO === 'all';

// Share of 202 among all responses: guards against a "green" run made only of fast 429/403.
const accepted = new Rate('lead_accepted');
// Any 5xx or transport failure. The AC requires exactly zero.
const serverErrors = new Rate('lead_server_errors');
// Anything that is neither 202 nor an expected 429 (e.g. 400, 403, 404, 415, 422, 5xx).
const unexpected = new Rate('lead_unexpected_responses');
const rateLimited = new Counter('lead_rate_limited');

const scenarios = {};
if (runSteady) {
  scenarios.steady = {
    executor: 'constant-vus',
    vus: VUS,
    duration: `${DURATION_SECONDS}s`,
    exec: 'steady',
  };
}
if (runSpike) {
  scenarios.spike = {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '10s', target: SPIKE_VUS },
      { duration: '30s', target: SPIKE_VUS },
      { duration: '10s', target: 0 },
    ],
    gracefulRampDown: '10s',
    startTime: runSteady ? `${DURATION_SECONDS + SPIKE_GAP_SECONDS}s` : '0s',
    exec: 'spike',
  };
}

const thresholds = {
  lead_server_errors: ['rate==0'],
  lead_unexpected_responses: ['rate<0.01'],
};
if (runSteady) {
  // "expected_response" is true only for 202 (see setResponseCallback below).
  thresholds['http_req_duration{scenario:steady,expected_response:true}'] = [`p(95)<${P95_MS}`];
  thresholds['lead_accepted{scenario:steady}'] = [`rate>=${MIN_ACCEPTED_RATE}`];
}
if (runSpike) {
  thresholds['http_req_duration{scenario:spike,expected_response:true}'] = [
    `p(95)<${SPIKE_P95_MS}`,
  ];
}

export const options = {
  scenarios,
  thresholds,
  // Summary percentiles that matter for the SLO.
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// Only 202 counts as an expected response, so the latency threshold is computed over the accepted
// path; 429 is tracked separately and never hides slow accepted requests.
http.setResponseCallback(http.expectedStatuses(202));

export function setup() {
  if (!LOOPBACK_HOST.test(BASE_URL) && __ENV.CONFIRM_REMOTE !== 'yes') {
    throw new Error(
      `Refusing to load test ${BASE_URL}: not a loopback address. Set CONFIRM_REMOTE=yes only ` +
        'after the project owner confirmed the target (preview, never production).',
    );
  }
  // Shared by all VUs so e-mails stay unique across VUs and across runs.
  return { runId: Date.now().toString(36) };
}

function uuidV4() {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else if (i === 19) {
      out += hex[8 + Math.floor(Math.random() * 4)];
    } else {
      out += hex[Math.floor(Math.random() * 16)];
    }
  }
  return out;
}

// Valid against contracts/openapi.v1.yaml (LeadSubmissionRequest) and lead-capture §4.
function buildPayload(runId) {
  return {
    form_key: FORM_KEY,
    turnstile_token: TURNSTILE_TOKEN,
    first_name: 'Teste',
    last_name: 'Carga',
    email: `k6-${runId}-${__VU}-${__ITER}@${EMAIL_DOMAIN}`,
    whatsapp: '+5511912345678',
    company: 'Empresa Sintetica Ltda',
    area_of_expertise: 'technology',
    area_of_expertise_other: null,
    job_title: 'Teste de carga',
    company_size: '11_50',
    company_website: 'https://example.com',
    message: 'Lead sintetico gerado pelo k6 (AC-LC-19).',
    marketing_opt_in: false,
    privacy_consent: true,
    hp: '',
    consent: {
      analytics_storage: CONSENT_VALUE,
      ad_storage: CONSENT_VALUE,
      ad_user_data: CONSENT_VALUE,
      ad_personalization: 'denied',
    },
    tracking: {
      event_id: uuidV4(),
      utm_source: 'k6',
      utm_medium: 'loadtest',
      utm_campaign: 'ac-lc-19',
      landing_page_url: `${ORIGIN}/?utm_source=k6`,
    },
  };
}

function submitLead(runId) {
  const headers = {
    'Content-Type': 'application/json',
    Origin: ORIGIN,
    'Idempotency-Key': uuidV4(),
    'X-Request-Id': uuidV4(),
  };
  if (PROTECTION_BYPASS !== '') {
    headers['x-vercel-protection-bypass'] = PROTECTION_BYPASS;
  }
  const response = http.post(`${BASE_URL}/v1/leads`, JSON.stringify(buildPayload(runId)), {
    headers,
    tags: { name: 'POST /v1/leads' },
  });

  const status = response.status;
  accepted.add(status === 202);
  // Status 0 = no HTTP response (timeout, connection reset): also a failure of the service.
  serverErrors.add(status === 0 || status >= 500);
  unexpected.add(status !== 202 && status !== 429);
  if (status === 429) {
    rateLimited.add(1);
  }

  check(response, {
    '202 body has submission_id and event_id': (r) => {
      if (r.status !== 202) return true;
      const body = r.json();
      return typeof body.submission_id === 'string' && typeof body.event_id === 'string';
    },
    '429 carries Retry-After': (r) => r.status !== 429 || r.headers['Retry-After'] !== undefined,
  });
}

function pause(seconds) {
  // +-20% jitter so VUs do not stay in lockstep.
  sleep(seconds * (0.8 + Math.random() * 0.4));
}

export function steady(data) {
  submitLead(data.runId);
  pause(THINK_TIME_SECONDS);
}

export function spike(data) {
  submitLead(data.runId);
  pause(SPIKE_THINK_TIME_SECONDS);
}
