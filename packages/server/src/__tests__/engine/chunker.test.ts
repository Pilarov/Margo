import { describe, it, expect } from "vitest";
import { detectChunkType } from "../../engine/chunker.js";

describe("Chunker: detectChunkType", () => {
  it("should detect TypeScript as code", () => {
    expect(detectChunkType("src/app.ts", "const x = 1;")).toBe("code");
  });

  it("should detect JavaScript as code", () => {
    expect(detectChunkType("index.js", "function foo() {}")).toBe("code");
  });

  it("should detect Python as code", () => {
    expect(detectChunkType("main.py", "def hello(): pass")).toBe("code");
  });

  it("should detect Go as code", () => {
    expect(detectChunkType("main.go", "package main")).toBe("code");
  });

  it("should detect Rust as code", () => {
    expect(detectChunkType("main.rs", "fn main() {}")).toBe("code");
  });

  it("should detect Java as code", () => {
    expect(detectChunkType("App.java", "public class App {}")).toBe("code");
  });

  it("should detect Markdown as documentation", () => {
    expect(detectChunkType("README.md", "# Title")).toBe("documentation");
  });

  it("should detect MDX as documentation", () => {
    expect(detectChunkType("guide.mdx", "# Title")).toBe("documentation");
  });

  it("should detect RST as documentation", () => {
    expect(detectChunkType("docs.rst", "Title\n=====")).toBe("documentation");
  });

  it("should detect JSON as config", () => {
    expect(detectChunkType("package.json", '{"name":"test"}')).toBe("config");
  });

  it("should detect YAML as config", () => {
    expect(detectChunkType("config.yaml", "key: value")).toBe("config");
  });

  it("should detect TOML as config", () => {
    expect(detectChunkType("config.toml", "[section]\nkey = 1")).toBe("config");
  });

  it("should detect XML as config", () => {
    expect(detectChunkType("config.xml", "<root></root>")).toBe("config");
  });

  it("should detect CSS/HTML as text", () => {
    expect(detectChunkType("styles.css", ".class { color: red; }")).toBe("text");
    expect(detectChunkType("index.html", "<html></html>")).toBe("text");
  });

  it("should detect plain text for unknown extension", () => {
    expect(detectChunkType("file.xyz", "some content")).toBe("text");
  });

  it("should detect documentation from content with code blocks when path is missing", () => {
    expect(detectChunkType(undefined, "some ```code``` here")).toBe("documentation");
  });

  it("should detect text when path and code blocks are missing", () => {
    expect(detectChunkType(undefined, "plain content")).toBe("text");
  });

  it("should handle empty inputs", () => {
    const result = detectChunkType();
    expect(typeof result).toBe("string");
  });

  it("should detect schema for migration/schema files", () => {
    expect(detectChunkType("prisma/schema.prisma", "model User {}")).toBe("schema");
  });

  it("should detect api_spec for swagger/openapi files (non-config ext)", () => {
    expect(detectChunkType("openapi.graphql", "type Query { hello: String }")).toBe("api_spec");
  });

  it("should detect dataset from sourceType", () => {
    expect(detectChunkType(undefined, undefined, "dataset")).toBe("dataset");
  });
});
