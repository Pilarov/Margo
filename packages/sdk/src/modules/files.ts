/**
 * FilesModule — shared file storage for agents
 *
 * const db = new RetainDB({ apiKey });
 *
 * // Store a file and extract memories from it
 * const { file, memories_created } = await db.files.store(buffer, "brief.pdf", { scope: "ORG" });
 * console.log(file.rdb_uri); // rdb://files/org123/brief.pdf
 *
 * // List files
 * const { files } = await db.files.list({ prefix: "/shared/" });
 */

import { RuntimeClient } from "../core/client.js";

export type FileScope = "USER" | "PROJECT" | "ORG" | "AGENT";

export interface SharedFile {
  id: string;
  org_id: string;
  project_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  path: string;
  name: string;
  mime_type: string | null;
  size: number;
  scope: FileScope;
  is_public: boolean;
  rdb_uri: string;
  memory_id: string | null;
  download_url?: string;
  created_at: string;
  updated_at: string;
}

export interface StoreOptions {
  /** Virtual path. Defaults to "/{filename}" */
  path?: string;
  /** Who can access this file. Default: "PROJECT" */
  scope?: FileScope;
  agent_id?: string;
  /** Extract memories from the file content. Default: true */
  ingest?: boolean;
  user_id?: string;
}

export interface StoreResult extends SharedFile {
  documents_indexed: number;
  memories_created: number;
}

export class FilesModule {
  constructor(
    private readonly client: RuntimeClient,
    private readonly project: string | undefined
  ) {}

  /**
   * Store a file and (by default) extract memories from its content.
   * Pass `ingest: false` to skip memory extraction.
   */
  async store(
    content: Buffer | Blob | File | string,
    filename: string,
    opts: StoreOptions = {}
  ): Promise<StoreResult> {
    // Build form
    let blob: Blob;
    if (typeof content === "string") {
      blob = new Blob([content], { type: "text/plain" });
    } else if (content instanceof Buffer) {
      blob = new Blob([new Uint8Array(content)]);
    } else {
      blob = content as Blob;
    }

    const form = new FormData();
    form.append("file", new File([blob], filename));
    if (opts.path)     form.append("path", opts.path);
    if (opts.scope)    form.append("scope", opts.scope);
    if (opts.agent_id) form.append("agent_id", opts.agent_id);
    if (this.project)  form.append("project_id", this.project);

    const uploadRes = await this.client.request<{ success: boolean; file: SharedFile }>({
      endpoint: "/v1/files",
      method: "POST",
      body: form as unknown as Record<string, unknown>,
      operation: "upload",
    });
    const file = uploadRes.data.file;

    // Ingest by default
    if (opts.ingest === false) {
      return { ...file, documents_indexed: 0, memories_created: 0 };
    }

    const ingestRes = await this.client.request<{
      documents_indexed: number;
      memories_created: number;
      memory_id: string | null;
    }>({
      endpoint: `/v1/files/${file.id}/ingest`,
      method: "POST",
      body: {
        project: this.project,
        user_id: opts.user_id,
        agent_id: opts.agent_id,
      },
      operation: "get",
    });
    const ingest = ingestRes.data;

    return {
      ...file,
      memory_id: ingest.memory_id ?? file.memory_id,
      documents_indexed: ingest.documents_indexed,
      memories_created: ingest.memories_created,
    };
  }

  /** List files. Filter by path prefix, scope, or agent. */
  async list(opts: {
    prefix?: string;
    scope?: FileScope;
    agent_id?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ files: SharedFile[]; total: number }> {
    const params = new URLSearchParams();
    if (opts.prefix)   params.set("prefix", opts.prefix);
    if (opts.scope)    params.set("scope", opts.scope);
    if (opts.agent_id) params.set("agent_id", opts.agent_id);
    if (this.project)  params.set("project_id", this.project);
    if (opts.limit !== undefined)  params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));

    const res = await this.client.request<{ files: SharedFile[]; total: number }>({
      endpoint: `/v1/files?${params}`,
      method: "GET",
      operation: "get",
    });
    return res.data;
  }

  /** Get file metadata and a short-lived download URL. */
  async get(fileId: string): Promise<SharedFile> {
    const res = await this.client.request<{ success: boolean; file: SharedFile }>({
      endpoint: `/v1/files/${fileId}`,
      method: "GET",
      operation: "get",
    });
    return res.data.file;
  }

  /** Soft-delete. Pass `{ hard: true }` to also purge from storage. */
  async delete(fileId: string, opts: { hard?: boolean } = {}): Promise<void> {
    await this.client.request<Record<string, unknown>>({
      endpoint: `/v1/files/${fileId}${opts.hard ? "?hard=true" : ""}`,
      method: "DELETE",
      operation: "writeAck",
    });
  }
}
