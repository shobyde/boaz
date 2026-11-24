import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { buildManifest, extractCapabilities, scanSource } from '../src/build/extract.js';
import { createMatcher } from '../src/build/glob.js';

const fixtures = path.resolve(import.meta.dirname, '../../../fixtures/selfcheck');

describe('glob matcher', () => {
  it('matches the patterns build tools actually use', () => {
    const matcher = createMatcher(['src/**/*.{ts,tsx}']);
    expect(matcher.test('src/App.tsx')).toBe(true);
    expect(matcher.test('src/features/billing/capabilities.ts')).toBe(true);
    expect(matcher.test('src/styles.css')).toBe(false);
    expect(matcher.test('other/App.tsx')).toBe(false);
  });

  it('honours a single-star segment and ?', () => {
    const matcher = createMatcher(['src/*/cap.ts', 'a?c.ts']);
    expect(matcher.test('src/billing/cap.ts')).toBe(true);
    expect(matcher.test('src/billing/nested/cap.ts')).toBe(false);
    expect(matcher.test('abc.ts')).toBe(true);
  });

  it('excludes build output', () => {
    const exclude = createMatcher(['**/node_modules/**', '**/dist/**']);
    expect(exclude.test('node_modules/x/index.ts')).toBe(true);
    expect(exclude.test('src/dist/x.ts')).toBe(true);
    expect(exclude.test('src/app.ts')).toBe(false);
  });
});

describe('scanSource', () => {
  it('extracts metadata and omits the handler body', () => {
    const scanned = scanSource(
      `import { defineCapability } from '@shobyde/boaz/core';
       const STATUSES = ['paid', 'open'] as const;
       export const cap = defineCapability({
         id: 'billing.filter',
         kind: 'action',
         title: 'Filter invoices',
         description: 'Filters the invoice table by payment status.',
         keywords: ['filter', ...STATUSES],
         route: '/settings/billing',
         paramsSchema: { type: 'object', properties: { status: { type: 'string', enum: [...STATUSES] } }, required: ['status'], additionalProperties: false },
         handler: async ({ status }) => ({ status }),
       });`,
      'src/capabilities.ts',
    );
    expect(scanned.diagnostics).toEqual([]);
    expect(scanned.capabilities).toHaveLength(1);
    const [capability] = scanned.capabilities;
    expect(capability).toMatchObject({
      id: 'billing.filter',
      kind: 'action',
      route: '/settings/billing',
      hasHandler: true,
    });
    expect(capability?.keywords).toEqual(['filter', 'paid', 'open']);
    expect(capability).not.toHaveProperty('handler');
  });

  it('follows an import alias for defineCapability', () => {
    const scanned = scanSource(
      `import { defineCapability as cap } from '@shobyde/boaz/core';
       export const c = cap({ id: 'a.b', kind: 'route', title: 'A B', description: 'Opens the A page so the visitor can see B.', route: '/b' });`,
      'src/a.ts',
    );
    expect(scanned.capabilities).toHaveLength(1);
    expect(scanned.capabilities[0]?.id).toBe('a.b');
  });

  it('accepts hash routes, which single-page sites need', () => {
    const scanned = scanSource(
      `import { defineCapability } from '@shobyde/boaz/core';
       export const c = defineCapability({ id: 'site.projects', kind: 'route', title: 'Projects', description: 'Takes the visitor to the projects section of the page.', route: '#projects' });`,
      'src/a.js',
    );
    expect(scanned.diagnostics).toEqual([]);
    expect(scanned.capabilities[0]?.route).toBe('#projects');
  });

  it('reports declarations that cannot be read statically', () => {
    const scanned = scanSource(
      `import { defineCapability } from '@shobyde/boaz/core';
       import { ROUTES } from './routes';
       export const c = defineCapability({ id: 'a.b', kind: 'route', title: 'A B', description: 'Opens the A page so the visitor can see B.', route: ROUTES.b });`,
      'src/a.ts',
    );
    expect(scanned.capabilities).toHaveLength(0);
    expect(scanned.diagnostics[0]?.code).toBe('CAP006');
  });

  it('extracts defineKnowledge declarations as knowledge capabilities', () => {
    const scanned = scanSource(
      `import { defineKnowledge } from '@shobyde/boaz/core';
       export const fact = defineKnowledge({
         id: 'knowledge.skills',
         title: 'Skills',
         description: 'The languages and tools Sho works in day to day.',
         knowledge: 'Sho writes TypeScript, React and Python.',
       });`,
      'src/a.ts',
    );
    expect(scanned.diagnostics).toEqual([]);
    expect(scanned.capabilities[0]).toMatchObject({
      id: 'knowledge.skills',
      kind: 'knowledge',
      knowledge: 'Sho writes TypeScript, React and Python.',
      hasHandler: false,
    });
  });

  it('follows an import alias for defineKnowledge', () => {
    const scanned = scanSource(
      `import { defineKnowledge as fact } from '@shobyde/boaz/core';
       export const c = fact({ id: 'k.a', title: 'A fact', description: 'Something true about this page.', knowledge: 'A is true.' });`,
      'src/a.ts',
    );
    expect(scanned.diagnostics).toEqual([]);
    expect(scanned.capabilities[0]?.kind).toBe('knowledge');
  });

  it('keeps defineCapability defaulting to action', () => {
    const scanned = scanSource(
      `import { defineCapability } from '@shobyde/boaz/core';
       export const c = defineCapability({ id: 'a.b', title: 'Do a thing', description: 'Does the thing the visitor asked for.', handler: () => true });`,
      'src/a.ts',
    );
    expect(scanned.diagnostics).toEqual([]);
    expect(scanned.capabilities[0]?.kind).toBe('action');
  });

  it('folds string concatenation in metadata', () => {
    const scanned = scanSource(
      `import { defineKnowledge } from '@shobyde/boaz/core';
       export const fact = defineKnowledge({
         id: 'k.prose',
         title: 'Prose',
         description: 'A description wrapped across two source lines for width.',
         knowledge: 'First sentence of the fact. ' +
           'Second sentence of the same fact.',
       });`,
      'src/a.ts',
    );
    expect(scanned.diagnostics).toEqual([]);
    expect(scanned.capabilities[0]?.knowledge).toBe('First sentence of the fact. Second sentence of the same fact.');
  });

  it('collects router paths from JSX and router configs', () => {
    const scanned = scanSource(
      `export const routes = [
         { path: '/reports', element: null },
         { path: '/reports/:id', element: null },
       ];
       export function A() { return <Route path="/settings" element={null} />; }`,
      'src/router.tsx',
    );
    expect(scanned.routes.map((route) => route.path)).toEqual(['/reports', '/reports/:id', '/settings']);
  });
});

describe('extractCapabilities on the fixture corpus', () => {
  it('finds no diagnostics in the clean fixture and produces a sorted manifest', async () => {
    const result = await extractCapabilities({ root: path.join(fixtures, 'clean-basic'), include: [] });
    expect(result.diagnostics).toEqual([]);
    const manifest = buildManifest(result.capabilities);
    expect(manifest.capabilities.map((capability) => capability.id)).toEqual([
      'account.delete',
      'account.navigate',
      'billing.filter_invoices',
      'billing.navigate',
      'blog.open_archive',
      'home.navigate',
    ]);
    const filter = manifest.capabilities.find((c) => c.id === 'billing.filter_invoices');
    expect(filter?.paramsSchema).toBeDefined();
    expect(JSON.stringify(manifest)).not.toContain('handler');
  });

  it('reports an undeclared router path', async () => {
    const result = await extractCapabilities({ root: path.join(fixtures, 'undeclared-route'), include: [] });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['CAP008']);
    expect(result.diagnostics[0]?.message).toContain('/invoices');
  });

  it('reports duplicate ids', async () => {
    const result = await extractCapabilities({ root: path.join(fixtures, 'duplicate-id'), include: [] });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('CAP001');
  });

  it('is deterministic: two runs produce identical manifests', async () => {
    const a = await extractCapabilities({ root: path.join(fixtures, 'clean-basic'), include: [] });
    const b = await extractCapabilities({ root: path.join(fixtures, 'clean-basic'), include: [] });
    expect(JSON.stringify(buildManifest(a.capabilities))).toBe(JSON.stringify(buildManifest(b.capabilities)));
  });
});
