/**
 * Adapter for Chrome's built-in on-device model (Gemini Nano) through the
 * Prompt API. Nothing is downloaded by this package: the browser either has the
 * model, can fetch it once for the whole profile, or cannot run it.
 *
 * The API is not in every browser, so everything here feature-detects and
 * reports `unsupported` instead of throwing.
 */
import type { AgentEngine, EngineRequest, ChatMessage } from '../core/types.js';

export type ChromeAIAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';

interface LanguageModelSession {
  prompt(input: string, options?: Record<string, unknown>): Promise<string>;
  destroy?: () => void;
}

interface LanguageModelApi {
  availability(options?: Record<string, unknown>): Promise<Exclude<ChromeAIAvailability, 'unsupported'>>;
  create(options?: Record<string, unknown>): Promise<LanguageModelSession>;
}

function api(): LanguageModelApi | undefined {
  const scope = globalThis as unknown as {
    LanguageModel?: LanguageModelApi;
    ai?: { languageModel?: LanguageModelApi };
  };
  return scope.LanguageModel ?? scope.ai?.languageModel;
}

export function isChromeAIAvailable(): boolean {
  return Boolean(api());
}

/** Asks the browser whether it can run its own model right now. */
export async function detectChromeAI(): Promise<ChromeAIAvailability> {
  const languageModel = api();
  if (!languageModel) return 'unsupported';
  try {
    return await languageModel.availability();
  } catch {
    return 'unsupported';
  }
}

export interface ChromeAIEngineOptions {
  /** Sampling temperature. Default 0.2, which suits JSON tool calls. */
  temperature?: number;
  /** Top-K sampling. Default 3. */
  topK?: number;
  /** Called with the browser's own download progress when it fetches the model. */
  onProgress?: (report: { progress: number }) => void;
  /** Called once the session exists and inference can start. */
  onReady?: () => void;
}

/**
 * Flattens the conversation into one prompt. The Prompt API takes text, not a
 * message array, and the runtime hands us the whole history each turn, so the
 * transcript is rebuilt per call.
 */
function toPrompt(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      lines.push(message.content);
    } else if (message.role === 'user') {
      lines.push(`USER: ${message.content}`);
    } else {
      lines.push(`ASSISTANT: ${message.content}`);
    }
  }
  return lines.join('\n\n');
}

export interface ChromeAIEngine extends AgentEngine {
  /** Creates the session now, which is also what fetches the model if the browser has to. */
  prepare(): Promise<void>;
}

export function createChromeAIEngine(options: ChromeAIEngineOptions = {}): ChromeAIEngine {
  let session: LanguageModelSession | undefined;
  let creating: Promise<LanguageModelSession> | undefined;

  const ensureSession = async (): Promise<LanguageModelSession> => {
    if (session) return session;
    if (creating) return creating;
    const languageModel = api();
    if (!languageModel) throw new Error('this browser has no built-in language model');
    creating = (async () => {
      const created = await languageModel.create({
        temperature: options.temperature ?? 0.2,
        topK: options.topK ?? 3,
        monitor(monitor: EventTarget) {
          monitor.addEventListener('downloadprogress', (event) => {
            const loaded = (event as Event & { loaded?: number }).loaded;
            if (typeof loaded === 'number') options.onProgress?.({ progress: loaded });
          });
        },
      });
      session = created;
      options.onReady?.();
      return created;
    })();
    try {
      return await creating;
    } finally {
      creating = undefined;
    }
  };

  return {
    id: 'chrome-ai',
    async prepare(): Promise<void> {
      await ensureSession();
    },
    async complete(request: EngineRequest): Promise<{ text: string }> {
      const active = await ensureSession();
      const text = await active.prompt(toPrompt(request.messages), {
        signal: request.signal,
      });
      return { text };
    },
  };
}
