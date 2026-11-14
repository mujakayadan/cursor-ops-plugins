import type { HookPayload, HookResponse } from "./types.ts";

export type HookHandler = (payload: HookPayload) => HookResponse | Promise<HookResponse>;

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/**
 * Dispatch a Cursor hook invocation. The event name comes from argv[2] (preferred)
 * or the payload's hook_event_name. Handlers listed in `failClosed` exit 2 (block)
 * on internal errors; others fail open with an empty response.
 */
export async function runHook(
  handlers: Partial<Record<string, HookHandler>>,
  { failClosed = [] }: { failClosed?: string[] } = {},
): Promise<void> {
  let event = process.argv[2];
  try {
    const raw = await readStdin();
    const payload = (raw.trim() ? JSON.parse(raw) : {}) as HookPayload;
    event ??= payload.hook_event_name;
    const handler = event ? handlers[event] : undefined;
    const response = handler ? await handler(payload) : {};
    process.stdout.write(JSON.stringify(response));
  } catch (err) {
    const error = err as Error;
    process.stderr.write(`[ops-hook:${event}] ${error.stack ?? error.message}\n`);
    if (event && failClosed.includes(event)) process.exit(2);
    process.stdout.write("{}");
  }
}
