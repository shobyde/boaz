#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, extractCapabilities, type ExtractResult } from '../build/extract.js';
import { formatDiagnostic, formatSummary, printCodes } from '../build/report.js';
import { CLIENT_LLM_SKILL_MD } from './skill-template.js';

type FlagValue = string | true | string[];

interface Args {
  command: string;
  positionals: string[];
  flags: Map<string, FlagValue>;
}

const HELP = `client-agent — declarative UI capabilities for an in-browser assistant

Usage
  client-agent verify [dir] [--strict] [--json] [--include <glob>] [--exclude <glob>]
  client-agent manifest [dir] [--out <file>] [--check] [--include <glob>]
  client-agent codes [CODE]
  client-agent init [dir] --skill [--force]
  client-agent verify --self-check <fixtures-dir>

Commands
  verify     Scan source for defineCapability() declarations and report problems.
             Exit 1 when an error is found, or any warning with --strict.
  manifest   Write agent-manifest.json (deterministic: sorted by id, no timestamp).
             --check compares against the file on disk instead of writing.
  codes      Print the diagnostic code table, or the detail for one code.
  init       Install the repository skill that keeps capabilities in sync.

Options
  --include <glob>   Source glob, relative to dir. Repeatable. Default src/**/*.{ts,tsx,js,jsx}
  --exclude <glob>   Exclude glob. Repeatable.
  --json             Machine-readable output for verify.
  --strict           Treat warnings as failures.
  --self-check <dir> Run every fixture in <dir> and compare against expected-codes.json.
`;

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, FlagValue>();
  const positionals: string[] = [];
  const takesValue = new Set(['include', 'exclude', 'out', 'self-check']);
  const setFlag = (key: string, value: FlagValue) => {
    if (Array.isArray(value) || value === true) {
      flags.set(key, value);
      return;
    }
    const existing = flags.get(key);
    if (typeof existing === 'string') flags.set(key, [existing, value]);
    else if (Array.isArray(existing)) existing.push(value);
    else flags.set(key, value);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const [key, inline] = name.split('=');
      if (inline !== undefined) {
        setFlag(key ?? name, inline);
      } else if (key && takesValue.has(key)) {
        const value = argv[i + 1];
        if (value === undefined) throw new Error(`--${key} needs a value`);
        setFlag(key, value);
        i += 1;
      } else if (key) {
        setFlag(key, true);
      }
    } else if (token.startsWith('-') && token.length > 1) {
      setFlag(token.slice(1), true);
    } else {
      positionals.push(token);
    }
  }
  return { command: positionals.shift() ?? 'help', positionals, flags };
}

function multi(flags: Args['flags'], key: string): string[] {
  const value = flags.get(key);
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  return [];
}

function single(flags: Args['flags'], key: string): string | undefined {
  const values = multi(flags, key);
  return values[values.length - 1];
}

function hasColor(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

async function readVersion(): Promise<string> {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await fs.readFile(path.resolve(here, '../../package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function runExtract(
  dir: string,
  flags: Args['flags'],
): Promise<ExtractResult> {
  const include = multi(flags, 'include');
  const exclude = multi(flags, 'exclude');
  return extractCapabilities({
    root: path.resolve(dir),
    include: include.length > 0 ? include : ['src/**/*.{ts,tsx,js,jsx}'],
    ...(exclude.length > 0 ? { exclude } : {}),
  });
}

async function commandVerify(args: Args): Promise<number> {
  const selfCheckDir = single(args.flags, 'self-check');
  if (selfCheckDir) {
    return runSelfCheck(selfCheckDir);
  }
  const strict = args.flags.has('strict');
  const json = args.flags.has('json');
  const dir = args.positionals[0] ?? '.';
  const result = await runExtract(dir, args.flags);
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  const warnings = result.diagnostics.filter((d) => d.severity === 'warning');

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: errors.length === 0 && (!strict || warnings.length === 0),
          errorCount: errors.length,
          warningCount: warnings.length,
          capabilityCount: result.capabilities.length,
          routeCount: result.routes.length,
          files: result.files,
          diagnostics: result.diagnostics,
        },
        null,
        2,
      )}\n`,
    );
    return errors.length === 0 && (!strict || warnings.length === 0) ? 0 : 1;
  }

  const color = hasColor();
  for (const diagnostic of result.diagnostics) {
    process.stdout.write(`${formatDiagnostic(diagnostic, { color })}\n`);
  }
  if (result.diagnostics.length > 0) process.stdout.write('\n');
  process.stdout.write(`${formatSummary(result, { color })}\n`);

  const failed = errors.length > 0 || (strict && warnings.length > 0);
  if (failed) {
    process.stdout.write(`\nRun \`client-agent codes\` to see what each code means.\n`);
    return 1;
  }
  return 0;
}

async function commandManifest(args: Args): Promise<number> {
  const dir = args.positionals[0] ?? '.';
  const result = await runExtract(dir, args.flags);
  const manifest = buildManifest(result.capabilities);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const outFlag = single(args.flags, 'out');
  const outPath = path.resolve(outFlag ?? path.join(dir, 'agent-manifest.json'));

  if (args.flags.has('check')) {
    let existing = '';
    try {
      existing = await fs.readFile(outPath, 'utf8');
    } catch {
      process.stdout.write(`missing ${outPath}; run \`client-agent manifest\`\n`);
      return 1;
    }
    if (existing !== serialized) {
      process.stdout.write(`${outPath} is out of date; re-run \`client-agent manifest\`\n`);
      return 1;
    }
    process.stdout.write(`${outPath} is up to date (${manifest.capabilities.length} capabilities)\n`);
    return 0;
  }

  await fs.writeFile(outPath, serialized);
  process.stdout.write(
    `wrote ${outPath} (${manifest.capabilities.length} capabilities, ${serialized.length} bytes)\n`,
  );
  if (result.diagnostics.some((d) => d.severity === 'error')) {
    process.stdout.write('warning: manifest written despite errors; run `client-agent verify`\n');
    return 1;
  }
  return 0;
}

interface SelfCheckFixture {
  name: string;
  dir: string;
  expected: string[];
}

async function loadFixtures(root: string): Promise<SelfCheckFixture[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const fixtures: SelfCheckFixture[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let expected: string[] = [];
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, 'expected-codes.json'), 'utf8')) as {
        codes?: string[];
      };
      expected = (raw.codes ?? []).slice().sort();
    } catch {
      continue;
    }
    fixtures.push({ name: entry.name, dir, expected });
  }
  return fixtures.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Each fixture declares the codes it must provoke. A rule that stops firing,
 * or starts firing on clean code, fails here — which is the only thing that
 * keeps a warning table honest.
 */
async function runSelfCheck(root: string): Promise<number> {
  const fixtures = await loadFixtures(path.resolve(root));
  if (fixtures.length === 0) {
    process.stdout.write(`no fixtures with expected-codes.json under ${root}\n`);
    return 1;
  }
  const color = hasColor();
  const paint = (text: string, code: string) => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
  let failures = 0;
  for (const fixture of fixtures) {
    const result = await extractCapabilities({
      root: fixture.dir,
      include: ['src/**/*.{ts,tsx}'],
    });
    const got = [...new Set(result.diagnostics.map((d) => d.code))].sort();
    const missing = fixture.expected.filter((code) => !got.includes(code));
    const unexpected = got.filter((code) => !fixture.expected.includes(code));
    const ok = missing.length === 0 && unexpected.length === 0;
    if (!ok) failures += 1;
    const shown = (codes: string[]) => (codes.length ? codes.join(', ') : '—');
    process.stdout.write(
      `${ok ? paint('PASS', '32') : paint('FAIL', '31')}  ${fixture.name.padEnd(24)} expected ${shown(fixture.expected)}\n`,
    );
    if (!ok) {
      process.stdout.write(`      got      ${shown(got)}\n`);
      if (missing.length) process.stdout.write(`      missing  ${missing.join(', ')}\n`);
      if (unexpected.length) process.stdout.write(`      unexpected ${unexpected.join(', ')}\n`);
      for (const diagnostic of result.diagnostics) {
        process.stdout.write(`      ${formatDiagnostic(diagnostic, { color })}\n`);
      }
    }
  }
  process.stdout.write(
    `\n${fixtures.length - failures}/${fixtures.length} fixtures matched their expected codes\n`,
  );
  return failures === 0 ? 0 : 1;
}

async function commandInit(args: Args): Promise<number> {
  const dir = path.resolve(args.positionals[0] ?? '.');
  if (!args.flags.has('skill')) {
    process.stdout.write('init: pass --skill to write .agent/skills/client-llm-capabilities.md\n');
    return 1;
  }
  const target = path.join(dir, '.agent/skills/client-llm-capabilities.md');
  const exists = await fs
    .access(target)
    .then(() => true)
    .catch(() => false);
  if (exists && !args.flags.has('force')) {
    process.stdout.write(`${target} already exists; pass --force to overwrite\n`);
    return 1;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, CLIENT_LLM_SKILL_MD);
  process.stdout.write(`wrote ${target}\n`);
  process.stdout.write('Next: point your agent loader (AGENTS.md, .cursor/rules, CLAUDE.md) at that file.\n');
  return 0;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }

  switch (args.command) {
    case 'verify':
      return commandVerify(args);
    case 'manifest':
      return commandManifest(args);
    case 'codes': {
      const code = args.positionals[0];
      if (code) {
        const entry = printCodes()
          .split('\n\n')
          .find((block) => block.startsWith(code));
        process.stdout.write(`${entry ?? `unknown code ${code}`}\n`);
        return entry ? 0 : 1;
      }
      process.stdout.write(`${printCodes()}\n`);
      return 0;
    }
    case 'init':
      return commandInit(args);
    case 'version':
      process.stdout.write(`${await readVersion()}\n`);
      return 0;
    case 'help':
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`unknown command "${args.command}"\n\n${HELP}`);
      return 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
