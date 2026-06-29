import * as os from 'node:os';
import * as path from 'node:path';
import {
  latestGhcrTag,
  runApiServerUpdate,
  runBaselineUpdate,
  runBootstrap,
  runStateDemotion,
  runStatePromotion,
  runTeardown,
  type ApiServerUpdateInput,
  type ApiServerUpdateOptions,
  type BaselineUpdateInput,
  type BaselineUpdateOptions,
  type BootstrapEvent,
  type BootstrapInput,
  type BootstrapOptions,
  type LatestGhcrTagInput,
  type StateDemotionInput,
  type StateDemotionOptions,
  type StatePromotionInput,
  type StatePromotionOptions,
} from '@appliance.sh/bootstrap';

// The Tauri side spawns this sidecar for any operation that needs the
// bootstrap package's local-machine capabilities (Pulumi automation,
// docker shell-out, AWS SDK with the operator's profile). Each
// invocation reads one JSON object from stdin and emits NDJSON on
// stdout: progress events, then a final `{type: "result", ...}` or
// `{type: "error", ...}` line. The Rust side forwards every
// non-result/non-error line to the frontend via a Tauri Channel.
//
// The `kind` discriminator lets one sidecar binary serve multiple
// operations (full bootstrap vs post-hoc state promotion). New
// operations land here as additional cases.
type SidecarInput =
  | {
      kind: 'bootstrap';
      bootstrapInput: BootstrapInput;
      options?: BootstrapOptions;
    }
  | {
      kind: 'promote-state';
      input: StatePromotionInput;
      options?: StatePromotionOptions;
    }
  | {
      kind: 'demote-state';
      input: StateDemotionInput;
      options?: StateDemotionOptions;
    }
  | {
      kind: 'update-api-server';
      input: ApiServerUpdateInput;
      options?: ApiServerUpdateOptions;
    }
  | {
      kind: 'update-baseline';
      input: BaselineUpdateInput;
      options?: BaselineUpdateOptions;
    }
  | {
      kind: 'latest-version';
      input?: LatestGhcrTagInput;
    }
  | {
      kind: 'teardown';
      // Teardown operates on the installer state in the cache dir, not
      // on a specific cluster record — the only knob is the AWS profile
      // to authenticate the destroy with. `cacheDir` defaults to
      // ~/.appliance (the desktop never overrides it).
      input?: { awsProfile?: string; cacheDir?: string };
    };

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

  const onEvent = (event: BootstrapEvent): void => emit(event);

  try {
    switch (parsed.kind) {
      case 'bootstrap': {
        const result = await runBootstrap(parsed.bootstrapInput, {
          ...(parsed.options ?? {}),
          onEvent,
        });
        emit({ type: 'result', result });
        break;
      }
      case 'promote-state': {
        await runStatePromotion(parsed.input, {
          ...(parsed.options ?? {}),
          onEvent,
        });
        // promote-state has no structured result; the frontend just
        // cares about success vs error. Emit an empty object so the
        // Rust side has a result line to settle on.
        emit({ type: 'result', result: {} });
        break;
      }
      case 'demote-state': {
        await runStateDemotion(parsed.input, {
          ...(parsed.options ?? {}),
          onEvent,
        });
        emit({ type: 'result', result: {} });
        break;
      }
      case 'update-api-server': {
        await runApiServerUpdate(parsed.input, {
          ...(parsed.options ?? {}),
          onEvent,
        });
        emit({ type: 'result', result: {} });
        break;
      }
      case 'update-baseline': {
        await runBaselineUpdate(parsed.input, {
          ...(parsed.options ?? {}),
          onEvent,
        });
        emit({ type: 'result', result: {} });
        break;
      }
      case 'latest-version': {
        const version = await latestGhcrTag(parsed.input ?? {});
        emit({ type: 'result', result: { version } });
        break;
      }
      case 'teardown': {
        // Mirror the CLI's default: the desktop's installer state lives
        // in ~/.appliance unless explicitly overridden.
        await runTeardown({
          cacheDir: parsed.input?.cacheDir ?? path.join(os.homedir(), '.appliance'),
          awsProfile: parsed.input?.awsProfile,
          emit: onEvent,
        });
        emit({ type: 'result', result: {} });
        break;
      }
      default: {
        const _exhaustive: never = parsed;
        throw new Error(`unknown sidecar input kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
    process.exit(0);
  } catch (e) {
    emit({ type: 'error', error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }
}

main();
