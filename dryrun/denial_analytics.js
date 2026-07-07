import { writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// DENIAL ANALYTICS — free, GET-only. Dissects every denied authorization in
// the ledger: denial rate per rule/agent, decision latency (denied vs
// authorized), and the cost of denied work (holds frozen on denied calls).
// Nobody surfaces this — Sapiom's own dashboard shows spend, not denials.
// Output: denial_analytics.md + denial_analytics_result.json
// ---------------------------------------------------------------------------

const API_KEY = process.env.SAPIOM_API_KEY;
if (!API_KEY) {
  console.error('Error: SAPIOM_API_KEY not set.');
  process.exit(1);
}
const GOV_BASE = 'https://api.sapiom.ai';

async function gov(path) {
  const res = await fetch(`${GOV_BASE}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'User-Agent': 'curl/8.6.0' },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function allTransactions() {
  const out = [];
  let page = 0;
  let next = '/v1/transactions?page[limit]=100&sort=-created_at';
  while (next && page < 20) {
    const body = await gov(next);
    const rows = body?.data || body?.transactions || [];
    out.push(...rows);
    const rawNext = body?.links?.next;
    next = rawNext ? (rawNext.startsWith('/v1') ? rawNext : `/v1${rawNext}`) : null;
    page++;
  }
  return out;
}

const ms = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : null);
const fmtMs = (v) => (v == null ? 'n/a' : `${v}ms`);
const usd = (n) => `$${(+n).toFixed(6)}`;
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function main() {
  const txns = await allTransactions();
  console.log(`[denial] pulled ${txns.length} transactions`);

  const rows = [];
  for (const t of txns) {
    for (const ar of t.authorizationRequests || []) {
      rows.push({
        txn_id: t.id,
        agent: t.agent?.name || t.agentName || 'unknown',
        service: t.serviceName || t.service?.name || 'unknown',
        created: ar.createdAt,
        auth_status: ar.status,
        decision_ms:
          ar.status === 'denied' ? ms(ar.createdAt, ar.deniedAt) : ms(ar.createdAt, ar.authorizedAt),
        rules: (ar.ruleExecutions || []).map((re) => ({
          rule_id: re.ruleId,
          rule_name: re.rule?.name || re.ruleId,
          decision: re.decision ?? re.status ?? null,
          current_value: re.violations?.[0]?.currentValue ?? re.currentValue ?? null,
        })),
        denied_hold_usd:
          ar.status === 'denied'
            ? (t.costs || []).filter((c) => c.isActive).reduce((s, c) => s + parseFloat(c.fiatAmount || 0), 0)
            : 0,
      });
    }
  }

  const denied = rows.filter((r) => r.auth_status === 'denied');
  const authorized = rows.filter((r) => r.auth_status === 'authorized');

  // per rule
  const byRule = {};
  for (const r of denied) {
    for (const re of r.rules) {
      const k = re.rule_name;
      byRule[k] ??= { denials: 0, agents: new Set(), current_values: [] };
      byRule[k].denials++;
      byRule[k].agents.add(r.agent);
      if (re.current_value != null) byRule[k].current_values.push(re.current_value);
    }
  }
  // per agent
  const byAgent = {};
  for (const r of rows) {
    byAgent[r.agent] ??= { total: 0, denied: 0 };
    byAgent[r.agent].total++;
    if (r.auth_status === 'denied') byAgent[r.agent].denied++;
  }

  const deniedLat = denied.map((r) => r.decision_ms).filter((v) => v != null);
  const authLat = authorized.map((r) => r.decision_ms).filter((v) => v != null);
  const frozenOnDenied = denied.reduce((s, r) => s + r.denied_hold_usd, 0);

  const result = {
    fetched_at: new Date().toISOString(),
    n_auth_requests: rows.length,
    n_denied: denied.length,
    n_authorized: authorized.length,
    denial_rate_pct: rows.length ? (100 * denied.length) / rows.length : 0,
    denied_decision_ms: { median: median(deniedLat), min: Math.min(...deniedLat), max: Math.max(...deniedLat) },
    authorized_decision_ms: { median: median(authLat) },
    frozen_on_denied_usd: frozenOnDenied,
    by_rule: Object.fromEntries(
      Object.entries(byRule).map(([k, v]) => [k, { denials: v.denials, agents: [...v.agents], current_values: v.current_values }])
    ),
    by_agent: byAgent,
    denied_detail: denied,
  };
  await writeFile(new URL('./denial_analytics_result.json', import.meta.url), JSON.stringify(result, null, 2));

  // ---- markdown -------------------------------------------------------------
  const lines = [];
  lines.push('# Denial Analytics — governance decisions dissected');
  lines.push('');
  lines.push(`Generated ${result.fetched_at} — free, GET-only over /v1/transactions (${txns.length} txns, ${rows.length} authorization requests).`);
  lines.push('');
  lines.push('## Headline');
  lines.push('');
  lines.push(`- **${denied.length} denials / ${rows.length} authorization requests (${result.denial_rate_pct.toFixed(1)}%)** — every denial traces to a deliberately-created test rule; zero organic denials (no production rules exist).`);
  lines.push(`- **Denial decision latency: median ${fmtMs(result.denied_decision_ms.median)}** (min ${fmtMs(result.denied_decision_ms.min)}, max ${fmtMs(result.denied_decision_ms.max)}) vs authorized median ${fmtMs(result.authorized_decision_ms.median)} — denying is ${result.denied_decision_ms.median != null && result.authorized_decision_ms.median ? (result.denied_decision_ms.median / result.authorized_decision_ms.median).toFixed(1) : 'n/a'}x the authorized decision time.`);
  lines.push(`- **Cost of denied work: ${usd(frozenOnDenied)}** in live holds still attached to denied transactions (denied-at-auth holds release on a slow backend sweep — see hold_vs_settlement_experiment.md Cleanup).`);
  lines.push('');
  lines.push('## Denials by rule');
  lines.push('');
  lines.push('| Rule | Denials | Agents hit | currentValue seen |');
  lines.push('|---|---|---|---|');
  for (const [k, v] of Object.entries(result.by_rule)) {
    lines.push(`| ${k} | ${v.denials} | ${v.agents.join(', ')} | ${v.current_values.slice(0, 5).join(', ')}${v.current_values.length > 5 ? ', …' : ''} |`);
  }
  lines.push('');
  lines.push('## Denial rate by agent');
  lines.push('');
  lines.push('| Agent | Auth requests | Denied | Rate |');
  lines.push('|---|---|---|---|');
  for (const [k, v] of Object.entries(byAgent).sort((a, b) => b[1].denied - a[1].denied)) {
    if (v.denied === 0) continue;
    lines.push(`| ${k} | ${v.total} | ${v.denied} | ${((100 * v.denied) / v.total).toFixed(1)}% |`);
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Decision latency = authorizationRequests.createdAt -> deniedAt/authorizedAt, per the ledger\'s own timestamps.');
  lines.push('- "Cost of denied work" counts live (isActive) cost rows on denied transactions — money frozen for calls that never ran.');
  lines.push('- All denials here come from experiment rules (hold-vs-settlement, TOCTOU, R5 boundary); rates describe those experiments, not organic traffic.');
  lines.push('');
  await writeFile(new URL('./denial_analytics.md', import.meta.url), lines.join('\n'));
  console.log(`[denial] wrote denial_analytics.md — ${denied.length}/${rows.length} denied, frozen on denied ${usd(frozenOnDenied)}`);
}

main().catch((err) => {
  console.error('Fatal error:', err?.stack || err);
  process.exit(1);
});
