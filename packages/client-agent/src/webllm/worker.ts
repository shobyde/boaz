/**
 * Web Worker entry point. All WebGPU work happens here so the host app's
 * rendering thread never blocks. Instantiate it with:
 *
 *   new Worker(new URL('client-agent/webllm/worker', import.meta.url), { type: 'module' })
 */

declare const self: {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

export interface WorkerMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type WorkerRequest =
  | {
      type: 'init';
      model: string;
      temperature?: number;
      maxTokens?: number;
      /** Self-hosted weight directory base, replacing huggingface.co. */
      modelBase?: string;
      /** Self-hosted `.wasm` base, replacing the upstream library host. */
      modelLibBase?: string;
      /** Cache API (default) or IndexedDB, per WebLLM's AppConfig. */
      cacheBackend?: 'cache' | 'indexeddb';
    }
  | {
      type: 'complete';
      id: number;
      messages: WorkerMessage[];
    }
  | { type: 'dispose' };

export type WorkerResponse =
  | { type: 'progress'; progress: number; text: string }
  | { type: 'ready'; model: string }
  | { type: 'complete'; id: number; text: string }
  | { type: 'error'; id?: number; message: string };

interface ChatEngine {
  chat: {
    completions: {
      create(request: Record<string, unknown>): Promise<{
        choices: Array<{ message?: { content?: string } }>;
      }>;
    };
  };
  unload?: () => Promise<void>;
}

let engine: ChatEngine | undefined;
let loadedModel: string | undefined;
let temperature = 0.2;
let maxTokens = 320;
let loading: Promise<ChatEngine> | undefined;

import { buildModelRecord, configUrl, type ModelRecordLike, type WeightHosts } from './records.js';

/**
 * A blocked or throttled model host looks exactly like a slow download: no
 * progress, no error, forever. One small request with a deadline turns that
 * into a sentence the UI can show.
 */
async function probeHost(url: string, timeoutMs = 10000): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Opaque on purpose: this proves the request completes, not that the
    // artifact exists. A CORS failure would otherwise look like a dead host.
    await fetch(url, { signal: controller.signal, cache: 'no-store', mode: 'no-cors' });
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Both halves of a model are fetched from remote hosts: the weights and the
 * compiled library. A blocked host looks like a stalled install, so name the
 * host that failed rather than the model.
 */
async function probeRecord(record: ModelRecordLike): Promise<void> {
  try {
    await probeHost(configUrl(record));
  } catch (error) {
    throw new Error(
      `cannot reach ${hostOf(record.model)} for the weights (${error instanceof Error ? error.message : String(error)}). ` +
        'They are fetched from that host, not from this site.',
    );
  }
  if (!record.model_lib) return;
  try {
    await probeHost(record.model_lib);
  } catch (error) {
    throw new Error(
      `cannot reach ${hostOf(record.model_lib)} for the model library (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

interface LoadOptions {
  hosts?: WeightHosts;
  cacheBackend?: 'cache' | 'indexeddb';
}

let lastLoad: LoadOptions = {};

async function load(model: string, options: LoadOptions = lastLoad): Promise<ChatEngine> {
  lastLoad = options;
  if (engine && loadedModel === model) return engine;
  if (loading) return loading;
  loading = (async () => {
    const webllm = (await import('@mlc-ai/web-llm')) as unknown as {
      CreateMLCEngine: (
        model: string,
        config: {
          appConfig?: unknown;
          initProgressCallback?: (report: { progress: number; text: string }) => void;
        },
      ) => Promise<ChatEngine>;
      prebuiltAppConfig?: {
        model_list: ModelRecordLike[];
        cacheBackend?: string;
        [key: string]: unknown;
      };
    };

    // Follow the documented shape: keep the prebuilt entry (its VRAM hints,
    // overrides and required features matter), rewrite only the two URLs.
    const prebuilt = webllm.prebuiltAppConfig?.model_list?.find((entry) => entry.model_id === model);
    const record = buildModelRecord(prebuilt, model, options.hosts ?? {});

    await probeRecord(record);

    // `appConfig` replaces the whole config, so carry over the rest of the
    // prebuilt one and swap in our single record.
    const appConfig = webllm.prebuiltAppConfig
      ? {
          ...webllm.prebuiltAppConfig,
          model_list: [record],
          cacheBackend: options.cacheBackend ?? webllm.prebuiltAppConfig.cacheBackend ?? 'cache',
        }
      : { model_list: [record], cacheBackend: options.cacheBackend ?? 'cache' };

    const created = await webllm.CreateMLCEngine(model, {
      appConfig,
      initProgressCallback: (report) => {
        self.postMessage({ type: 'progress', progress: report.progress, text: report.text });
      },
    });
    engine = created;
    loadedModel = model;
    self.postMessage({ type: 'ready', model });
    return created;
  })();
  try {
    return await loading;
  } finally {
    loading = undefined;
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === 'init') {
    if (typeof request.temperature === 'number') temperature = request.temperature;
    if (typeof request.maxTokens === 'number') maxTokens = request.maxTokens;
    try {
      await load(request.model, {
        hosts: { modelBase: request.modelBase, modelLibBase: request.modelLibBase },
        cacheBackend: request.cacheBackend,
      });
    } catch (error) {
      self.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (request.type === 'dispose') {
    try {
      await engine?.unload?.();
    } catch {
      // unload is best-effort; the worker is usually terminated right after
    }
    engine = undefined;
    loadedModel = undefined;
    return;
  }
  if (request.type === 'complete') {
    try {
      const model = loadedModel;
      if (!model) {
        self.postMessage({ type: 'error', id: request.id, message: 'model is not loaded' });
        return;
      }
      const active = await load(model);
      const reply = await active.chat.completions.create({
        messages: request.messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      });
      const text = reply.choices[0]?.message?.content ?? '';
      self.postMessage({ type: 'complete', id: request.id, text });
    } catch (error) {
      self.postMessage({
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
};
