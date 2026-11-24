/**
 * Stated preferences as facts (0.7.11).
 *
 * A visitor who says "keep it short" is not making a request for one answer: they
 * are asserting something about the session. The page keeps that the way it keeps
 * every other fact it reasons over, as a `prefers(<key>, <value>)` assertion, so
 * a host can report why an answer was short instead of leaving a module variable
 * whose only evidence is the answer's length.
 *
 * The store is also the honesty boundary. A host declares the keys and the values
 * it can act on. Anything else is refused at `record()` rather than stored and
 * silently ignored, so a host that cannot change its tone cannot appear to have
 * accepted a tone preference.
 */

export interface PreferenceDeclaration {
  /** Key the assertion is made under, e.g. `register`. */
  id: string;
  /** The values this host can act on. Anything else is refused, not guessed. */
  values: string[];
  /** What `get()` reports when nothing has been stated. */
  defaultValue?: string;
}

export interface StatedPreference {
  id: string;
  value: string;
  /** 1-based count of preferences stated in this session. */
  turn: number;
  /** The visitor's words, kept for the recap and the trace. */
  utterance: string;
}

export interface PreferenceRecordOptions {
  utterance?: string;
  /** Override the store's own counter, when the host counts turns itself. */
  turn?: number;
}

export interface PreferenceMemory {
  readonly declarations: PreferenceDeclaration[];
  isDeclared(id: string): boolean;
  accepts(id: string, value: string): boolean;
  /** Store a stated preference; `null` when the key or the value is not declared. */
  record(id: string, value: string, options?: PreferenceRecordOptions): StatedPreference | null;
  /** The stated value, else the declaration's default, else `null`. */
  get(id: string): string | null;
  /** Every stated preference, oldest first. */
  stated(id?: string): StatedPreference[];
  /** The assertions a rule could join: `prefers(register, terse)`. */
  facts(): string[];
  /** Forget what was stated; the declaration's default applies again. */
  reset(id?: string): void;
}

const normalize = (value: string) => String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

export function createPreferenceMemory({ preferences }: { preferences: PreferenceDeclaration[] }): PreferenceMemory {
  const declarations = preferences.map((declaration) => ({
    ...declaration,
    values: declaration.values.map(normalize),
    defaultValue: declaration.defaultValue ? normalize(declaration.defaultValue) : undefined,
  }));
  const byId = new Map(declarations.map((declaration) => [declaration.id, declaration]));
  let history: StatedPreference[] = [];
  let turn = 0;

  const isDeclared = (id: string) => byId.has(String(id));
  const accepts = (id: string, value: string) => {
    const declaration = byId.get(String(id));
    return Boolean(declaration && declaration.values.includes(normalize(value)));
  };

  const latest = (id: string) => {
    for (let at = history.length - 1; at >= 0; at -= 1) {
      if (history[at].id === id) return history[at];
    }
    return null;
  };

  return {
    declarations,
    isDeclared,
    accepts,
    record(id, value, options = {}) {
      if (!accepts(id, value)) return null;
      const entry: StatedPreference = {
        id: String(id),
        value: normalize(value),
        turn: options.turn ?? (turn += 1),
        utterance: String(options.utterance ?? ''),
      };
      if (options.turn !== undefined) turn = Math.max(turn, options.turn);
      history.push(entry);
      return entry;
    },
    get(id) {
      const stated = latest(String(id));
      if (stated) return stated.value;
      const declaration = byId.get(String(id));
      return declaration?.defaultValue ?? null;
    },
    stated(id) {
      return id === undefined ? [...history] : history.filter((entry) => entry.id === String(id));
    },
    facts() {
      return declarations
        .map((declaration) => latest(declaration.id))
        .filter((entry): entry is StatedPreference => Boolean(entry))
        .map((entry) => `prefers(${entry.id}, ${entry.value})`);
    },
    reset(id) {
      if (id === undefined) {
        // A full reset is a new session: turn numbers start again, so a recap
        // after a reset cannot cite a turn from the session before it.
        history = [];
        turn = 0;
        return;
      }
      history = history.filter((entry) => entry.id !== String(id));
    },
  };
}
