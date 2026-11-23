/**
 * Model records, built the way WebLLM's own documentation describes them.
 *
 * A runnable model needs two URLs (see `ModelRecord` in `@mlc-ai/web-llm`):
 *
 *   - `model`     the directory holding `mlc-chat-config.json`,
 *                 `tensor-cache.json` and the weight shards
 *   - `model_lib` the compiled WebGPU library (`.wasm`) for that model
 *
 * `prebuiltAppConfig.model_list` points both at upstream hosts: weights at
 * huggingface.co, libraries at raw.githubusercontent.com. Passing your own
 * `appConfig` with the same two fields served from your own origin is the
 * documented way to self-host, and the only way to keep working when the
 * weight host is unreachable from the visitor's network.
 */

export interface ModelRecordLike {
  model: string;
  model_id: string;
  model_lib: string;
  [key: string]: unknown;
}

export interface WeightHosts {
  /** Base URL that serves `<base>/<model_id>/...`. Default: HuggingFace. */
  modelBase?: string;
  /** Base URL that serves the compiled `.wasm` files. Default: upstream. */
  modelLibBase?: string;
}

/** Where WebLLM's prebuilt records expect weights. */
export const DEFAULT_WEIGHT_BASE = 'https://huggingface.co/mlc-ai';

const stripSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * Returns the record to hand to `CreateMLCEngine`, with either URL redirected
 * at a self-hosted copy. Fields the prebuilt record carries (overrides, VRAM
 * hints, required features) are preserved: dropping them changes behaviour.
 */
export function buildModelRecord(
  entry: ModelRecordLike | undefined,
  modelId: string,
  hosts: WeightHosts = {},
): ModelRecordLike {
  const base: ModelRecordLike = entry ?? {
    model: `${DEFAULT_WEIGHT_BASE}/${modelId}`,
    model_id: modelId,
    model_lib: '',
  };

  const model = hosts.modelBase
    ? `${stripSlash(hosts.modelBase)}/${modelId}`
    : base.model;

  let modelLib = base.model_lib;
  if (hosts.modelLibBase) {
    const file = String(base.model_lib).split('/').pop() || `${modelId}-webgpu.wasm`;
    modelLib = `${stripSlash(hosts.modelLibBase)}/${file}`;
  }

  return { ...base, model_id: modelId, model, model_lib: modelLib };
}

/**
 * WebLLM rewrites `ModelRecord.model` before fetching anything: it appends a
 * trailing slash and, unless the URL already contains `/resolve/<branch>/`,
 * appends `resolve/main/`. Mirroring that rule here means the preflight probe
 * checks the same URL the engine will actually request, instead of a path that
 * only looks right.
 */
export function cleanModelUrl(model: string): string {
  let url = model.endsWith('/') ? model : `${model}/`;
  if (!url.match(/.+\/resolve\/.+\//)) url += 'resolve/main/';
  return new URL(url).href;
}

/** The config file every weight directory must expose. */
export function configUrl(record: ModelRecordLike): string {
  return new URL('mlc-chat-config.json', cleanModelUrl(record.model)).href;
}
