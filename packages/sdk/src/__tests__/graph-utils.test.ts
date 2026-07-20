import { describe, it, expect } from "vitest";
import { memoryGraphToMermaid } from "../graph-utils.js";

describe("SDK Graph Utils: memoryGraphToMermaid", () => {
  it("should produce valid Mermaid graph header for empty graph", () => {
    const result = memoryGraphToMermaid({ nodes: [], edges: [] });
    expect(result).toContain("flowchart LR");
  });

  it("should include node definitions with sanitized IDs", () => {
    const result = memoryGraphToMermaid({
      nodes: [{ id: "n1", label: "Node 1" }],
      edges: [],
    });
    expect(result).toContain("n_n1");
  });

  it("should include edge definitions with source/target", () => {
    const result = memoryGraphToMermaid({
      nodes: [
        { id: "n1", label: "Node 1" },
        { id: "n2", label: "Node 2" },
      ],
      edges: [{ source: "n1", target: "n2", type: "relates" }],
    });
    expect(result).toContain("n_n1");
    expect(result).toContain("n_n2");
    expect(result).toContain("-->");
    expect(result).toContain("relates");
  });

  it("should sanitize node IDs (replace special chars with underscore, prefix n_)", () => {
    const result = memoryGraphToMermaid({
      nodes: [{ id: "node with spaces", label: "Test" }],
      edges: [],
    });
    // sanitizeId("node with spaces") = "n_node_with_spaces"
    expect(result).toContain("n_node_with_spaces");
  });

  it("should not crash on undefined labels", () => {
    const result = memoryGraphToMermaid({
      nodes: [{ id: "n1" }],
      edges: [],
    });
    expect(result).toContain("n_n1");
  });

  it("should handle edges without type", () => {
    const result = memoryGraphToMermaid({
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      edges: [{ source: "a", target: "b" }],
    });
    expect(result).toContain("-->");
  });

  it("should escape quotes in labels", () => {
    const result = memoryGraphToMermaid({
      nodes: [{ id: "x", label: 'say "hello"' }],
      edges: [],
    });
    // Quotes should be escaped
    expect(result).toContain('\\"');
  });

  it("should handle many nodes", () => {
    const nodes = Array.from({ length: 10 }, (_, i) => ({
      id: `node-${i}`,
      label: `Node ${i}`,
    }));
    const result = memoryGraphToMermaid({ nodes, edges: [] });
    for (let i = 0; i < 10; i++) {
      expect(result).toContain(`n_node_${i}`);
    }
  });

  it("should produce valid Mermaid syntax (no syntax errors)", () => {
    const result = memoryGraphToMermaid({
      nodes: [
        { id: "start", label: "Start" },
        { id: "end", label: "End" },
      ],
      edges: [{ source: "start", target: "end", type: "flow" }],
    });
    const lines = result.split("\n");
    expect(lines[0]).toBe("flowchart LR");
    // Each line should have proper Mermaid syntax
    for (const line of lines.slice(1)) {
      expect(
        line.includes("-->") ||
        line.includes("[") ||
        line.trim() === ""
      ).toBe(true);
    }
  });

  it("should handle empty string labels", () => {
    const result = memoryGraphToMermaid({
      nodes: [{ id: "n1", label: "" }],
      edges: [],
    });
    expect(result).toContain("n_n1");
  });
});
