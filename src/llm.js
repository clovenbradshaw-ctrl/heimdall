import { CreateMLCEngine, prebuiltAppConfig } from "@mlc-ai/web-llm";

export const MODEL_CHOICES = [
  { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", label: "Qwen 2.5 0.5B — fast, low-memory", default: true },
  { id: "SmolLM2-360M-Instruct-q4f16_1-MLC", label: "SmolLM2 360M — tiny" },
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", label: "Llama 3.2 1B — balanced" },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Llama 3.2 3B — desktop only" },
];

export const DEFAULT_MODEL = MODEL_CHOICES.find((m) => m.default).id;

/**
 * Owns the WebLLM engine on the worker device. Inference requests are
 * serialized so one model serves one job at a time.
 */
export class WorkerEngine {
  constructor(onProgress) {
    this.engine = null;
    this.modelId = null;
    this.queue = Promise.resolve();
    this.onProgress = onProgress || (() => {});
  }

  get loaded() {
    return !!this.engine;
  }

  async load(modelId) {
    if (this.engine && this.modelId === modelId) return;
    const known = new Set(MODEL_CHOICES.map((m) => m.id));
    const list = prebuiltAppConfig.model_list.filter((m) => known.has(m.model_id));
    this.engine = await CreateMLCEngine(modelId, {
      initProgressCallback: (p) => this.onProgress(p),
      appConfig: { ...prebuiltAppConfig, model_list: list },
    });
    this.modelId = modelId;
  }

  infer(messages, opts = {}, onToken) {
    const run = () => this._run(messages, opts, onToken);
    const task = this.queue.then(run);
    this.queue = task.then(() => {}, () => {});
    return task;
  }

  async _run(messages, { stream = true, temperature = 0.7, max_tokens = 1024 }, onToken) {
    if (!this.engine) throw new Error("model not loaded");
    const opts = { messages, temperature, max_tokens, stream };
    if (stream) {
      const chunks = await this.engine.chat.completions.create(opts);
      let text = "";
      for await (const chunk of chunks) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onToken?.(delta);
        }
      }
      return { text };
    }
    const reply = await this.engine.chat.completions.create(opts);
    return {
      text: reply.choices?.[0]?.message?.content ?? "",
      usage: reply.usage,
    };
  }
}

export function gpuLabel() {
  const nav = navigator;
  if (!("gpu" in nav)) return "no WebGPU";
  try {
    const adapter = nav.gpu.requestAdapter ? "adapter" : "no adapter";
    return adapter;
  } catch {
    return "no WebGPU";
  }
}

export function webgpuAvailable() {
  return "gpu" in navigator;
}