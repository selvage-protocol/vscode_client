export async function stopServerAndEditors(
  server: { stop(): Promise<void> } | undefined,
  killEditors: () => void,
  graceMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (server !== undefined) {
      await Promise.race([
        server.stop(),
        new Promise<void>((resolve_) => { timer = setTimeout(resolve_, graceMs); }),
      ]);
    }
  } finally {
    clearTimeout(timer);
    killEditors();
  }
}

/** Safe to call without awaiting from a watchdog or signal handler. */
export async function exitAfterCleanup(code: number, cleanup: () => Promise<void>): Promise<never> {
  try {
    await cleanup();
  } catch (error) {
    console.error('[e2e] cleanup FAILED:', error);
    code ||= 1;
  }
  process.exit(code);
}
