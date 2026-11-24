import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { PiSetupState } from '@studio/events';
import { runChildOutput } from '../env/child.js';
import { hostExecutable } from '../env/executable.js';
import { isWindows } from '../env/platform.js';
import { mergeEnv, userEnv, type Env } from '../env/shell-env.js';
import { ensurePiAgentDir, piAgentDir } from './paths.js';

const PROBE_TIMEOUT_MS = 8_000;

export function parsePiVersion(output: string): string | undefined {
  const match = output.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match?.[1];
}

function isRunnableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (!isWindows()) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolvePiBinary(options: {
  override?: string;
  cwd?: string;
  env: Env;
}): string | undefined {
  const override = options.override?.trim();
  if (override) {
    if (isAbsolute(override)) return isRunnableFile(override) ? override : undefined;
    return hostExecutable(override, options.cwd ?? process.cwd(), options.env);
  }
  return hostExecutable('pi', options.cwd ?? process.cwd(), options.env);
}

export interface ProbePiOptions {
  override?: string;
  env?: Env;
  stateRoot?: string;
  run?: (bin: string, args: readonly string[], env: Env) => Promise<{ stdout: string; stderr: string }>;
}

export async function probePiBinary(options: ProbePiOptions = {}): Promise<PiSetupState> {
  const baseEnv = options.env ?? (await userEnv());
  const bin = resolvePiBinary({ override: options.override, env: baseEnv });
  if (bin === undefined) {
    return { status: 'missing' };
  }

  const agentDir = options.stateRoot === undefined ? ensurePiAgentDir() : ensurePiAgentDir(options.stateRoot);
  const env = mergeEnv(baseEnv, {
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: '1',
    PI_NO_TITLE: '1',
  });

  try {
    const exec = options.run ?? ((file, args, childEnv) =>
      runChildOutput(file, args, { env: childEnv, timeout: PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024 }));
    const { stdout, stderr } = await exec(bin, ['--version'], env);
    const version = parsePiVersion(`${stdout}\n${stderr}`);
    if (version === undefined) {
      return { status: 'broken', detail: 'no-version' };
    }
    return { status: 'ready', version, path: bin };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return { status: 'missing' };
    return { status: 'broken', detail: code ?? 'probe-failed' };
  }
}

export function isolatedPiEnv(baseEnv: Env, cwd: string, extra?: Env): Env {
  return mergeEnv(baseEnv, {
    PI_CODING_AGENT_DIR: piAgentDir(),
    PI_NO_TITLE: '1',
    ONLOOK_WORKTREE_ROOT: cwd,
  }, extra);
}
