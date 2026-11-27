import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { loadConfig, memoryHarvestDir } from "./config.ts";
import type { HookHandler } from "./hook-runtime.ts";
import type { Config, HookPayload, HookResponse } from "./types.ts";

/** Prefix of every automatic memory-harvest request; prompts starting with it are not user turns. */
export const MEMORY_MARKER = "[ops-memory]";

/** Same marker as packages/core/review.ts — kept local so non-review plugins need not sync review.ts. */
const REVIEW_MARKER = "[ops-review]";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface PromptEvent {
  t: "prompt";
  at: number;
  gen: string;
  /** True when the prompt is an ops-review or ops-memory follow-up, not a user turn. */
  system: boolean;
}
interface RequestEvent {
  t: "request";
  at: number;
  gen: string;
  loop: number;
  message: string;
}
type HarvestEvent = PromptEvent | RequestEvent;

const isRequest = (e: HarvestEvent): e is RequestEvent => e.t === "request";

function logPath(conversation: string): string {
  return join(memoryHarvestDir(), `${conversation.replace(/[^\w.-]/g, "_")}.jsonl`);
}

function append(conversation: string, event: HarvestEvent): void {
  mkdirSync(memoryHarvestDir(), { recursive: true });
  appendFileSync(logPath(conversation), `${JSON.stringify(event)}\n`);
}

function readEvents(conversation: string): HarvestEvent[] {
  const path = logPath(conversation);
  if (!existsSync(path)) return [];
  const events: HarvestEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as HarvestEvent);
    } catch {
      // Torn concurrent append; keep the rest.
    }
  }
  return events;
}

function pruneOldLogs(now: number): void {
  const dir = memoryHarvestDir();
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > RETENTION_MS) rmSync(path, { force: true });
    } catch {
      // Another hook removed it first.
    }
  }
}

export function harvestEnabled(cfg: Config = loadConfig()): boolean {
  const env = process.env.OPS_MEMORY_HARVEST?.toLowerCase();
  if (env === "0" || env === "off" || env === "false") return false;
  return cfg.memory.harvest.enabled !== false;
}

function isSystemPrompt(prompt: string | undefined): boolean {
  const text = (prompt ?? "").trimStart();
  return text.startsWith(REVIEW_MARKER) || text.startsWith(MEMORY_MARKER);
}

export function buildHarvestMessage(): string {
  return [
    `${MEMORY_MARKER} Harvest lasting knowledge from this turn only (not the whole chat).`,
    "",
    "Follow the `memory` skill. If this turn stated facts a later conversation would otherwise rediscover — user facts (scope `user`), project decisions/conventions (`project:<owner>/<repo>`), or global components/oss-projects — call `memory_remember` once with atomic present-tense observations (and `memory_forget` for replaced facts). Credentials are rejected; do not dump the transcript.",
    "If nothing lasting belongs in the graph, reply with one short line that says so and stop.",
  ].join("\n");
}

export function recordHarvestPrompt(payload: HookPayload, cfg: Config = loadConfig()): void {
  if (!payload.conversation_id || !harvestEnabled(cfg)) return;
  pruneOldLogs(Date.now());
  append(payload.conversation_id, {
    t: "prompt",
    at: Date.now(),
    gen: payload.generation_id ?? "",
    system: isSystemPrompt(payload.prompt),
  });
}

export function requestHarvest(payload: HookPayload, cfg: Config = loadConfig()): HookResponse {
  if (!payload.conversation_id || payload.status !== "completed" || !harvestEnabled(cfg)) {
    return {};
  }
  const events = readEvents(payload.conversation_id);
  const gen = payload.generation_id ?? "";
  const loop = payload.loop_count ?? 0;

  const answered = events.filter(isRequest).findLast((e) => e.gen === gen && e.loop === loop);
  if (answered) return { followup_message: answered.message };

  const userStart = events.findLastIndex((e) => e.t === "prompt" && !e.system);
  if (userStart < 0) return {};

  const lastPrompt = events.findLast((e) => e.t === "prompt");
  if (lastPrompt?.system) return {};

  const rounds = new Set(
    events
      .slice(userStart + 1)
      .filter(isRequest)
      .map((e) => `${e.gen}:${e.loop}`),
  ).size;
  if (rounds >= cfg.memory.harvest.maxRounds) return {};

  const message = buildHarvestMessage();
  append(payload.conversation_id, { t: "request", at: Date.now(), gen, loop, message });
  return { followup_message: message };
}

/** Hook handlers for ops-memory harvest (prompt recording + stop follow-up). */
export function memoryHarvestHooks(): Partial<Record<string, HookHandler>> {
  return {
    beforeSubmitPrompt(payload) {
      recordHarvestPrompt(payload, loadConfig());
      return { continue: true };
    },
    stop(payload) {
      return requestHarvest(payload, loadConfig());
    },
  };
}
