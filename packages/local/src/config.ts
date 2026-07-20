import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

function readJsonConfig(): Record<string, any> {
  const path = resolve(process.cwd(), "retaindb.config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    console.warn("[Config] Failed to parse retaindb.config.json, falling back to env/defaults");
    return {};
  }
}

const json = readJsonConfig();
const jEmbed = (json.embedding ?? {}) as Record<string, any>;

export interface LocalEmbeddingConfig {
  provider: "hash" | "local-transformers";
  model: string;
}

export const embedding: LocalEmbeddingConfig = {
  provider: (process.env.RETAINDB_EMBEDDING_PROVIDER || jEmbed.provider || "hash") as LocalEmbeddingConfig["provider"],
  model: process.env.RETAINDB_EMBEDDING_MODEL || jEmbed.model || "Xenova/all-MiniLM-L6-v2",
};
