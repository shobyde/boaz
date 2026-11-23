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

/**
 * Weight hosts, tried in order. HuggingFace is the canonical one; the mirror
 * serves the same paths for networks where the main host is blocked or
 * throttled into silence.
 */
const WEIGHT_HOSTS = ['https://huggingface.co', 'https://hf-mirror.com'];

/** Where WebLLM fetches weights for a prebuilt model id. */
function artifactUrl(model: string, host = WEIGHT_HOSTS[0]): string {
  return `${host}/mlc-ai/${model}/resolve/main/mlc-chat-config.json`;
}

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

/** Returns the first host that answers, so one blocked CDN is not fatal. */
async function probeModelHost(model: string): Promise<string> {
  const failures: string[] = [];
  for (const host of WEIGHT_HOSTS) {
    try {
      await probeHost(artifactUrl(model, host));
      return host;
    } catch (error) {
      failures.push(`${host.replace('https://', '')}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `cannot reach a weight host for ${model} (${failures.join('; ')}). The weights are fetched from those hosts, not from this site.`,
  );
}

async function load(model: string): Promise<ChatEngine> {
  if (engine && loadedModel === model) return engine;
  if (loading) return loading;
  loading = (async () => {
    const host = await probeModelHost(model);
    const webllm = (await import('@mlc-ai/web-llm')) as unknown as {
      CreateMLCEngine: (
        model: string,
        config: {
          appConfig?: unknown;
          initProgressCallback?: (report: { progress: number; text: string }) => void;
        },
      ) => Promise<ChatEngine>;
      prebuiltAppConfig?: { model_list: Array<Record<string, unknown>> };
    };
    // Point every artifact at the host that answered, instead of assuming the
    // canonical one.
    let appConfig: unknown;
    if (host !== WEIGHT_HOSTS[0] && webllm.prebuiltAppConfig) {
      const config = JSON.parse(JSON.stringify(webllm.prebuiltAppConfig)) as {
        model_list: Array<Record<string, unknown>>;
      };
      config.model_list = config.model_list.map((entry) => ({
        ...entry,
        model: String(entry.model ?? '').replace(WEIGHT_HOSTS[0], host),
      }));
      appConfig = config;
    }
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
      await load(request.model);
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
