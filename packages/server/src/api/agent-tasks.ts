import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { prisma } from "../db/index.js";
import { authMiddleware, AuthContext } from "../middleware/auth.js";
import { runAgentTask } from "../engine/task-runner.js";
import crypto from "crypto";
import { getEffectiveOrgId } from "./helpers.js";

type Variables = { auth: AuthContext };

export const agentTaskRoutes = new Hono<{ Variables: Variables }>();

agentTaskRoutes.use("/*", authMiddleware);

// ─── Built-in Templates ───────────────────────────────────────────────────────

const TEMPLATES = [
  {
    id: "competitive_research",
    name: "Competitive Research",
    icon: "🔍",
    description: "Find competitors and compare pricing, features, and positioning",
    goalTemplate: "Find 5 competitors of {company} and compare their pricing and key features",
    outputSchema: {
      company: "string",
      pricing: "string",
      key_features: "string",
      url: "string",
    },
  },
  {
    id: "price_monitor",
    name: "Price Monitor",
    icon: "💰",
    description: "Monitor pricing for a product or service",
    goalTemplate: "Check the current pricing for {product} on {url}",
    outputSchema: {
      plan_name: "string",
      monthly_price: "number",
      annual_price: "number",
      features: "string",
    },
  },
  {
    id: "lead_finder",
    name: "Lead Finder",
    icon: "🎯",
    description: "Find potential leads in an industry",
    goalTemplate: "Find {count} companies in {industry} that might need {service}",
    outputSchema: {
      company: "string",
      website: "string",
      size: "string",
      contact: "string",
    },
  },
  {
    id: "news_tracker",
    name: "News Tracker",
    icon: "📰",
    description: "Track latest news about a topic",
    goalTemplate: "Find the latest news about {topic} from the past {days} days",
    outputSchema: {
      title: "string",
      source: "string",
      date: "string",
      summary: "string",
      url: "string",
    },
  },
  {
    id: "site_auditor",
    name: "Site Auditor",
    icon: "🔧",
    description: "Audit a website for UX issues and improvements",
    goalTemplate: "Audit the website {url} for UX issues, broken links, and improvement opportunities",
    outputSchema: {
      issue: "string",
      severity: "string",
      page: "string",
      recommendation: "string",
    },
  },
];

// ─── Templates ────────────────────────────────────────────────────────────────

agentTaskRoutes.get("/v1/agent/templates", (c) => {
  return c.json({ templates: TEMPLATES });
});

// ─── Tasks CRUD ───────────────────────────────────────────────────────────────

agentTaskRoutes.post("/v1/agent/tasks", async (c) => {
  const auth = c.get("auth");
  const orgId = getEffectiveOrgId(c.req.header("X-Organization-Id") || c.req.header("X-RetainDB-Org-Id"), auth);
  const body = await c.req.json();

  const task = await prisma.agentTask.create({
    data: {
      orgId,
      userId: auth.userId ?? "",
      name: body.name || "Unnamed Task",
      goal: body.goal,
      outputSchema: body.outputSchema || {},
      template: body.template || null,
      schedule: body.schedule || null,
      options: body.options || {},
      credentials: body.credentials || [],
      webhookUrl: body.webhookUrl || null,
      isActive: true,
    },
  });

  return c.json({ task });
});

agentTaskRoutes.get("/v1/agent/tasks", async (c) => {
  const auth = c.get("auth");
  const orgId = getEffectiveOrgId(c.req.header("X-Organization-Id") || c.req.header("X-RetainDB-Org-Id"), auth);

  const tasks = await prisma.agentTask.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    include: {
      runs: {
        select: { id: true, status: true, startedAt: true, completedAt: true },
        orderBy: { startedAt: "desc" },
        take: 3,
      },
    },
  });

  return c.json({ tasks });
});

agentTaskRoutes.get("/v1/agent/tasks/:id", async (c) => {
  const auth = c.get("auth");
  const orgId = getEffectiveOrgId(c.req.header("X-Organization-Id") || c.req.header("X-RetainDB-Org-Id"), auth);
  const { id } = c.req.param();

  const task = await prisma.agentTask.findFirst({
    where: { id, orgId },
    include: {
      runs: {
        orderBy: { startedAt: "desc" },
        take: 10,
        select: {
          id: true,
          status: true,
          goal: true,
          totalSteps: true,
          pagesVisited: true,
          costUsd: true,
          startedAt: true,
          completedAt: true,
          errorMsg: true,
        },
      },
    },
  });

  if (!task) return c.json({ error: "Not found" }, 404);
  return c.json({ task });
});

agentTaskRoutes.delete("/v1/agent/tasks/:id", async (c) => {
  const auth = c.get("auth");
  const orgId = getEffectiveOrgId(c.req.header("X-Organization-Id") || c.req.header("X-RetainDB-Org-Id"), auth);
  const { id } = c.req.param();

  await prisma.agentTask.deleteMany({ where: { id, orgId } });
  return c.json({ success: true });
});

// ─── Run a Task (SSE stream) ──────────────────────────────────────────────────

agentTaskRoutes.post("/v1/agent/tasks/:id/run", async (c) => {
  const auth = c.get("auth");
  const orgId = getEffectiveOrgId(c.req.header("X-Organization-Id") || c.req.header("X-RetainDB-Org-Id"), auth);
  const { id } = c.req.param();

  const task = await prisma.agentTask.findFirst({ where: { id, orgId } });
  if (!task) return c.json({ error: "Task not found" }, 404);

  // Create a run record
  const run = await prisma.agentRun.create({
    data: {
      taskId: task.id,
      orgId,
      userId: auth.userId ?? "",
      goal: task.goal,
      status: "PLANNING",
    },
  });

  const body = await c.req.json().catch(() => ({}));
  const options = {
    maxSteps: (task.options as any)?.maxSteps || 12,
    antiDetect: (task.options as any)?.antiDetect !== false,
    outputSchema: task.outputSchema as Record<string, string>,
    orgId,
    userId: auth.userId ?? "",
  };

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "run_started", data: JSON.stringify({ runId: run.id }) });
    await runAgentTask(run.id, task.goal, options, stream);
  });
});

// ─── Quick Run (ad-hoc, no saved task) ──────────────────────────────────────

agentTaskRoutes.post("/v1/agent/runs", async (c) => {
  const auth = c.get("auth");
  const orgId = getEffectiveOrgId(c.req.header("X-Organization-Id") || c.req.header("X-RetainDB-Org-Id"), auth);
  const body = await c.req.json();

  const run = await prisma.agentRun.create({
    data: {
      orgId,
      userId: auth.userId ?? "",
      goal: body.goal,
      status: "PLANNING",
    },
  });

  const options = {
    maxSteps: body.maxSteps || 12,
    antiDetect: body.antiDetect !== false,
    outputSchema: body.outputSchema || {},
    orgId,
    userId: auth.userId ?? "",
  };

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "run_started", data: JSON.stringify({ runId: run.id }) });
    await runAgentTask(run.id, body.goal, options, stream);
  });
});

// ─── Runs list ────────────────────────────────────────────────────────────────

agentTaskRoutes.get("/v1/agent/runs", async (c) => {
  const auth = c.get("auth");
  const orgId = getEffectiveOrgId(c.req.header("X-Organization-Id") || c.req.header("X-RetainDB-Org-Id"), auth);
  const limit = parseInt(c.req.query("limit") || "20");

  const runs = await prisma.agentRun.findMany({
    where: { orgId },
    orderBy: { startedAt: "desc" },
    take: limit,
    select: {
      id: true,
      taskId: true,
      goal: true,
      status: true,
      totalSteps: true,
      pagesVisited: true,
      costUsd: true,
      startedAt: true,
      completedAt: true,
      errorMsg: true,
    },
  });

  return c.json({ runs });
});

agentTaskRoutes.get("/v1/agent/runs/:id", async (c) => {
  const auth = c.get("auth");
  const orgId = getEffectiveOrgId(c.req.header("X-Organization-Id") || c.req.header("X-RetainDB-Org-Id"), auth);
  const { id } = c.req.param();

  const run = await prisma.agentRun.findFirst({
    where: { id, orgId },
    include: {
      steps: {
        orderBy: { stepIndex: "asc" },
        select: {
          id: true,
          stepIndex: true,
          type: true,
          description: true,
          input: true,
          output: true,
          screenshot: true,
          confidence: true,
          durationMs: true,
          error: true,
          createdAt: true,
        },
      },
    },
  });

  if (!run) return c.json({ error: "Not found" }, 404);
  return c.json({ run });
});

agentTaskRoutes.delete("/v1/agent/runs/:id", async (c) => {
  const auth = c.get("auth");
  const orgId = getEffectiveOrgId(c.req.header("X-Organization-Id") || c.req.header("X-RetainDB-Org-Id"), auth);
  const { id } = c.req.param();

  await prisma.agentRun.updateMany({
    where: { id, orgId, status: { in: ["RUNNING", "PLANNING"] } },
    data: { status: "CANCELLED", completedAt: new Date() },
  });

  return c.json({ success: true });
});

// Resume a paused run
agentTaskRoutes.post("/v1/agent/runs/:id/resume", async (c) => {
  const auth = c.get("auth");
  const orgId = getEffectiveOrgId(c.req.header("X-Organization-Id") || c.req.header("X-RetainDB-Org-Id"), auth);
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({ action: "continue" }));

  const run = await prisma.agentRun.findFirst({ where: { id, orgId, status: "PAUSED" } });
  if (!run) return c.json({ error: "Run not found or not paused" }, 404);

  if (body.action === "stop") {
    await prisma.agentRun.update({
      where: { id },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
    return c.json({ success: true, status: "CANCELLED" });
  }

  // For now just mark as running again — full HITL continuation would need more state
  await prisma.agentRun.update({ where: { id }, data: { status: "RUNNING", hitlMessage: null } });
  return c.json({ success: true, status: "RUNNING" });
});

// ─── Credentials ──────────────────────────────────────────────────────────────

if (!process.env.ENCRYPTION_KEY) {
  throw new Error("ENCRYPTION_KEY environment variable is required but not set. Set a random 32+ character secret.");
}
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

function encrypt(data: Record<string, string>): Record<string, string> {
  const key = Buffer.from(ENCRYPTION_KEY.substring(0, 32).padEnd(32, "0"), "utf8");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("hex"),
    data: encrypted.toString("hex"),
  };
}

function decrypt(encrypted: Record<string, string>): Record<string, string> {
  const key = Buffer.from(ENCRYPTION_KEY.substring(0, 32).padEnd(32, "0"), "utf8");
  const iv = Buffer.from(encrypted.iv, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encrypted.data, "hex")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

agentTaskRoutes.post("/v1/agent/credentials", async (c) => {
  const auth = c.get("auth");
  const orgId = getEffectiveOrgId(c.req.header("X-Organization-Id") || c.req.header("X-RetainDB-Org-Id"), auth);
  const body = await c.req.json();

  const encrypted = encrypt({ username: body.username, password: body.password });

  const cred = await prisma.agentCredential.create({
    data: {
      orgId,
      name: body.name,
      domain: body.domain,
      encrypted,
    },
  });

  return c.json({ credential: { id: cred.id, name: cred.name, domain: cred.domain } });
});

agentTaskRoutes.get("/v1/agent/credentials", async (c) => {
  const auth = c.get("auth");
  const orgId = getEffectiveOrgId(c.req.header("X-Organization-Id") || c.req.header("X-RetainDB-Org-Id"), auth);

  const creds = await prisma.agentCredential.findMany({
    where: { orgId },
    select: { id: true, name: true, domain: true, createdAt: true },
  });

  return c.json({ credentials: creds });
});

agentTaskRoutes.delete("/v1/agent/credentials/:id", async (c) => {
  const auth = c.get("auth");
  const orgId = getEffectiveOrgId(c.req.header("X-Organization-Id") || c.req.header("X-RetainDB-Org-Id"), auth);
  const { id } = c.req.param();

  await prisma.agentCredential.deleteMany({ where: { id, orgId } });
  return c.json({ success: true });
});
