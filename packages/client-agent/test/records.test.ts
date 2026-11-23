import { describe, expect, it } from 'vitest';
import { buildModelRecord, cleanModelUrl, configUrl, DEFAULT_WEIGHT_BASE } from '../src/webllm/records.js';

const modelId = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

const prebuilt = {
  model: `https://huggingface.co/mlc-ai/${modelId}`,
  model_id: modelId,
  model_lib:
    'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_87/base/Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm',
  vram_required_MB: 880,
  overrides: { context_window_size: 4096 },
};

describe('buildModelRecord', () => {
  it('leaves the upstream record untouched without hosts', () => {
    const record = buildModelRecord(prebuilt, modelId);
    expect(record.model).toBe(prebuilt.model);
    expect(record.model_lib).toBe(prebuilt.model_lib);
  });

  it('points weights at a self-hosted base and keeps the rest of the record', () => {
    const record = buildModelRecord(prebuilt, modelId, { modelBase: 'https://shobyde.com/models' });
    expect(record.model).toBe(`https://shobyde.com/models/${modelId}`);
    expect(record.vram_required_MB).toBe(880);
    expect(record.overrides).toEqual({ context_window_size: 4096 });
    expect(record.model_id).toBe(modelId);
  });

  it('points the library at a self-hosted base, keeping the file name', () => {
    const record = buildModelRecord(prebuilt, modelId, {
      modelLibBase: 'https://shobyde.com/libs/',
    });
    expect(record.model_lib).toBe(
      'https://shobyde.com/libs/Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm',
    );
  });

  it('tolerates trailing slashes on both bases', () => {
    const record = buildModelRecord(prebuilt, modelId, {
      modelBase: 'https://cdn.example.com/m//',
      modelLibBase: 'https://cdn.example.com/l//',
    });
    expect(record.model).toBe(`https://cdn.example.com/m/${modelId}`);
    expect(record.model_lib).toBe(
      'https://cdn.example.com/l/Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm',
    );
  });

  it('falls back to the documented host for a model it has no entry for', () => {
    const record = buildModelRecord(undefined, 'Some-New-Model-MLC');
    expect(record.model).toBe(`${DEFAULT_WEIGHT_BASE}/Some-New-Model-MLC`);
    expect(record.model_lib).toBe('');
  });

  it('resolves the config file the way WebLLM does, through /resolve/main/', () => {
    const record = buildModelRecord(prebuilt, modelId, { modelBase: 'https://x.test/models/' });
    expect(configUrl(record)).toBe(
      `https://x.test/models/${modelId}/resolve/main/mlc-chat-config.json`,
    );
  });

  it('keeps an explicit /resolve/<branch>/ in the URL', () => {
    expect(cleanModelUrl('https://x.test/models/m/')).toBe('https://x.test/models/m/resolve/main/');
    expect(cleanModelUrl('https://x.test/models/m/resolve/v2/')).toBe(
      'https://x.test/models/m/resolve/v2/',
    );
  });

  it('matches the URL the upstream record already resolves to', () => {
    expect(configUrl(prebuilt)).toBe(`https://huggingface.co/mlc-ai/${modelId}/resolve/main/mlc-chat-config.json`);
  });
});
