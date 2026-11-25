import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AgentRuntime } from '../core/loop.js';
import { registry as globalRegistry } from '../core/registry.js';
import type { CapabilityRegistry, RegistryLookup } from '../core/registry.js';
import type {
  AgentEngine,
  AgentEvent,
  CapabilityDeclaration,
  ConfirmationRequest,
  ManifestCapability,
  RuntimeSnapshot,
  TurnResult,
} from '../core/types.js';

export interface AgentProviderProps {
  engine: AgentEngine;
  capabilities: ManifestCapability[];
  getSnapshot: () => RuntimeSnapshot;
  navigate?: (route: string) => void | Promise<void>;
  dispatch?: (event: string, payload?: unknown) => void;
  registry?: CapabilityRegistry;
  topK?: number;
  maxToolCalls?: number;
  promptBudgetTokens?: number;
  instructions?: string;
  onEvent?: (event: AgentEvent) => void;
  children?: ReactNode;
}

export interface UIChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  steps?: TurnResult['steps'];
}

interface PendingConfirmation {
  request: ConfirmationRequest;
  resolve: (approved: boolean) => void;
}

interface AgentContextValue {
  runtime: AgentRuntime;
  registry: RegistryLookup;
  messages: UIChatMessage[];
  status: 'idle' | 'working' | 'error';
  error: string | null;
  pendingConfirmation: ConfirmationRequest | null;
  approve: () => void;
  reject: () => void;
  send: (text: string) => Promise<void>;
  reset: () => void;
}

const AgentContext = createContext<AgentContextValue | null>(null);

/** Headless chat state and turn control for one `AgentRuntime`. */
export function useAgentChat(): AgentContextValue {
  const value = useContext(AgentContext);
  if (!value) {
    throw new Error('useAgentChat must be used inside <AgentProvider>');
  }
  return value;
}

/** The runtime itself, for advanced wiring (custom UI, tests, imperative calls). */
export function useAgentRuntime(): { runtime: AgentRuntime; registry: RegistryLookup } {
  const value = useContext(AgentContext);
  if (!value) throw new Error('useAgentRuntime must be used inside <AgentProvider>');
  return { runtime: value.runtime, registry: value.registry };
}

export function AgentProvider({
  engine,
  capabilities,
  getSnapshot,
  navigate,
  dispatch,
  registry = globalRegistry,
  topK,
  maxToolCalls,
  promptBudgetTokens,
  instructions,
  onEvent,
  children,
}: AgentProviderProps) {
  const [messages, setMessages] = useState<UIChatMessage[]>([]);
  const [status, setStatus] = useState<'idle' | 'working' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<ConfirmationRequest | null>(null);
  const pendingRef = useRef<PendingConfirmation | null>(null);
  const nextId = useRef(1);
  const busy = useRef(false);

  const confirm = useCallback(
    (request: ConfirmationRequest) =>
      new Promise<boolean>((resolve) => {
        const entry = { request, resolve };
        pendingRef.current = entry;
        setPendingConfirmation(request);
      }),
    [],
  );

  const settle = useCallback((approved: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPendingConfirmation(null);
    current?.resolve(approved);
  }, []);

  // Keep the newest callbacks in refs so a state change in the host app does
  // not rebuild the runtime (and lose the conversation with it).
  const getSnapshotRef = useRef(getSnapshot);
  const navigateRef = useRef(navigate);
  const dispatchRef = useRef(dispatch);
  const onEventRef = useRef(onEvent);
  getSnapshotRef.current = getSnapshot;
  navigateRef.current = navigate;
  dispatchRef.current = dispatch;
  onEventRef.current = onEvent;

  const runtime = useMemo(
    () =>
      new AgentRuntime({
        engine,
        capabilities,
        registry,
        getSnapshot: () => getSnapshotRef.current(),
        navigate: (route: string) => navigateRef.current?.(route),
        dispatch: (event: string, payload?: unknown) => dispatchRef.current?.(event, payload),
        confirm,
        onEvent: (event) => onEventRef.current?.(event),
        ...(topK !== undefined ? { topK } : {}),
        ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
        ...(promptBudgetTokens !== undefined ? { promptBudgetTokens } : {}),
        ...(instructions ? { instructions } : {}),
      }),
    [engine, capabilities, registry, confirm, topK, maxToolCalls, promptBudgetTokens, instructions],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy.current) return;
      busy.current = true;
      setError(null);
      setStatus('working');
      const userMessage: UIChatMessage = { id: nextId.current++, role: 'user', content: trimmed };
      setMessages((previous) => [...previous, userMessage]);
      try {
        const result = await runtime.send(trimmed);
        setMessages((previous) => [
          ...previous,
          { id: nextId.current++, role: 'assistant', content: result.text, steps: result.steps },
        ]);
        setStatus('idle');
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        setStatus('error');
        setMessages((previous) => [
          ...previous,
          { id: nextId.current++, role: 'assistant', content: `Something went wrong: ${message}` },
        ]);
      } finally {
        busy.current = false;
      }
    },
    [runtime],
  );

  const reset = useCallback(() => {
    runtime.reset();
    setMessages([]);
    setError(null);
    setStatus('idle');
  }, [runtime]);

  const value = useMemo<AgentContextValue>(
    () => ({
      runtime,
      registry,
      messages,
      status,
      error,
      pendingConfirmation,
      approve: () => settle(true),
      reject: () => settle(false),
      send,
      reset,
    }),
    [runtime, registry, messages, status, error, pendingConfirmation, settle, send, reset],
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

/**
 * Registers a handler for as long as the component is mounted. This is how the
 * runtime finds an action that lives inside a page: mount the page, and its
 * capabilities become callable.
 */
export function useRegisterCapability(
  declaration: CapabilityDeclaration | CapabilityDeclaration[],
  deps: unknown[] = [],
): void {
  const registry = useContext(AgentContext)?.registry ?? globalRegistry;

  useEffect(() => {
    const list = Array.isArray(declaration) ? declaration : [declaration];
    const disposers = list.map((entry) => registry.register(entry));
    return () => {
      for (const dispose of disposers) dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, ...(Array.isArray(declaration) ? declaration : [declaration]).map((entry) => entry.id), ...deps]);
}
