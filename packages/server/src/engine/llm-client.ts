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
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "chat") {
        return new Proxy(value, {
          get(chatTarget, chatProp) {
            const chatValue = Reflect.get(chatTarget, chatProp, chatTarget);
            if (chatProp === "completions") {
              return new Proxy(chatValue, {
                get(compTarget, compProp) {
                  const fn = Reflect.get(compTarget, compProp, compTarget);
                  if (compProp === "create") {
                    return async (...args: unknown[]) => {
                      // Call with the real Completions instance as `this`, otherwise
                      // the SDK's private `_client` is undefined.
                      const response = await fn.call(compTarget, ...args);
                      recordLLMUsage((response as { usage?: unknown } | undefined)?.usage);
                      return response;
                    };
                  }
                  return typeof fn === "function" ? fn.bind(compTarget) : fn;
                },
              });
            }
            return typeof chatValue === "function" ? chatValue.bind(chatTarget) : chatValue;
          },
        });
      }
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
