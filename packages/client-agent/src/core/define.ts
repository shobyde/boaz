import type { CapabilityDeclaration, CapabilityKind, JSONSchemaObject } from './types.js';
import { unsupportedKeywords } from './schema.js';

export class CapabilityDefinitionError extends Error {
  constructor(
    message: string,
    readonly capabilityId?: string,
  ) {
    super(message);
    this.name = 'CapabilityDefinitionError';
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const KINDS: CapabilityKind[] = ['route', 'action', 'query'];

/**
 * Declares a navigable destination or an executable client action.
 *
 * Fails fast on the mistakes the build-time verifier would otherwise report
 * later: a missing id, a description written for developers, a route
 * capability with no route, or an action that cannot run because no handler
 * was attached.
 */
export function defineCapability<TParams = Record<string, unknown>, TResult = unknown>(
  declaration: CapabilityDeclaration<TParams, TResult>,
): CapabilityDeclaration<TParams, TResult> {
  const problems: string[] = [];
  const id = declaration.id;

  if (!id || !ID_PATTERN.test(id)) {
    problems.push(`id "${id}" must be lowercase and match ${ID_PATTERN}`);
  }
  if (!KINDS.includes(declaration.kind)) {
    problems.push(`kind must be one of ${KINDS.join(', ')}`);
  }
  if (!declaration.title || declaration.title.trim().length < 3) {
    problems.push('title must be a short human-readable label');
  }
  if (!declaration.description || declaration.description.trim().length < 12) {
    problems.push(
      'description must be at least 12 characters and written from the user perspective',
    );
  }
  if (declaration.kind === 'route' && !declaration.route) {
    problems.push('kind "route" requires a route path');
  }
  if (declaration.kind !== 'route' && typeof declaration.handler !== 'function') {
    problems.push(`kind "${declaration.kind}" requires a handler function`);
  }
  if (declaration.kind === 'route' && declaration.route && !declaration.route.startsWith('/')) {
    problems.push(`route "${declaration.route}" must start with "/"`);
  }

  if (problems.length > 0) {
    throw new CapabilityDefinitionError(
      `Invalid capability${id ? ` "${id}"` : ''}:\n  - ${problems.join('\n  - ')}`,
      id,
    );
  }

  const unsupported = unsupportedKeywords(declaration.paramsSchema);
  if (unsupported.length > 0) {
    // Not fatal: the schema is still usable, but the runtime cannot enforce
    // these keywords, so say so loudly instead of silently weakening the gate.
    console.warn(
      `[client-agent] capability "${id}" uses schema keywords the runtime does not enforce: ${unsupported.join(', ')}. ` +
        `Arguments matching them will not be rejected.`,
    );
  }

  return declaration;
}

/** Strips the handler so the same declaration can be serialised into a manifest. */
export function toManifestCapability(declaration: CapabilityDeclaration): Omit<
  CapabilityDeclaration,
  'handler'
> {
  const { handler: _handler, ...rest } = declaration;
  return rest;
}

export function normalizeSchema(schema: JSONSchemaObject | undefined): JSONSchemaObject | undefined {
  return schema;
}
