/**
 * Playwright connector — scrapes JS-rendered pages using a real browser.
 * Falls back to standard fetch if Playwright is unavailable.
 */
import { ingestDocument } from "../engine/ingest.js";
import {
  bypassCookieBanner,
  getPageLinks,
  infiniteScroll,
  newAntiDetectPage,
} from "../engine/browser-agent.js";
import { extractStructuredHtml } from "./html-structure.js";
import { generateSourceProfile } from "../engine/source-extraction.js";

interface PlaywrightConfig {
  url: string;
  maxPages?: number;
  extractMode?: "text" | "structured" | "markdown";
  maxDepth?: number;
}

function getDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function isSameDomain(base: string, target: string): boolean {
  try {
    return new URL(target).hostname === new URL(base).hostname;
  } catch { return false; }
}

export async function syncPlaywright(
  sourceId: string,
  projectId: string,
  config: PlaywrightConfig
) {
  const { url, maxPages = 10, extractMode = "text", maxDepth = 1 } = config;

  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [{ url, depth: 0 }];
  let indexed = 0;
  const errors: string[] = [];

  while (queue.length > 0 && visited.size < maxPages) {
    const current = queue.shift()!;
    const currentUrl = current.url;
    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    console.log(`[Playwright] Visiting: ${currentUrl}`);

    try {
      const page = await newAntiDetectPage();
      try {
        await page.goto(currentUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
        await bypassCookieBanner(page);
        await infiniteScroll(page, 2);

        const finalUrl = page.url();
        const title = (await page.title()) || finalUrl || currentUrl;
        const html = await page.content();
        const structured = extractStructuredHtml(html, finalUrl);
        const text =
          extractMode === "text"
            ? await page.evaluate(() => document.body?.innerText?.substring(0, 60000) || "")
            : structured.content;
        const links = (await getPageLinks(page)).map((link) => link.url);

        if (text.length < 50) continue;

        await ingestDocument({
          sourceId,
          projectId,
          externalId: finalUrl,
          title,
          content: text,
          webUrl: finalUrl,
          metadata: {
            ...structured.metadata,
            source: "playwright",
            source_type: "web",
            extractor: "playwright",
            extractMode,
            domain: getDomain(finalUrl),
            characterCount: text.length,
            render_mode: "js",
            depth: current.depth,
            design: structured.design,
            structuredDataTypes: structured.structuredData
              .map((d) => d["@type"])
              .filter(Boolean),
          },
          sourceType: "web",
          ingestionProfile: "web_docs",
        });

        indexed++;

        if (visited.size < maxPages && current.depth < maxDepth) {
          for (const link of links) {
            if (
              !visited.has(link) &&
              !queue.some((entry) => entry.url === link) &&
              isSameDomain(url, link)
            ) {
              queue.push({ url: link, depth: current.depth + 1 });
            }
          }
        }
      } finally {
        await page.context().close().catch(() => undefined);
      }
    } catch (err: any) {
      errors.push(`${currentUrl}: ${err.message}`);
      console.error(`[Playwright] Error on ${currentUrl}:`, err.message);
    }
  }

  if (indexed > 0) {
    const rootUrl = (() => { try { return new URL(url).origin; } catch { return url; } })();
    generateSourceProfile(sourceId, projectId, { sourceType: "web", rootUrl }).catch(() => {});
  }

  return {
    documentsIndexed: indexed,
    pagesVisited: visited.size,
    errors: errors.slice(0, 10),
  };
}
