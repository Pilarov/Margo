/**
 * Load .env before any other module runs (so OPENAI_API_KEY, DATABASE_URL, etc. are set).
 * Must be the first import in index.ts.
 */
import { config } from "dotenv";

// For local runs, let the root .env override stale shell exports.
// Then load src/.env only as a fallback so it does not silently swap databases.
config({ path: ".env", override: true });
config({ path: "src/.env" });
