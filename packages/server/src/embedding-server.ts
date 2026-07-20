import "./env.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { embedLocal } from "./engine/embeddings-local.js";
import { embedding as cfg } from "./config.js";

type EmbeddingRequest = {
  inputs?: unknown;
  input?: unknown;
};

const app = new Hono();
const PORT = Number(process.env.PORT || 8080);
const EMBEDDING_MODEL = cfg.model;
const INFERENCE_API_KEY = (cfg.inferenceApiKey || "").trim();
const MAX_BATCH_SIZE = cfg.maxBatchSize;
const MAX_CONCURRENCY = cfg.maxConcurrency;

let activeWorkers = 0;
const waitQueue: Array<() => void> = [];

function parseBearer(headerValue: string | undefined): string {
  if (!headerValue) return "";
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return (match?.[1] || headerValue).trim();
}

function isAuthorized(authHeader: string | undefined): boolean {
  if (!INFERENCE_API_KEY) return true;
  return parseBearer(authHeader) === INFERENCE_API_KEY;
}

async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (activeWorkers >= MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => waitQueue.push(resolve));
  }
  activeWorkers += 1;
  try {
    return await fn();
  } finally {
    activeWorkers -= 1;
    const next = waitQueue.shift();
    if (next) next();
  }
}

function normalizeInputs(body: EmbeddingRequest): string[] {
  const raw = Array.isArray(body.inputs)
    ? body.inputs
    : typeof body.input === "string"
      ? [body.input]
      : Array.isArray(body.input)
        ? body.input
        : [];
  return raw
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .slice(0, MAX_BATCH_SIZE);
}

app.use("*", cors());
app.use("*", logger());

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "embedding",
    model: EMBEDDING_MODEL,
    max_batch_size: MAX_BATCH_SIZE,
    max_concurrency: MAX_CONCURRENCY,
  })
);

app.post("/v1/inference/embeddings", async (c) => {
  if (!isAuthorized(c.req.header("Authorization"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: EmbeddingRequest;
  try {
    body = await c.req.json<EmbeddingRequest>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const inputs = normalizeInputs(body);
  if (!inputs.length) {
    return c.json({ error: "inputs (array<string>) is required" }, 400);
  }

  try {
    const started = Date.now();
    const embeddings = await withConcurrencyLimit(() => embedLocal(inputs));
    return c.json({
      embeddings,
      model: EMBEDDING_MODEL,
      count: embeddings.length,
      latency_ms: Date.now() - started,
    });
  } catch (error: any) {
    return c.json({ error: error?.message || "Embedding failed" }, 500);
  }
});

serve({ fetch: app.fetch, port: PORT });

