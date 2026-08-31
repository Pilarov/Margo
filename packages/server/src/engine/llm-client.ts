import OpenAI from "openai";
import { llm } from "../config.js";
import type { LLMTaskConfig } from "../config.js";

const _clients = new Map<string, OpenAI>();

function resolveClient(task?: LLMTaskConfig): OpenAI {
  const apiKey = task?.apiKey || llm.defaultApiKey;
  const baseUrl = task?.baseUrl || llm.defaultBaseUrl;
  const cacheKey = `${apiKey ?? ""}::${baseUrl ?? ""}`;

  let client = _clients.get(cacheKey);
  if (!client) {
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for LLM operations");
    }
    client = new OpenAI({ apiKey, baseURL: baseUrl });
    _clients.set(cacheKey, client);
  }
  return client;
}

export function getLLMClient(task?: LLMTaskConfig): OpenAI {
  return resolveClient(task);
}

export function resetLLMClient(): void {
  _clients.clear();
}
