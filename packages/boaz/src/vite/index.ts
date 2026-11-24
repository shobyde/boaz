import fs from 'node:fs/promises';
import path from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { buildManifest, extractCapabilities, hasErrors, type ExtractResult } from '../build/extract.js';
import { formatDiagnostic, formatSummary } from '../build/report.js';

export interface BoazPluginOptions {
  /** Glob patterns relative to the Vite root. Defaults to src/**\/*.{ts,tsx,js,jsx}. */
  include?: string[];
  exclude?: string[];
  /** Asset name inside the build output. Default "agent-manifest.json". */
  fileName?: string;
  /** Where to write the manifest during dev, relative to root. false disables. */
  devFile?: string | false;
  /** Fail the build when an error diagnostic is present. Default true. */
  failOnError?: boolean;
  /** Virtual module exposing the manifest. false disables. */
  virtualModule?: string | false;
  /** Print a warning table to the terminal. Default true. */
  report?: boolean;
  /** Directory scanned for source. Defaults to the Vite root. */
  sourceRoot?: string;
}

const DEFAULT_VIRTUAL = 'boaz:manifest';

/**
 * Build-time crawler: finds `defineCapability({...})` declarations with the
 * TypeScript AST, emits `agent-manifest.json`, and exposes it as a virtual
 * module so the app never keeps a second copy of its own capability list.
 */
export function boaz(options: BoazPluginOptions = {}): Plugin {
  const virtualId = options.virtualModule === false ? undefined : (options.virtualModule ?? DEFAULT_VIRTUAL);
  const resolvedVirtual = virtualId ? `\0${virtualId}` : undefined;
  const fileName = options.fileName ?? 'agent-manifest.json';
  const failOnError = options.failOnError ?? true;
  const report = options.report ?? true;

  let config: ResolvedConfig;
  let lastResult: ExtractResult | undefined;
  let manifestJson = '{"version":1,"capabilities":[]}';
  let devFilePath: string | undefined;

  const scan = async (): Promise<ExtractResult> => {
    const root = path.resolve(config.root, options.sourceRoot ?? '.');
    const result = await extractCapabilities({
      root,
      include: options.include ?? ['src/**/*.{ts,tsx,js,jsx}'],
      ...(options.exclude ? { exclude: options.exclude } : {}),
    });
    lastResult = result;
    manifestJson = JSON.stringify(buildManifest(result.capabilities));
    const target = devFilePath;
    if (target) {
      await fs
        .mkdir(path.dirname(target), { recursive: true })
        .then(() => fs.writeFile(target, manifestJson))
        .catch(() => undefined);
    }
    return result;
  };

  return {
    name: '@shobyde/boaz',
    enforce: 'pre',

    configResolved(resolved) {
      config = resolved;
    },

    async buildStart() {
      const result = await scan();
      if (report) {
        const color = Boolean(process.stdout.isTTY);
        for (const diagnostic of result.diagnostics) {
          const line = formatDiagnostic(diagnostic, { color });
          if (diagnostic.severity === 'error') this.error(line);
          else this.warn(line);
        }
        this.info(`[boaz] ${formatSummary(result, { color }).split('\n').join(' — ')}`);
      } else if (failOnError && hasErrors(result.diagnostics)) {
        this.error('boaz: capability errors found (re-run with report enabled for details)');
      }
    },

    resolveId(id) {
      if (resolvedVirtual && id === virtualId) return resolvedVirtual;
      return null;
    },

    load(id) {
      if (resolvedVirtual && id === resolvedVirtual) {
        return `export default ${manifestJson};`;
      }
      return null;
    },

    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName,
        source: manifestJson,
      });
    },

    configureServer(server) {
      if (options.devFile !== false) {
        devFilePath = path.resolve(config.root, options.devFile ?? '.boaz/agent-manifest.json');
        // Write once the first scan has produced real metadata, not the empty
        // placeholder from module load time.
        void scan().catch(() => undefined);
      }
      const watched = path.resolve(config.root, options.sourceRoot ?? '.');
      server.watcher.add(watched);
      const refresh = async (file: string) => {
        if (!/\.(ts|tsx|js|jsx)$/.test(file)) return;
        const result = await scan();
        for (const diagnostic of result.diagnostics) {
          if (diagnostic.severity === 'error') server.config.logger.error(formatDiagnostic(diagnostic));
        }
        const mod = server.moduleGraph.getModuleById(resolvedVirtual ?? '');
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload' });
      };
      const onChange = (file: string) => {
        void refresh(file);
      };
      server.watcher.on('add', onChange);
      server.watcher.on('change', onChange);
      server.watcher.on('unlink', onChange);
    },
  };
}

export default boaz;
