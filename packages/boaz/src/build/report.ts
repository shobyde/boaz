import { CODE_INDEX, DIAGNOSTIC_CODES } from './codes.js';
import type { Diagnostic, ExtractResult } from './extract.js';

export interface FormatOptions {
  color?: boolean;
  cwd?: string;
}

export function colorize(enabled: boolean): (text: string, code: string) => string {
  return (text, code) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);
}

export function formatDiagnostic(diagnostic: Diagnostic, options: FormatOptions = {}): string {
  const paint = colorize(options.color ?? false);
  const severity =
    diagnostic.severity === 'error' ? paint('error', '31') : paint('warning', '33');
  const code = paint(diagnostic.code, diagnostic.severity === 'error' ? '31' : '33');
  const where = diagnostic.file
    ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ''}`
    : '(project)';
  return `${where}  ${severity}  ${code}  ${diagnostic.message}`;
}

export function formatSummary(result: ExtractResult, options: FormatOptions = {}): string {
  const paint = colorize(options.color ?? false);
  const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = result.diagnostics.length - errors;
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const head = `${count(result.capabilities.length, 'capability', 'capabilities')} · ${count(
    result.routes.length,
    'route',
    'routes',
  )} · ${count(result.files.length, 'file', 'files')} scanned`;
  const verdict =
    errors > 0
      ? paint(`${errors} error${errors === 1 ? '' : 's'}`, '31') +
        (warnings ? `, ${paint(`${warnings} warning${warnings === 1 ? '' : 's'}`, '33')}` : '')
      : warnings > 0
        ? paint(`${warnings} warning${warnings === 1 ? '' : 's'}`, '33')
        : paint('clean', '32');
  return `${head}\n${verdict}`;
}

export function printCodes(): string {
  const lines = DIAGNOSTIC_CODES.map((entry) => {
    const severity = entry.severity === 'error' ? 'error  ' : 'warning';
    return `${entry.code}  ${severity}  ${entry.title}\n              ${entry.detail}`;
  });
  return `boaz diagnostic codes\n\n${lines.join('\n')}`;
}

export function describeCode(code: string): string | undefined {
  const entry = CODE_INDEX[code];
  return entry ? `${entry.code} (${entry.severity}): ${entry.title}\n${entry.detail}` : undefined;
}
