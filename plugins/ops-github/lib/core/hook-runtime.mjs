// GENERATED from packages/core/hook-runtime.mjs by scripts/sync-core.mjs. Edit the source, then run `pnpm run sync`.
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/**
 * Dispatch a Cursor hook invocation. The event name comes from argv[2] (preferred)
 * or the payload's hook_event_name. Handlers listed in `failClosed` exit 2 (block)
 * on internal errors; others fail open with an empty response.
 */
export async function runHook(handlers, { failClosed = [] } = {}) {
  let event = process.argv[2];
  try {
    const raw = await readStdin();
    const payload = raw.trim() ? JSON.parse(raw) : {};
    event ??= payload.hook_event_name;
    const handler = handlers[event];
    const response = handler ? await handler(payload) : {};
    process.stdout.write(JSON.stringify(response ?? {}));
  } catch (err) {
    process.stderr.write(`[ops-hook:${event}] ${err.stack ?? err.message}\n`);
    if (failClosed.includes(event)) process.exit(2);
    process.stdout.write("{}");
  }
}
