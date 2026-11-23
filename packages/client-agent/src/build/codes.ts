export type Severity = 'error' | 'warning';

export interface DiagnosticCode {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
}

/**
 * The diagnostic contract. Codes are stable: they appear in CI output, in
 * `client-agent verify --json`, and in the self-check corpus, so a rule can be
 * referenced without pasting prose.
 */
export const DIAGNOSTIC_CODES: DiagnosticCode[] = [
  {
    code: 'CAP001',
    severity: 'error',
    title: 'Duplicate capability id',
    detail: 'Two declarations share an id; only one handler can win at runtime.',
  },
  {
    code: 'CAP002',
    severity: 'error',
    title: 'Missing or unusable title/description',
    detail: 'Both are required. The description is the retrieval text, so a placeholder makes the capability unfindable.',
  },
  {
    code: 'CAP003',
    severity: 'error',
    title: 'Route capability without a usable route',
    detail: 'kind "route" needs a route string starting with "/".',
  },
  {
    code: 'CAP004',
    severity: 'error',
    title: 'Invalid paramsSchema structure',
    detail: 'paramsSchema must be an object with object properties and a string[] required array.',
  },
  {
    code: 'CAP005',
    severity: 'warning',
    title: 'Schema keyword the runtime does not enforce',
    detail: 'The model is told the constraint but the validator will not reject a violation.',
  },
  {
    code: 'CAP006',
    severity: 'error',
    title: 'Declaration is not statically evaluable',
    detail: 'Manifest metadata must be a literal: no function calls, imports, or computed keys.',
  },
  {
    code: 'CAP007',
    severity: 'warning',
    title: 'Side-effecting action without confirmation',
    detail: 'A mutating verb appears in the id or description but requiresConfirmation is not set.',
  },
  {
    code: 'CAP008',
    severity: 'warning',
    title: 'Route in the app with no route capability',
    detail: 'Heuristic: a static path string was found in a router file and no route capability covers it.',
  },
  {
    code: 'CAP009',
    severity: 'error',
    title: 'Invalid id or kind',
    detail: 'Ids are lowercase (a-z, 0-9, ".", "_", "-"); kind is route, action or query.',
  },
  {
    code: 'CAP010',
    severity: 'warning',
    title: 'Two capabilities claim the same route',
    detail: 'The assistant cannot tell which one to navigate to.',
  },
];

export const CODE_INDEX: Record<string, DiagnosticCode> = Object.fromEntries(
  DIAGNOSTIC_CODES.map((entry) => [entry.code, entry]),
);

export function codeSeverity(code: string): Severity {
  return CODE_INDEX[code]?.severity ?? 'error';
}
