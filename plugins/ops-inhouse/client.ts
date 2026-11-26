import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { ToolError } from "./lib/core/schema-helpers.ts";

const DEFAULT_API = "https://api.inhouse.ai";
const TIMEOUT_MS = 60_000;
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export interface InhouseStatus {
  ready: boolean;
  host: string | null;
}

interface Endpoint {
  base: string;
  token: string;
  host: string;
}

function endpoint(env: NodeJS.ProcessEnv = process.env): Endpoint | null {
  const token = env.INHOUSE_ACCESS_TOKEN?.trim() ?? "";
  if (!token) return null;
  const raw = env.INHOUSE_API_URL?.trim() || DEFAULT_API;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError("INHOUSE_API_URL must be an absolute URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ToolError("INHOUSE_API_URL must be https, or http on localhost");
  }
  return { base: url.origin.replace(/\/$/, ""), token, host: url.host };
}

export function inhouseStatus(env: NodeJS.ProcessEnv = process.env): InhouseStatus {
  try {
    const ep = endpoint(env);
    return { ready: Boolean(ep), host: ep?.host ?? null };
  } catch {
    return { ready: false, host: null };
  }
}

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const ep = endpoint(env);
  if (!ep) {
    throw new ToolError(
      "Set INHOUSE_ACCESS_TOKEN to a Bearer access token from a signed-in Inhouse session. Do not paste the token into chat.",
    );
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ep.token}`,
    Accept: "application/json",
  };
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${ep.base}${path}`, init).catch((err: Error) => {
    throw new ToolError(`${ep.host} unreachable: ${err.message}`);
  });
  const text = await res.text();
  let data: unknown = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text.slice(0, 500);
    }
  }
  if (!res.ok) {
    const detail =
      typeof data === "object" && data && "message" in data
        ? String((data as { message: unknown }).message)
        : typeof data === "string"
          ? data
          : text.slice(0, 200);
    throw new ToolError(
      `${ep.host} ${method} ${path} returned ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return data as T;
}

export interface InhouseProfile {
  userId: string | null;
  firstName: string | null;
  lastName: string | null;
  subscriptionStatus: string | null;
  subscriptionType: string | null;
  threadsRemainingAsk: number | null;
  threadsRemainingDraft: number | null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Account summary from GET /api/user/get-metadata (safe subset; no phone). */
export async function getInfo(env?: NodeJS.ProcessEnv): Promise<InhouseProfile> {
  const raw = await api<Record<string, unknown>>("GET", "/api/user/get-metadata", undefined, env);
  return {
    userId: optionalString(raw.user_id),
    firstName: optionalString(raw.first_name),
    lastName: optionalString(raw.last_name),
    subscriptionStatus: optionalString(raw.subscription_status),
    subscriptionType: optionalString(raw.subscription_type),
    threadsRemainingAsk: optionalNumber(raw.threads_remaining_ask),
    threadsRemainingDraft: optionalNumber(raw.threads_remaining_draft),
  };
}

export function listThreads(env?: NodeJS.ProcessEnv) {
  return api<unknown>("GET", "/api/user/list-threads", undefined, env);
}

export function documentLibrary(env?: NodeJS.ProcessEnv) {
  return api<unknown>("GET", "/api/user/document-library", undefined, env);
}

export function listMessages(threadId: string, source = "ops", env?: NodeJS.ProcessEnv) {
  const q = encodeURIComponent(source);
  return api<unknown>(
    "GET",
    `/api/thread/${encodeURIComponent(threadId)}/list-messages?source=${q}`,
    undefined,
    env,
  );
}

interface PresignResponse {
  url?: string;
  upload_url?: string;
  presigned_url?: string;
  storage_id?: string;
  id?: string;
  attachment_id?: string;
  [key: string]: unknown;
}

function pickUploadUrl(data: PresignResponse): string {
  const url =
    (typeof data.url === "string" && data.url) ||
    (typeof data.upload_url === "string" && data.upload_url) ||
    (typeof data.presigned_url === "string" && data.presigned_url) ||
    (typeof data.presignedUrl === "string" && data.presignedUrl);
  if (!url) throw new ToolError("presign response missing upload URL");
  return url;
}

function pickStorageId(data: PresignResponse): string {
  const id =
    (typeof data.storage_id === "string" && data.storage_id) ||
    (typeof data.id === "string" && data.id) ||
    (typeof data.attachment_id === "string" && data.attachment_id);
  if (!id) throw new ToolError("presign response missing storage id");
  return id;
}

/** Presign, PUT bytes, complete. Returns storage id and file name. */
export async function uploadFile(
  absolutePath: string,
  name: string | undefined,
  env?: NodeJS.ProcessEnv,
): Promise<{ storageId: string; name: string; bytes: number }> {
  const st = statSync(absolutePath);
  if (!st.isFile()) throw new ToolError("path is not a file");
  if (st.size > UPLOAD_MAX_BYTES) {
    throw new ToolError(`file larger than ${UPLOAD_MAX_BYTES} bytes`);
  }
  const fileName = (name?.trim() || basename(absolutePath)).trim();
  if (!fileName) throw new ToolError("file needs a name");
  const raw = await api<PresignResponse | { data: PresignResponse }>(
    "POST",
    "/api/get-presigned-upload-url",
    { file_name: fileName },
    env,
  );
  const data = "data" in raw && raw.data && typeof raw.data === "object" ? raw.data : raw;
  const uploadUrl = pickUploadUrl(data as PresignResponse);
  const storageId = pickStorageId(data as PresignResponse);
  const bytes = readFileSync(absolutePath);
  const put = await fetch(uploadUrl, {
    method: "PUT",
    body: bytes,
    headers: { "Content-Type": "application/octet-stream" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err: Error) => {
    throw new ToolError(`upload PUT failed: ${err.message}`);
  });
  if (!put.ok) {
    throw new ToolError(`upload PUT returned ${put.status}`);
  }
  await api("POST", `/api/attachments/${encodeURIComponent(storageId)}/complete`, null, env);
  return { storageId, name: fileName, bytes: st.size };
}
