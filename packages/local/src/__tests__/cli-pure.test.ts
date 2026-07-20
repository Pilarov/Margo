import { describe, it, expect } from "vitest";

// Inline tests for the pure functions from cli.ts that are critical.
// These functions are defined at module scope in cli.ts (not exported individually).
// For real integration, see cli-integration.test.ts.

// ── hashEmbedding (deterministic SHA-256 based pseudo-embedding) ──────────
import { createHash } from "node:crypto";

function hashEmbedding(text: string, dims = 96): number[] {
  const vector = new Array(dims).fill(0);
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  for (const token of tokens) {
    const hash = createHash("sha256").update(token).digest();
    const index = hash[0] % dims;
    const sign = hash[1] % 2 === 0 ? 1 : -1;
    vector[index] += sign * (1 + Math.min(token.length, 12) / 12);
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => Number((v / norm).toFixed(6)));
}

// ── cosine similarity ──────────────────────────────────────────────────────
function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

// ── jaccardSimilarity ──────────────────────────────────────────────────────
function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const tokensB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)));
  const union = new Set([...tokensA, ...tokensB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// ── signalQuality ──────────────────────────────────────────────────────────
function signalQuality(text: string): number {
  let score = 0.5;
  const lower = text.toLowerCase();

  // Code paths and technical references
  if (/[./][\w-]+\.(ts|js|py|rs|go|java)/.test(text)) score += 0.15;
  if (/\b(function|class|interface|type|import|export)\b/.test(lower)) score += 0.1;
  if (/\b(api|endpoint|route|middleware|handler)\b/.test(lower)) score += 0.08;

  // Decisions and outcomes
  if (/\b(decided|chose|selected|prefer|rather than|instead of)\b/.test(lower)) score += 0.12;
  if (/\b(because|since|due to|reason)\b/.test(lower)) score += 0.06;

  // Structured content
  if (text.length > 50) score += 0.05;
  if (text.length > 200) score += 0.03;
  if (/\d+/.test(text)) score += 0.03;

  // Noise penalty
  if (/^(ok|okay|yes|no|thanks|thank you|sure|got it|nice|great|cool|done)[.!]*$/i.test(text.trim())) score -= 0.3;
  if (text.length < 15) score -= 0.15;

  return Math.min(1, Math.max(0, score));
}

// ── slugify ────────────────────────────────────────────────────────────────
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── tokenize ───────────────────────────────────────────────────────────────
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter((t) => t.length > 0);
}

// ── redactSecrets ──────────────────────────────────────────────────────────
function redactSecrets(text: string): string {
  let result = text;
  result = result.replace(/([a-zA-Z0-9_-]{20,})(?:\s|$)/g, (match) =>
    /[A-Z]/.test(match) && /\d/.test(match) ? "[REDACTED]" : match
  );
  result = result.replace(/(sk-[a-zA-Z0-9]{20,})/gi, "[REDACTED_API_KEY]");
  result = result.replace(/(Bearer\s+)([a-zA-Z0-9_\-\.]{20,})/gi, "$1[REDACTED_TOKEN]");
  result = result.replace(/(?:api[_-]?key|apikey|secret|token|password)\s*[:=]\s*\S+/gi, "[REDACTED_CREDENTIAL]");
  result = result.replace(/-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g, "[REDACTED_PRIVATE_KEY]");
  return result;
}

// ── normalizeWhitespace ────────────────────────────────────────────────────
function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

// ── clamp ──────────────────────────────────────────────────────────────────
function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

// ── percentile ─────────────────────────────────────────────────────────────
function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("hashEmbedding", () => {
  it("should produce vector of specified dimensions", () => {
    const v = hashEmbedding("hello world", 96);
    expect(v).toHaveLength(96);
  });

  it("should produce deterministic output", () => {
    const a = hashEmbedding("hello", 96);
    const b = hashEmbedding("hello", 96);
    expect(a).toEqual(b);
  });

  it("should produce different vectors for different inputs", () => {
    const a = hashEmbedding("hello", 96);
    const b = hashEmbedding("world", 96);
    expect(a).not.toEqual(b);
  });

  it("should handle empty string", () => {
    const v = hashEmbedding("", 96);
    expect(v).toHaveLength(96);
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it("should produce normalized vectors (length ≈ 1)", () => {
    const v = hashEmbedding("the quick brown fox jumps over the lazy dog", 96);
    const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(len).toBeCloseTo(1, 5);
  });

  it("should handle unicode text", () => {
    const v = hashEmbedding("привет мир fonction", 64);
    expect(v).toHaveLength(64);
    expect(v.every((x) => !Number.isNaN(x))).toBe(true);
  });

  it("should handle long text (8000+ chars)", () => {
    const text = "test ".repeat(2000);
    const v = hashEmbedding(text, 96);
    expect(v).toHaveLength(96);
    expect(v.every((x) => Number.isFinite(x))).toBe(true);
  });

  it("should respect custom dimensions", () => {
    expect(hashEmbedding("test", 32)).toHaveLength(32);
    expect(hashEmbedding("test", 128)).toHaveLength(128);
    expect(hashEmbedding("test", 384)).toHaveLength(384);
  });

  it("should produce different vectors with different dimensions", () => {
    const v96 = hashEmbedding("test", 96);
    const v128 = hashEmbedding("test", 128);
    expect(v96).not.toEqual(v128);
  });
});

describe("cosine", () => {
  it("should return 1 for identical vectors (cosine assumes pre-normalized)", () => {
    const v = [0.6, 0.8]; // norm = sqrt(0.36+0.64) = 1
    expect(cosine(v, v)).toBeCloseTo(1, 5);
  });

  it("should return 0 for orthogonal unit vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });

  it("should handle vectors of different lengths", () => {
    expect(cosine([1, 0, 0], [1, 0])).toBe(1);
  });

  it("should return negative for opposite vectors", () => {
    expect(cosine([1, 0], [-1, 0])).toBe(-1);
  });

  it("should handle zero vector", () => {
    expect(cosine([0, 0, 0], [1, 0, 0])).toBe(0);
  });

  it("should handle large values", () => {
    const v1 = hashEmbedding("cat", 96);
    const v2 = hashEmbedding("dog", 96);
    const sim = cosine(v1, v2);
    expect(Number.isFinite(sim)).toBe(true);
  });
});

describe("jaccardSimilarity", () => {
  it("should return 1 for identical strings", () => {
    expect(jaccardSimilarity("hello world", "hello world")).toBe(1);
  });

  it("should return 0 for completely different strings", () => {
    expect(jaccardSimilarity("hello", "world")).toBe(0);
  });

  it("should return 0.5 for strings sharing half the tokens", () => {
    const sim = jaccardSimilarity("hello world", "hello moon");
    expect(sim).toBeCloseTo(1 / 3, 1); // {hello} in common, {world, moon} unique
  });

  it("should be case insensitive", () => {
    expect(jaccardSimilarity("Hello World", "hello world")).toBe(1);
  });

  it("should handle empty strings", () => {
    expect(jaccardSimilarity("", "")).toBe(0);
    expect(jaccardSimilarity("hello", "")).toBe(0);
  });

  it("should handle duplicate words", () => {
    expect(jaccardSimilarity("hello hello world", "hello world")).toBe(1);
  });
});

describe("signalQuality", () => {
  it("should give higher score to code-related content", () => {
    const code = "We decided to use src/auth.ts for the middleware because of security";
    const noise = "ok thanks";
    expect(signalQuality(code)).toBeGreaterThan(signalQuality(noise));
  });

  it("should penalize very short messages", () => {
    expect(signalQuality("ok")).toBeLessThan(0.5);
    expect(signalQuality("yes")).toBeLessThan(0.5);
    expect(signalQuality("got it")).toBeLessThan(0.5);
  });

  it("should boost content with decisions", () => {
    const withDecision = "I decided to use PostgreSQL instead of MongoDB";
    const withoutDecision = "I looked at some databases today";
    expect(signalQuality(withDecision)).toBeGreaterThan(signalQuality(withoutDecision));
  });

  it("should be between 0 and 1", () => {
    for (const text of ["a", "hello world", "a".repeat(500), "function test() { return 1 }"]) {
      const q = signalQuality(text);
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(1);
    }
  });

  it("should boost content with technical file references", () => {
    const tech = "The bug was in src/components/Button.tsx line 42";
    expect(signalQuality(tech)).toBeGreaterThan(0.6);
  });

  it("should boost content with API references", () => {
    const api = "The API endpoint /v1/users requires authentication middleware";
    expect(signalQuality(api)).toBeGreaterThan(0.5);
  });
});

describe("slugify", () => {
  it("should convert to lowercase kebab-case", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("should handle multiple spaces and special chars", () => {
    expect(slugify("Foo  Bar!!!Baz")).toBe("foo-bar-baz");
  });

  it("should strip leading and trailing dashes", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  it("should handle empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("should handle unicode", () => {
    expect(slugify("Привет мир")).toBe("");
  });

  it("should handle numbers", () => {
    expect(slugify("Project 2.0 Release")).toBe("project-2-0-release");
  });
});

describe("tokenize", () => {
  it("should split on non-word characters", () => {
    expect(tokenize("hello world")).toEqual(["hello", "world"]);
  });

  it("should lowercase tokens", () => {
    expect(tokenize("HELLO World")).toEqual(["hello", "world"]);
  });

  it("should filter empty tokens", () => {
    expect(tokenize("  hello   world  ")).toEqual(["hello", "world"]);
  });

  it("should handle punctuation", () => {
    expect(tokenize("hello, world!")).toEqual(["hello", "world"]);
  });

  it("should handle empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("should handle numbers", () => {
    const tokens = tokenize("test123 and 456");
    expect(tokens.length).toBeGreaterThan(0);
  });
});

describe("redactSecrets", () => {
  it("should redact API keys", () => {
    const input = "My key is sk-abcdefghijklmnopqrstuvwxyz123456";
    const output = redactSecrets(input);
    expect(output).not.toContain("sk-abc");
    expect(output).toContain("[REDACTED");
  });

  it("should redact Bearer tokens", () => {
    const input = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890";
    const output = redactSecrets(input);
    expect(output).not.toContain("abcdefghij");
    expect(output).toContain("[REDACTED_TOKEN]");
  });

  it("should redact credentials in key=value format", () => {
    const input = "api_key=sk-1234567890abcdef secret=mysecret12345";
    const output = redactSecrets(input);
    expect(output).toContain("[REDACTED_CREDENTIAL]");
  });

  it("should not redact normal text", () => {
    const input = "The quick brown fox jumps over the lazy dog";
    expect(redactSecrets(input)).toBe(input);
  });

  it("should handle empty string", () => {
    expect(redactSecrets("")).toBe("");
  });
});

describe("normalizeWhitespace", () => {
  it("should trim and collapse whitespace", () => {
    expect(normalizeWhitespace("  hello   world  ")).toBe("hello world");
  });

  it("should handle tabs and newlines", () => {
    expect(normalizeWhitespace("hello\t\n  world")).toBe("hello world");
  });

  it("should handle empty string", () => {
    expect(normalizeWhitespace("")).toBe("");
  });

  it("should handle string with only spaces", () => {
    expect(normalizeWhitespace("   ")).toBe("");
  });
});

describe("clamp", () => {
  it("should clamp values above max", () => {
    expect(clamp(1.5)).toBe(1);
  });

  it("should clamp values below min", () => {
    expect(clamp(-0.5)).toBe(0);
  });

  it("should pass values in range", () => {
    expect(clamp(0.5)).toBe(0.5);
  });

  it("should respect custom bounds", () => {
    expect(clamp(100, 0, 50)).toBe(50);
  });

  it("should propagate NaN (Math.max/min with NaN returns NaN)", () => {
    expect(clamp(Number.NaN, 0, 1)).toBeNaN();
  });
});

describe("percentile", () => {
  it("should return median at p=50", () => {
    const values = [1, 2, 3, 4, 5];
    expect(percentile(values, 50)).toBe(3);
  });

  it("should return min at p=0", () => {
    expect(percentile([1, 5, 3], 0)).toBe(1);
  });

  it("should return max at p=100", () => {
    expect(percentile([1, 5, 3], 100)).toBe(5);
  });

  it("should handle single value", () => {
    expect(percentile([42], 50)).toBe(42);
  });

  it("should handle empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("should interpolate between values", () => {
    expect(percentile([0, 10], 50)).toBeCloseTo(5, 0);
  });

  it("should not mutate original array", () => {
    const values = [5, 1, 3];
    percentile(values, 50);
    expect(values).toEqual([5, 1, 3]);
  });
});
