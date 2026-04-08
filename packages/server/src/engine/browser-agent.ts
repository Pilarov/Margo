import { prisma } from "../db/index.js";

let playwright: any = null;
let chromium: any = null;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
];

async function getBrowser() {
  if (!playwright || !chromium) {
    try {
      playwright = await import("playwright");
      chromium = await playwright.chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage",
        ],
      });
    } catch (error) {
      console.error("[BrowserAgent] Failed to launch browser:", error);
      throw new Error("Playwright browser failed to launch. Make sure Chromium is installed: npx playwright install chromium");
    }
  }
  return { playwright, chromium };
}

export async function newAntiDetectPage() {
  const { chromium: browser } = await getBrowser();
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1280 + Math.floor(Math.random() * 200), height: 800 + Math.floor(Math.random() * 100) },
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    },
  });
  // Remove navigator.webdriver
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return context.newPage();
}

function randomDelay(min = 300, max = 1200): Promise<void> {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

export interface BrowseConfig {
  url: string;
  action?: "click" | "type" | "scroll" | "screenshot" | "extract";
  selector?: string;
  text?: string;
  extractWhat?: "text" | "links" | "images" | "all";
  maxWaitMs?: number;
}

export interface BrowseResult {
  url: string;
  title?: string;
  content?: string;
  links?: string[];
  images?: string[];
  screenshot?: string;
  action?: string;
  error?: string;
}

export async function browseWeb(config: BrowseConfig): Promise<BrowseResult> {
  const { chromium: browser } = await getBrowser();

  const page = await browser.newPage();

  try {
    await page.goto(config.url, {
      waitUntil: "domcontentloaded",
      timeout: config.maxWaitMs || 30000,
    });

    const title = await page.title();

    let content = "";
    let links: string[] = [];
    let images: string[] = [];

    if (config.action === "screenshot") {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        url: config.url,
        title,
        action: "screenshot",
        screenshot,
      };
    }

    if (config.action === "extract" || !config.action) {
      content = await page.content();

      const extractWhat = config.extractWhat || "text";

      if (extractWhat === "text" || extractWhat === "all") {
        content = await page.evaluate(() => {
          const body = document.body;
          const text = body?.innerText || "";
          return text.substring(0, 50000);
        });
      }

      if (extractWhat === "links" || extractWhat === "all") {
        links = await page.evaluate(() => {
          return Array.from(document.querySelectorAll("a[href]"))
            .map((a) => (a as HTMLAnchorElement).href)
            .filter((href) => href.startsWith("http"));
        });
      }

      if (extractWhat === "images" || extractWhat === "all") {
        images = await page.evaluate(() => {
          return Array.from(document.querySelectorAll("img[src]"))
            .map((img) => (img as HTMLImageElement).src)
            .filter((src) => src.startsWith("http"));
        });
      }
    }

    if (config.action === "click" && config.selector) {
      await page.click(config.selector);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      content = await page.evaluate(() => document.body?.innerText?.substring(0, 50000) || "");
    }

    if (config.action === "type" && config.selector && config.text) {
      await page.fill(config.selector, config.text);
      content = await page.evaluate(() => document.body?.innerText?.substring(0, 50000) || "");
    }

    if (config.action === "scroll") {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
      content = await page.evaluate(() => document.body?.innerText?.substring(0, 50000) || "");
    }

    return {
      url: page.url(),
      title,
      content: content?.substring(0, 50000),
      links: links.slice(0, 50),
      images: images.slice(0, 20),
    };
  } catch (error: any) {
    return {
      url: config.url,
      error: error.message,
    };
  } finally {
    await page.close();
  }
}

/**
 * Get full raw HTML of a page (for structured extraction).
 */
export async function getPageHTML(page: any): Promise<string> {
  return page.content();
}

/**
 * Take a screenshot and return base64 PNG.
 */
export async function takeScreenshot(page: any): Promise<string> {
  const buf = await page.screenshot({ encoding: "base64", type: "png" });
  return buf as string;
}

/**
 * Navigate a page to a URL, wait for content, return title + text.
 */
export async function navigatePage(
  page: any,
  url: string,
  timeoutMs = 30000
): Promise<{ title: string; text: string; finalUrl: string }> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await randomDelay(300, 800);
  await bypassCookieBanner(page);
  const title = await page.title();
  const text = await page.evaluate(() => document.body?.innerText?.substring(0, 60000) || "");
  return { title, text, finalUrl: page.url() };
}

/**
 * Click the best-matching element for a human description using text/aria matching.
 */
export async function clickBestMatch(page: any, description: string): Promise<boolean> {
  // Try various locator strategies
  const strategies = [
    () => page.getByRole("button", { name: new RegExp(description, "i") }).first().click({ timeout: 3000 }),
    () => page.getByRole("link", { name: new RegExp(description, "i") }).first().click({ timeout: 3000 }),
    () => page.getByText(new RegExp(description, "i")).first().click({ timeout: 3000 }),
    () => page.locator(`[aria-label*="${description}" i]`).first().click({ timeout: 3000 }),
    () => page.locator(`[title*="${description}" i]`).first().click({ timeout: 3000 }),
  ];

  for (const strategy of strategies) {
    try {
      await strategy();
      await randomDelay(300, 700);
      return true;
    } catch {}
  }
  return false;
}

/**
 * Fill multiple form fields by label/placeholder/name.
 */
export async function fillForm(page: any, fields: Record<string, string>): Promise<void> {
  for (const [label, value] of Object.entries(fields)) {
    const strategies = [
      () => page.getByLabel(new RegExp(label, "i")).fill(value),
      () => page.getByPlaceholder(new RegExp(label, "i")).fill(value),
      () => page.locator(`[name="${label}"]`).fill(value),
      () => page.locator(`input[name*="${label}" i]`).first().fill(value),
    ];
    for (const strategy of strategies) {
      try {
        await strategy();
        await randomDelay(100, 300);
        break;
      } catch {}
    }
  }
}

/**
 * Scroll page incrementally to load lazy-loaded content.
 */
export async function infiniteScroll(page: any, maxScrolls = 5): Promise<void> {
  for (let i = 0; i < maxScrolls; i++) {
    const prevHeight = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await randomDelay(800, 1500);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === prevHeight) break;
  }
}

/**
 * Try to dismiss cookie consent banners.
 */
export async function bypassCookieBanner(page: any): Promise<void> {
  const selectors = [
    'button:has-text("Accept")',
    'button:has-text("Accept All")',
    'button:has-text("Accept Cookies")',
    'button:has-text("I Accept")',
    'button:has-text("Agree")',
    'button:has-text("OK")',
    '[id*="cookie"] button',
    '[class*="cookie"] button',
    '[id*="consent"] button',
    '[class*="consent"] button',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await randomDelay(200, 500);
        return;
      }
    } catch {}
  }
}

/**
 * Extract visible links from current page.
 */
export async function getPageLinks(page: any): Promise<Array<{ url: string; text: string }>> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .map((a) => ({ url: (a as HTMLAnchorElement).href, text: (a as HTMLAnchorElement).innerText?.trim().substring(0, 100) }))
      .filter((l) => l.url.startsWith("http"))
      .slice(0, 100)
  );
}

export async function deepResearch(
  query: string,
  maxSources: number = 5
): Promise<{
  findings: Array<{ url: string; title: string; content: string }>;
  summary: string;
}> {
  const { chromium: browser } = await getBrowser();

  const page = await browser.newPage();
  const findings: Array<{ url: string; title: string; content: string }> = [];

  try {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${maxSources * 2}`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    await page.waitForSelector("a[href]", { timeout: 10000 }).catch(() => {});

    const searchResults = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("a[href]"));
      return links
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((href) =>
          href.startsWith("http") &&
          !href.includes("google.com") &&
          !href.includes("youtube.com") &&
          !href.includes("facebook.com")
        )
        .slice(0, maxSources * 2);
    });

    const uniqueUrls = [...new Set(searchResults as string[])].slice(0, maxSources);

    for (const url of uniqueUrls) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
        const title = await page.title();
        const content = (await page.evaluate(() => {
          return document.body?.innerText?.substring(0, 8000) || "";
        })) as string;

        if (content.length > 100) {
          findings.push({ url, title, content });
        }
      } catch {}
    }

    return {
      findings,
      summary: `Researched "${query}". Found ${findings.length} sources with relevant content.`,
    };
  } catch (error: any) {
    return {
      findings,
      summary: `Research failed: ${error.message}`,
    };
  } finally {
    await page.close();
  }
}

export async function closeBrowser() {
  if (chromium) {
    await chromium.close();
    chromium = null;
    playwright = null;
  }
}
