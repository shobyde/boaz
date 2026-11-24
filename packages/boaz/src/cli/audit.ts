// boaz audit — does each question reach what it should?
//
// One probe file, one engine, one line per question. Exit 1 when a question goes
// somewhere else, so it can gate a deploy or a pull request.
import { loadProbes, type Probe } from './probes.js';
import { ask, knowledgeSource, loadAgentModule, type AgentModule } from './harness.js';

export interface AuditRow {
  question: string;
  expect?: string;
  got?: string;
  args?: Record<string, unknown>;
  ok: boolean;
  note?: string;
}

function subset(actual: Record<string, unknown> | undefined, expected: Record<string, unknown>): boolean {
  if (!expected) return true;
  return Object.entries(expected).every(([key, value]) => String(actual?.[key]) === String(value));
}

async function runProbe(module: AgentModule, probe: Probe): Promise<AuditRow> {
  const engine = module.createEngine();
  const turn = await ask(engine, probe.question, module.runCapability);
  if (!turn.isCall) {
    const knowledge = knowledgeSource(module.capabilities, turn.text);
    const got = turn.composedBy ?? knowledge;
    return {
      question: probe.question,
      ...(probe.expect ? { expect: probe.expect } : {}),
      ...(got ? { got } : {}),
      ok: got === probe.expect,
      /* eslint-disable-next-line no-nested-ternary */
      ...(got === probe.expect
        ? {}
        : { note: `answered in prose: "${turn.text.replace(/\s+/g, ' ').slice(0, 90)}"` }),
    };
  }
  // The engine's own provenance: a rule that planned this call names it, while
  // the keyword engine picking the same capability is a different answer and
  // must not be mistaken for the rule.
  const got = turn.plannedBy ?? turn.toolId;
  const argsOk = subset(turn.args, probe.args ?? {});
  return {
    question: probe.question,
    ...(probe.expect ? { expect: probe.expect } : {}),
    ...(got ? { got } : {}),
    ...(turn.args ? { args: turn.args } : {}),
    ok: got === probe.expect && argsOk,
    ...(argsOk ? {} : { note: `expected args ${JSON.stringify(probe.args)}` }),
  };
}

export async function runAudit(options: {
  probes: string;
  module: string;
  json?: boolean;
  quiet?: boolean;
}): Promise<number> {
  const probes = (await loadProbes(options.probes)).filter((probe) => probe.expect);
  if (probes.length === 0) {
    process.stderr.write(`${options.probes}: no probes with an "expect" field\n`);
    return 2;
  }
  const module = await loadAgentModule(options.module);
  const rows: AuditRow[] = [];
  for (const probe of probes) rows.push(await runProbe(module, probe));

  const passed = rows.filter((row) => row.ok).length;
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ passed, total: rows.length, rows }, null, 2)}\n`);
    return passed === rows.length ? 0 : 1;
  }
  if (!options.quiet) {
    for (const row of rows.filter((entry) => !entry.ok)) {
      process.stdout.write(`FAIL  "${row.question}"\n`);
      process.stdout.write(`  expected ${row.expect}\n`);
      process.stdout.write(`  got      ${row.got ?? '(prose)'}${row.note ? `  ${row.note}` : ''}\n\n`);
    }
  }
  process.stdout.write(`PASS ${passed}/${rows.length}\n`);
  return passed === rows.length ? 0 : 1;
}
