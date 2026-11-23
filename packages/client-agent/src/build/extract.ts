import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { AgentManifest, CapabilityKind, JSONSchemaObject, ManifestCapability } from '../core/types.js';
import { IGNORED_KEYWORDS, unsupportedKeywords } from '../core/schema.js';
import { codeSeverity, type Severity } from './codes.js';
import { createMatcher } from './glob.js';

export interface SourcePosition {
  file: string;
  line: number;
  column: number;
}

export interface StaticCapability extends ManifestCapability {
  hasHandler: boolean;
  source: SourcePosition;
}

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  capabilityId?: string;
}

export interface DiscoveredRoute {
  path: string;
  source: SourcePosition;
}

export interface ExtractOptions {
  /** Directory scanned for source files. */
  root: string;
  /** Glob patterns relative to root. */
  include: string[];
  exclude?: string[];
}

export interface ExtractResult {
  capabilities: StaticCapability[];
  routes: DiscoveredRoute[];
  diagnostics: Diagnostic[];
  files: string[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const KINDS = new Set<CapabilityKind>(['route', 'action', 'query']);
const MUTATING =
  /\b(delete|remove|cancel|pay|purchase|subscribe|unsubscribe|upgrade|downgrade|update|save|clear|reset|archive|revoke|disconnect|transfer|deactivate|close)\b/i;
const DEFAULT_INCLUDE = ['src/**/*.{ts,tsx,js,jsx,mts,mjs}'];
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/*.d.ts', '**/*.test.*', '**/*.spec.*'];

class NotStatic extends Error {}

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNameText(name: ts.PropertyName | ts.BindingName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function literalValue(node: ts.Node): unknown {
  const inner = unwrap(node);
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  if (ts.isNumericLiteral(inner)) return Number(inner.text);
  if (inner.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (inner.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (inner.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.MinusToken) {
    const value = literalValue(inner.operand);
    return typeof value === 'number' ? -value : value;
  }
  if (ts.isIdentifier(inner) && inner.text === 'undefined') return undefined;
  throw new NotStatic(inner.getText());
}

/** Evaluates the literal subset a manifest may contain. */
function evaluate(node: ts.Node, consts: Map<string, ts.Node>): unknown {
  const inner = unwrap(node);

  if (ts.isObjectLiteralExpression(inner)) {
    const result: Record<string, unknown> = {};
    for (const property of inner.properties) {
      if (ts.isPropertyAssignment(property)) {
        const key = propertyNameText(property.name);
        if (!key) throw new NotStatic(`computed property in ${inner.getText().slice(0, 40)}`);
        // The handler is a function; it never enters the manifest and must not
        // be statically evaluated.
        if (key === 'handler') continue;
        result[key] = evaluate(property.initializer, consts);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const key = property.name.text;
        const declaration = consts.get(key);
        if (!declaration) throw new NotStatic(`identifier "${key}" has no static initializer`);
        result[key] = evaluate(declaration, consts);
      } else if (ts.isSpreadAssignment(property)) {
        const spread = evaluate(property.expression, consts);
        if (spread === null || typeof spread !== 'object' || Array.isArray(spread)) {
          throw new NotStatic('spread of a non-object literal');
        }
        Object.assign(result, spread);
      } else {
        throw new NotStatic(`unsupported member "${property.getText().slice(0, 30)}"`);
      }
    }
    return result;
  }

  if (ts.isArrayLiteralExpression(inner)) {
    return inner.elements.map((element) => {
      if (ts.isSpreadElement(element)) {
        const spread = evaluate(element.expression, consts);
        if (!Array.isArray(spread)) throw new NotStatic('spread of a non-array literal');
        return spread;
      }
      return evaluate(element, consts);
    }).flat() as unknown[];
  }

  if (ts.isIdentifier(inner)) {
    const declaration = consts.get(inner.text);
    if (!declaration) throw new NotStatic(`identifier "${inner.text}" is not a local constant`);
    return evaluate(declaration, consts);
  }

  if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === 'Object.freeze') {
    const [argument] = inner.arguments;
    if (!argument) throw new NotStatic('Object.freeze() without an argument');
    return evaluate(argument, consts);
  }

  return literalValue(inner);
}

function collectConstants(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const consts = new Map<string, ts.Node>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (!consts.has(node.name.text)) consts.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return consts;
}

function collectDefinitionNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const bindings = statement.importClause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === 'defineCapability') names.add(element.name.text);
    }
  }
  return names;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node, file: string): SourcePosition {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file, line: line + 1, column: character + 1 };
}

function validateSchema(schema: unknown, diagnostic: (d: Diagnostic) => void, position: SourcePosition): JSONSchemaObject | undefined {
  if (schema === undefined) return undefined;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    diagnostic({
      code: 'CAP004',
      severity: 'error',
      message: 'paramsSchema must be an object',
      file: position.file,
      line: position.line,
    });
    return undefined;
  }
  const record = schema as Record<string, unknown>;
  if (record.properties !== undefined) {
    const properties = record.properties;
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
      diagnostic({
        code: 'CAP004',
        severity: 'error',
        message: 'paramsSchema.properties must be an object',
        file: position.file,
        line: position.line,
      });
    } else {
      for (const [name, value] of Object.entries(properties as Record<string, unknown>)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          diagnostic({
            code: 'CAP004',
            severity: 'error',
            message: `paramsSchema.properties.${name} must be a schema object`,
            file: position.file,
            line: position.line,
          });
        }
      }
    }
  }
  if (record.required !== undefined) {
    const required = record.required;
    if (!Array.isArray(required) || required.some((value) => typeof value !== 'string')) {
      diagnostic({
        code: 'CAP004',
        severity: 'error',
        message: 'paramsSchema.required must be an array of strings',
        file: position.file,
        line: position.line,
      });
    }
  }
  const unsupported = unsupportedKeywords(record as JSONSchemaObject).filter(
    (keyword) => !IGNORED_KEYWORDS.has(keyword.split('.').pop() ?? keyword),
  );
  if (unsupported.length > 0) {
    diagnostic({
      code: 'CAP005',
      severity: 'warning',
      message: `schema keywords the runtime cannot enforce: ${unsupported.join(', ')}`,
      file: position.file,
      line: position.line,
    });
  }
  return record as JSONSchemaObject;
}

function validateMetadata(
  capability: Record<string, unknown>,
  position: SourcePosition,
  diagnostic: (d: Diagnostic) => void,
): void {
  const id = typeof capability.id === 'string' ? capability.id : '';
  const at = { file: position.file, line: position.line, capabilityId: id || undefined };
  if (!id || !ID_PATTERN.test(id)) {
    diagnostic({ code: 'CAP009', severity: 'error', message: `invalid capability id ${JSON.stringify(capability.id ?? null)}`, ...at });
  }
  const kind = capability.kind;
  if (typeof kind !== 'string' || !KINDS.has(kind as CapabilityKind)) {
    diagnostic({ code: 'CAP009', severity: 'error', message: `kind must be route, action or query (got ${JSON.stringify(kind ?? null)})`, ...at });
  }
  const title = typeof capability.title === 'string' ? capability.title.trim() : '';
  const description = typeof capability.description === 'string' ? capability.description.trim() : '';
  if (title.length < 3) {
    diagnostic({ code: 'CAP002', severity: 'error', message: 'title must be at least 3 characters', ...at });
  }
  if (description.length < 12) {
    diagnostic({ code: 'CAP002', severity: 'error', message: 'description must be at least 12 characters and written for the visitor', ...at });
  }
  if (kind === 'route') {
    const route = capability.route;
    if (typeof route !== 'string' || !/^[/#]/.test(route)) {
      diagnostic({ code: 'CAP003', severity: 'error', message: 'route capability needs a path starting with "/" or a hash like "#projects"', ...at });
    }
  }
  if (kind === 'action' && capability.requiresConfirmation !== true) {
    const text = `${id} ${title} ${description}`;
    if (MUTATING.test(text)) {
      diagnostic({
        code: 'CAP007',
        severity: 'warning',
        message: 'action sounds like it mutates state; set requiresConfirmation: true unless it is reversible and cheap',
        ...at,
      });
    }
  }
}

export function scanSource(text: string, fileName: string): {
  capabilities: StaticCapability[];
  routes: DiscoveredRoute[];
  diagnostics: Diagnostic[];
} {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.ES2022,
    true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const consts = collectConstants(sourceFile);
  const definitionNames = collectDefinitionNames(sourceFile);
  const capabilities: StaticCapability[] = [];
  const routes: DiscoveredRoute[] = [];
  const diagnostics: Diagnostic[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && definitionNames.has(node.expression.text)) {
      const position = lineOf(sourceFile, node, fileName);
      const [argument] = node.arguments;
      try {
        if (!argument) throw new NotStatic('defineCapability() called without an argument');
        const value = evaluate(argument, consts);
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new NotStatic('argument is not an object literal');
        }
        const record = value as Record<string, unknown>;
        const objectNode = unwrap(argument);
        const hasHandler =
          ts.isObjectLiteralExpression(objectNode) &&
          objectNode.properties.some((property) => {
            if (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
              return propertyNameText(property.name) === 'handler';
            }
            return ts.isShorthandPropertyAssignment(property) && property.name.text === 'handler';
          });
        const paramsSchema = validateSchema(record.paramsSchema, (d) => diagnostics.push(d), position);
        validateMetadata({ ...record, paramsSchema }, position, (d) => diagnostics.push(d));

        const manifestCapability: ManifestCapability = {
          id: typeof record.id === 'string' ? record.id : '',
          kind: (record.kind as CapabilityKind) ?? 'action',
          title: typeof record.title === 'string' ? record.title : '',
          description: typeof record.description === 'string' ? record.description : '',
        };
        if (Array.isArray(record.keywords)) {
          manifestCapability.keywords = record.keywords.filter((k): k is string => typeof k === 'string');
        }
        if (typeof record.route === 'string') manifestCapability.route = record.route;
        if (paramsSchema) manifestCapability.paramsSchema = paramsSchema;
        if (record.requiresConfirmation === true) manifestCapability.requiresConfirmation = true;
        capabilities.push({ ...manifestCapability, hasHandler, source: position });
      } catch (error) {
        if (error instanceof NotStatic) {
          diagnostics.push({
            code: 'CAP006',
            severity: 'error',
            message: `cannot read this declaration statically (${error.message.slice(0, 80)}); keep the metadata a literal so the manifest can be built`,
            file: fileName,
            line: position.line,
          });
        } else {
          throw error;
        }
      }
    }

    // Router paths: <Route path="/x"> and { path: '/x' } in router configs.
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile);
      if (name === 'path' && node.initializer && ts.isStringLiteral(node.initializer)) {
        const value = node.initializer.text;
        if (value.startsWith('/')) routes.push({ path: value, source: lineOf(sourceFile, node, fileName) });
      }
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'path') {
      const initializer = unwrap(node.initializer);
      if (ts.isStringLiteral(initializer) && initializer.text.startsWith('/')) {
        routes.push({ path: initializer.text, source: lineOf(sourceFile, node, fileName) });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { capabilities, routes, diagnostics };
}

function normalizeRoute(route: string): string {
  if (route.length > 1 && route.endsWith('/')) return route.slice(0, -1);
  return route;
}

function isRouteCovered(route: string, capabilities: StaticCapability[]): boolean {
  const wanted = normalizeRoute(route);
  for (const capability of capabilities) {
    if (capability.kind !== 'route' || !capability.route) continue;
    const declared = normalizeRoute(capability.route);
    if (declared === wanted) return true;
    // A parent declaration covers nested destinations: "/settings" covers
    // "/settings/billing" for guidance purposes.
    if (wanted.startsWith(`${declared}/`)) return true;
    // And a declared child justifies its router parent: a capability for
    // "/settings/account" means the "/settings" layout route is navigable.
    if (declared.startsWith(`${wanted}/`)) return true;
  }
  return false;
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, out);
    } else {
      out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
}

export async function extractCapabilities(options: ExtractOptions): Promise<ExtractResult> {
  const root = path.resolve(options.root);
  const include = options.include.length > 0 ? options.include : DEFAULT_INCLUDE;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;
  const isIncluded = createMatcher(include);
  const isExcluded = createMatcher(exclude);

  const all: string[] = [];
  await walk(root, root, all);
  const files = all
    .filter((file) => isIncluded.test(file) && !isExcluded.test(file))
    .filter((file) => /\.(ts|tsx|js|jsx|mts|mjs)$/.test(file))
    .sort();

  const capabilities: StaticCapability[] = [];
  const routes: DiscoveredRoute[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const file of files) {
    const text = await fs.readFile(path.join(root, file), 'utf8');
    const scanned = scanSource(text, file);
    capabilities.push(...scanned.capabilities);
    routes.push(...scanned.routes);
    diagnostics.push(...scanned.diagnostics);
  }

  const seenIds = new Map<string, StaticCapability>();
  for (const capability of capabilities) {
    const previous = seenIds.get(capability.id);
    if (previous) {
      diagnostics.push({
        code: 'CAP001',
        severity: 'error',
        message: `duplicate id "${capability.id}" (first declared at ${previous.source.file}:${previous.source.line})`,
        file: capability.source.file,
        line: capability.source.line,
        capabilityId: capability.id,
      });
    } else {
      seenIds.set(capability.id, capability);
    }
  }

  const routeOwners = new Map<string, StaticCapability>();
  for (const capability of capabilities) {
    if (capability.kind !== 'route' || !capability.route) continue;
    const route = normalizeRoute(capability.route);
    const previous = routeOwners.get(route);
    if (previous && previous.id !== capability.id) {
      diagnostics.push({
        code: 'CAP010',
        severity: 'warning',
        message: `route "${route}" is claimed by "${previous.id}" and "${capability.id}"`,
        file: capability.source.file,
        line: capability.source.line,
        capabilityId: capability.id,
      });
    } else {
      routeOwners.set(route, capability);
    }
  }

  for (const route of routes) {
    if (!isRouteCovered(route.path, capabilities)) {
      diagnostics.push({
        code: 'CAP008',
        severity: 'warning',
        message: `route "${route.path}" has no route capability; the assistant cannot guide anyone there`,
        file: route.source.file,
        line: route.source.line,
      });
    }
  }

  diagnostics.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    if ((a.file ?? '') !== (b.file ?? '')) return (a.file ?? '').localeCompare(b.file ?? '');
    return (a.line ?? 0) - (b.line ?? 0);
  });

  return { capabilities, routes, diagnostics, files };
}

export function buildManifest(capabilities: StaticCapability[]): AgentManifest {
  const unique = new Map<string, StaticCapability>();
  for (const capability of capabilities) {
    if (!unique.has(capability.id)) unique.set(capability.id, capability);
  }
  const sorted = [...unique.values()]
    .map(({ hasHandler: _h, source: _s, ...rest }) => rest)
    .sort((a, b) => a.id.localeCompare(b.id));
  return { version: 1, capabilities: sorted };
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => (d.severity ?? codeSeverity(d.code)) === 'error');
}
