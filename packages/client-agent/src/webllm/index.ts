import type { AgentEngine, EngineRequest, ManifestCapability } from '../core/types.js';
import { createLexicalEngine } from '../core/lexical-engine.js';
import type { WorkerRequest, WorkerResponse } from './worker.js';

export interface ModelProfile {
  /** ~1.5B–2B quantized: fast routing and short answers, ~1.2 GB of weights. */
  compact: string;
  /** ~3B–4B quantized: better multi-step JSON, ~2.4 GB of weights. */
  standard: string;
}

/**
 * q4f16 halves the weight footprint against q4f32 with no measurable quality
 * difference on a 1B model, and a smaller download is the difference between a
 * visitor waiting and a visitor leaving. 879 MB and 2.3 GB respectively.
 */
export const DEFAULT_MODELS: ModelProfile = {
  compact: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
  standard: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
};

/**
 * Smallest instruct model worth calling tools with, for hosts where even the
 * compact tier is a hard sell. Weaker at multi-step JSON; fine for one call.
 */
export const TINY_MODEL = 'SmolLM2-360M-Instruct-q4f16_1-MLC';

export interface WebLLMEngineOptions {
  /** Explicit MLC model id. Overrides `tier`. */
  model?: string;
  /** Which profile to use when `model` is not given. Default "compact". */
  tier?: keyof ModelProfile;
  models?: Partial<ModelProfile>;
  /** Supply your own worker (e.g. one bundled by your app). */
  worker?: Worker;
  /** Where to find the worker module. Defaults to the packaged worker. */
  workerUrl?: string | URL;
  temperature?: number;
  maxTokens?: number;
  /** Streaming download progress: 0–1 plus the engine's own status line. */
  onProgress?: (report: { progress: number; text: string }) => void;
  /** State changes, with the underlying message when the engine fails. */
  onStateChange?: (state: WebLLMState, detail?: { message?: string }) => void;
}

export type WebLLMState = 'idle' | 'loading' | 'ready' | 'error' | 'disposed';

export interface WebLLMEngine extends AgentEngine {
  readonly model: string;
  readonly state: WebLLMState;
  /** Downloads weights (cached by the engine) and resolves when inference can run. */
  load(): Promise<void>;
  dispose(): void;
}

export function isWebGPUAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && Boolean(navigator.gpu);
}

/**
 * `navigator.gpu` can exist while no adapter does (headless Chromium, a blocklisted
 * GPU, a remote desktop session). Ask for an adapter before promising a model.
 */
export async function detectWebGPU(): Promise<'available' | 'unsupported' | 'no-adapter'> {
  if (!isWebGPUAvailable()) return 'unsupported';
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? 'available' : 'no-adapter';
  } catch {
    return 'no-adapter';
  }
}

/** Picks a model for the device: 8 GB+ gets the standard tier. */
export function pickModelTier(memoryGb?: number): keyof ModelProfile {
  const memory =
    memoryGb ??
    (typeof navigator !== 'undefined'
      ? ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8)
      : 8);
  return memory >= 8 ? 'standard' : 'compact';
}

/**
 * Wraps the WebLLM worker in the `AgentEngine` interface.
 *
 * Nothing downloads until `load()` or the first `complete()` call, so a page
 * that never opens the assistant pays no bandwidth.
 */
export function createWebLLMEngine(options: WebLLMEngineOptions = {}): WebLLMEngine {
  const models = { ...DEFAULT_MODELS, ...options.models };
  const model = options.model ?? models[options.tier ?? pickModelTier()];
  let state: WebLLMState = 'idle';
  let worker = options.worker;
  let ownsWorker = !options.worker;
  let nextId = 1;
  let pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>();
  let readyPromise: Promise<void> | undefined;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;

  const setState = (next: WebLLMState, detail?: { message?: string }) => {
    state = next;
    options.onStateChange?.(next, detail);
  };

  const ensureWorker = (): Worker => {
    if (worker) return worker;
    const url = options.workerUrl ?? new URL('./worker.js', import.meta.url);
    worker = new Worker(url, { type: 'module' });
    ownsWorker = true;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        options.onProgress?.({ progress: message.progress, text: message.text });
      } else if (message.type === 'ready') {
        setState('ready');
        readyResolve?.();
      } else if (message.type === 'complete') {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        entry?.resolve(message.text);
      } else if (message.type === 'error') {
        if (typeof message.id === 'number') {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          entry?.reject(new Error(message.message));
        } else {
          // A worker-level failure is usually a fetch that never completed
          // (offline, blocked CDN, quota). Keep the engine's own words.
          setState('error', { message: message.message });
          readyReject?.(new Error(message.message));
        }
      }
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || 'webllm worker failed');
      setState('error', { message: error.message });
      readyReject?.(error);
      for (const entry of pending.values()) entry.reject(error);
      pending = new Map();
    };
    return worker;
  };

  const post = (message: WorkerRequest) => ensureWorker().postMessage(message);

  const load = (): Promise<void> => {
    if (state === 'ready') return Promise.resolve();
    if (readyPromise) return readyPromise;
    if (state === 'error') return Promise.reject(new Error('webllm worker is in an error state'));
    setState('loading');
    readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    post({ type: 'init', model, temperature: options.temperature, maxTokens: options.maxTokens });
    return readyPromise;
  };

  return {
    id: `webllm:${model}`,
    get model() {
      return model;
    },
    get state() {
      return state;
    },
    load,
    async complete(request: EngineRequest): Promise<{ text: string }> {
      await load();
      const id = nextId;
      nextId += 1;
      return new Promise<{ text: string }>((resolve, reject) => {
        pending.set(id, { resolve: (text) => resolve({ text }), reject });
        post({
          type: 'complete',
          id,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        });
        request.signal?.addEventListener('abort', () => {
          pending.delete(id);
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    },
    dispose() {
      if (worker) {
        post({ type: 'dispose' });
        if (ownsWorker) worker.terminate();
      }
      worker = undefined;
      pending = new Map();
      setState('disposed');
    },
  };
}

export interface AutoEngineOptions extends WebLLMEngineOptions {
  capabilities: ManifestCapability[];
  /** Called when WebGPU is missing or the model fails to load. */
  onFallback?: (reason: string) => void;
  lexicalThreshold?: number;
}

/**
 * WebGPU when available and healthy, lexical search otherwise. The returned
 * engine never needs the network, which is what makes a demo deployable
 * without an inference bill.
 */
export function createAutoEngine(options: AutoEngineOptions): AgentEngine {
  const lexical = createLexicalEngine({
    capabilities: options.capabilities,
    threshold: options.lexicalThreshold,
  });
  if (typeof window === 'undefined' || !isWebGPUAvailable()) {
    options.onFallback?.('WebGPU is not available in this browser');
    return lexical;
  }
  return createWebLLMEngine(options);
}
