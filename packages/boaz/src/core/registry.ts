import type { CapabilityDeclaration } from './types.js';

export interface RegistryLookup {
  get(id: string): CapabilityDeclaration | undefined;
  awaitRegistration(id: string, timeoutMs: number): Promise<CapabilityDeclaration | undefined>;
  list(): CapabilityDeclaration[];
  register(declaration: CapabilityDeclaration): () => void;
}

/**
 * Holds live handler functions. The manifest says what exists; this says what
 * can actually run right now. They are deliberately separate: a route that is
 * not mounted yet has a declaration but no handler.
 */
export class CapabilityRegistry implements RegistryLookup {
  private entries = new Map<string, CapabilityDeclaration>();
  private waiters = new Map<string, Array<(declaration: CapabilityDeclaration | undefined) => void>>();

  register(declaration: CapabilityDeclaration): () => void {
    this.entries.set(declaration.id, declaration);
    const pending = this.waiters.get(declaration.id);
    if (pending) {
      this.waiters.delete(declaration.id);
      for (const resolve of pending) resolve(declaration);
    }
    return () => this.unregister(declaration.id);
  }

  unregister(id: string): void {
    this.entries.delete(id);
  }

  get(id: string): CapabilityDeclaration | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  list(): CapabilityDeclaration[] {
    return [...this.entries.values()];
  }

  clear(): void {
    this.entries.clear();
    this.waiters.clear();
  }

  /**
   * Resolves once a handler registers, or with undefined on timeout. The
   * runtime uses it after navigating to a capability's route: the handler
   * lives in the module that the route mounts.
   */
  awaitRegistration(
    id: string,
    timeoutMs = 2000,
  ): Promise<CapabilityDeclaration | undefined> {
    const existing = this.entries.get(id);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (declaration: CapabilityDeclaration | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(declaration);
      };
      const timer = setTimeout(() => {
        const list = this.waiters.get(id) ?? [];
        this.waiters.set(
          id,
          list.filter((fn) => fn !== finish),
        );
        finish(undefined);
      }, timeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      const list = this.waiters.get(id) ?? [];
      list.push(finish);
      this.waiters.set(id, list);
    });
  }
}

/** Process-wide registry used when the app does not create its own. */
export const registry = new CapabilityRegistry();

/** Convenience: register into the process-wide registry, e.g. at feature-module import. */
export function registerCapability(declaration: CapabilityDeclaration): () => void {
  return registry.register(declaration);
}
