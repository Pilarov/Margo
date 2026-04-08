import { prisma } from "../db/index.js";

export interface UserMemoryData {
  agentPersonality?: string;
  learnedPreferences?: Record<string, any>;
  selfNotes?: string;
  interactionCount?: number;
}

export async function getUserMemory(userId: string, orgId?: string): Promise<{
  personality: string;
  preferences: Record<string, any>;
  selfNotes: string;
  interactionCount: number;
}> {
  const memory = await prisma.userAgentMemory.findFirst({
    where: {
      userId,
      orgId: orgId ?? null,
    },
  });

  if (!memory) {
    return {
      personality: "helpful, thoughtful, curious, systematic",
      preferences: {},
      selfNotes: "",
      interactionCount: 0,
    };
  }

  return {
    personality: memory.agentPersonality,
    preferences: memory.learnedPreferences as Record<string, any>,
    selfNotes: memory.selfNotes,
    interactionCount: memory.interactionCount,
  };
}

export async function updateUserMemory(
  userId: string,
  orgId: string | undefined,
  data: UserMemoryData
): Promise<void> {
  const existing = await prisma.userAgentMemory.findFirst({
    where: { userId, orgId: orgId ?? null },
    select: { id: true },
  });
  if (existing) {
    await prisma.userAgentMemory.update({
      where: { id: existing.id },
      data: {
        ...(data.agentPersonality && { agentPersonality: data.agentPersonality }),
        ...(data.learnedPreferences && { learnedPreferences: data.learnedPreferences }),
        ...(data.selfNotes !== undefined && { selfNotes: data.selfNotes }),
        ...(data.interactionCount && { interactionCount: { increment: 1 } }),
      },
    });
  } else {
    await prisma.userAgentMemory.create({
      data: {
        userId,
        orgId: orgId ?? null,
        agentPersonality: data.agentPersonality || "helpful, thoughtful, curious, systematic",
        learnedPreferences: data.learnedPreferences || {},
        selfNotes: data.selfNotes || "",
        interactionCount: data.interactionCount || 1,
      },
    });
  }
}

export async function rememberFact(
  userId: string,
  orgId: string | undefined,
  fact: string,
  category: "preference" | "interest" | "knowledge" | "note" = "note"
): Promise<void> {
  const memory = await getUserMemory(userId, orgId);
  
  let existingNotes: any[] = memory.selfNotes ? JSON.parse(memory.selfNotes) : [];
  if (!Array.isArray(existingNotes)) {
    existingNotes = [];
  }
  
  existingNotes.push({
    category,
    fact,
    timestamp: new Date().toISOString(),
  });
  
  await updateUserMemory(userId, orgId, {
    selfNotes: JSON.stringify(existingNotes.slice(-100)),
  });
}

export async function saveResearchSession(
  userId: string,
  orgId: string | undefined,
  projectId: string | undefined,
  data: {
    query: string;
    answer: string;
    sources: any[];
    steps: number;
    durationMs: number;
    isDeepResearch?: boolean;
  }
): Promise<string> {
  const session = await prisma.agentResearchSession.create({
    data: {
      userId,
      orgId: orgId ?? null,
      projectId: projectId || null,
      query: data.query,
      answer: data.answer,
      sources: data.sources as any,
      steps: data.steps,
      durationMs: data.durationMs,
      isDeepResearch: data.isDeepResearch || false,
    },
  });
  
  await updateUserMemory(userId, orgId, {
    interactionCount: 1,
  });
  
  return session.id;
}

export async function getRecentResearch(
  userId: string,
  orgId?: string,
  limit: number = 10
): Promise<Array<{
  id: string;
  query: string;
  answer: string;
  sources: any[];
  createdAt: Date;
}>> {
  const sessions = await prisma.agentResearchSession.findMany({
    where: {
      userId,
      ...(orgId && { orgId }),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      query: true,
      answer: true,
      sources: true,
      createdAt: true,
    },
  });

  return sessions.map((s) => ({
    ...s,
    sources: s.sources as any[],
  }));
}

export async function searchMemory(
  userId: string,
  orgId: string | undefined,
  searchQuery: string
): Promise<{
  relevantResearch: Array<{ query: string; answer: string }>;
  matchingNotes: Array<{ fact: string; category: string }>;
}> {
  const [recentResearch, memory] = await Promise.all([
    getRecentResearch(userId, orgId, 20),
    getUserMemory(userId, orgId),
  ]);
  
  const queryLower = searchQuery.toLowerCase();
  
  const relevantResearch = recentResearch
    .filter(r => 
      r.query.toLowerCase().includes(queryLower) ||
      r.answer.toLowerCase().includes(queryLower)
    )
    .slice(0, 5)
    .map(r => ({ query: r.query, answer: r.answer }));
  
  let matchingNotes: Array<{ fact: string; category: string }> = [];
  try {
    const notes = typeof memory.selfNotes === 'string' 
      ? JSON.parse(memory.selfNotes) 
      : memory.selfNotes;
    
    if (Array.isArray(notes)) {
      matchingNotes = notes
        .filter((n: any) => 
          n.fact?.toLowerCase().includes(queryLower) ||
          n.category?.toLowerCase().includes(queryLower)
        )
        .slice(0, 10)
        .map((n: any) => ({ fact: n.fact, category: n.category }));
    }
  } catch {}
  
  return { relevantResearch, matchingNotes };
}
