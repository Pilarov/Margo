import { describe, it, expect } from "vitest";
import { embedding } from "../config.js";

describe("LocalConfig", () => {
  describe("embedding defaults", () => {
    it("should default provider to hash", () => {
      expect(embedding.provider).toBe("hash");
    });

    it("should default model to Xenova/all-MiniLM-L6-v2", () => {
      expect(embedding.model).toBe("Xenova/all-MiniLM-L6-v2");
    });

    it("should have valid provider values", () => {
      expect(["hash", "local-transformers"]).toContain(embedding.provider);
    });

    it("should have non-empty model string", () => {
      expect(embedding.model.length).toBeGreaterThan(0);
    });
  });
});
