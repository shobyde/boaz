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

/** Where WebLLM fetches weights for a prebuilt model id. */
function artifactUrl(model: string): string {
  return `https://huggingface.co/mlc-ai/${model}/resolve/main/mlc-chat-config.json`;
}

/**
 * A blocked or throttled model host looks exactly like a slow download: no
 * progress, no error, forever. One small request with a deadline turns that
 * into a sentence the UI can show.
 */
async function probeModelHost(model: string, timeoutMs = 10000): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Opaque on purpose: this proves the request completes, not that the
    // artifact exists. A CORS failure would otherwise look like a dead host.
    await fetch(artifactUrl(model), {
      signal: controller.signal,
      cache: 'no-store',
      mode: 'no-cors',
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cannot reach huggingface.co for ${model} (${reason}). The weights are fetched from that host, not from this site.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function load(model: string): Promise<ChatEngine> {
  if (engine && loadedModel === model) return engine;
  if (loading) return loading;
  loading = (async () => {
    await probeModelHost(model);
    const webllm = (await import('@mlc-ai/web-llm')) as unknown as {
      CreateMLCEngine: (
        model: string,
        config: { initProgressCallback?: (report: { progress: number; text: string }) => void },
      ) => Promise<ChatEngine>;
    };
    const created = await webllm.CreateMLCEngine(model, {
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
