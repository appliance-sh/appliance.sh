import { runBootstrap, type BootstrapEvent, type BootstrapInput, type BootstrapOptions } from '@appliance.sh/bootstrap';

interface SidecarInput {
  bootstrapInput: BootstrapInput;
  options?: BootstrapOptions;
}

/**
 * Desktop bootstrap sidecar. Spawned by the Tauri Rust side with
 * piped stdin/stdout. Reads one JSON object from stdin (the
 * bootstrap input + options), drives `runBootstrap`, and emits
 * NDJSON to stdout — one BootstrapEvent per line, plus a final
 * `{type: "result", result}` or `{type: "error", error}` line.
 *
 * The Rust side forwards every non-result/non-error line to the
 * frontend via a Tauri Channel. Final result / error becomes the
 * command return value.
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main(): Promise<void> {
  let parsed: SidecarInput;
  try {
    const raw = await readStdin();
    parsed = JSON.parse(raw) as SidecarInput;
  } catch (e) {
    emit({ type: 'error', error: `invalid sidecar input: ${e instanceof Error ? e.message : e}` });
    process.exit(1);
    return;
  }

  try {
    const result = await runBootstrap(parsed.bootstrapInput, {
      ...(parsed.options ?? {}),
      onEvent: (event: BootstrapEvent) => emit(event),
    });
    emit({ type: 'result', result });
    process.exit(0);
  } catch (e) {
    emit({ type: 'error', error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }
}

main();
