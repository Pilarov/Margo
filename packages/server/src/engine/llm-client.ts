import OpenAI from "openai";
import { llm } from "../config.js";
import type { LLMTaskConfig } from "../config.js";
import { recordLLMUsage } from "./telemetry/collector.js";

const _clients = new Map<string, OpenAI>();

/**
 * Wrap an OpenAI client so every `chat.completions.create` reports its token
 * usage to the telemetry collector (ADR-011 §1, cost metric of ADR-010 §1).
 * Transparent: property access (apiKey/baseURL) and caching identity are kept.
 */
function instrumentClient(client: OpenAI): OpenAI {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "chat") {
        const chat = Reflect.get(target, prop, receiver);
        return new Proxy(chat, {
          get(chatTarget, chatProp, chatReceiver) {
            if (chatProp === "completions") {
              const completions = Reflect.get(chatTarget, chatProp, chatReceiver);
              return new Proxy(completions, {
                get(compTarget, compProp, compReceiver) {
                  if (compProp === "create") {
                    const original = Reflect.get(compTarget, compProp, compReceiver);
                    return async (...args: unknown[]) => {
                      const response = await original(...args);
                      recordLLMUsage((response as { usage?: unknown } | undefined)?.usage);
                      return response;
                    };
                  }
                  const value = Reflect.get(compTarget, compProp, compReceiver);
                  return typeof value === "function" ? value.bind(compTarget) : value;
                },
              });
            }
            const value = Reflect.get(chatTarget, chatProp, chatReceiver);
            return typeof value === "function" ? value.bind(chatTarget) : value;
          },
        });
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function resolveClient(task?: LLMTaskConfig): OpenAI {
  const apiKey = task?.apiKey || llm.defaultApiKey;
  const baseUrl = task?.baseUrl || llm.defaultBaseUrl;
  const cacheKey = `${apiKey ?? ""}::${baseUrl ?? ""}`;

  let client = _clients.get(cacheKey);
  if (!client) {
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for LLM operations");
    }
    client = instrumentClient(new OpenAI({ apiKey, baseURL: baseUrl }));
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
