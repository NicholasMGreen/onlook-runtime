import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeAtomicFile } from '../fs-atomic.js';
import { canonicalPath } from '../lib/canonical-path.js';
import { stateRoot } from '../state/root.js';

function piRoot(root: string = stateRoot()): string {
  return join(root, 'pi');
}

/** Isolated `PI_CODING_AGENT_DIR` so Onlook never reads or mutates `~/.pi/agent/`. */
export function piAgentDir(root: string = stateRoot()): string {
  return join(piRoot(root), 'agent');
}

function piSessionsRoot(root: string = stateRoot()): string {
  return join(piAgentDir(root), 'sessions');
}

export function piSessionDirFor(cwd: string, root: string = stateRoot()): string {
  const hash = createHash('sha256').update(canonicalPath(cwd)).digest('hex').slice(0, 16);
  return join(piSessionsRoot(root), hash);
}

export function piSettingsPath(root: string = stateRoot()): string {
  return join(piAgentDir(root), 'settings.json');
}

export function piGuardExtensionPath(root: string = stateRoot()): string {
  return join(piAgentDir(root), 'extensions', 'onlook-guard.mjs');
}

const DEFAULT_SETTINGS = JSON.stringify({ quietStartup: true }, null, 2) + '\n';

/** The user's own Pi: read for its login and model default, never written to. */
function userPiAgentDir(): string {
  return join(homedir(), '.pi', 'agent');
}

function record(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `{}` is what Pi leaves behind for a login that never happened: read as an answer, it turns every turn into a 401. */
function hasCredentials(path: string): boolean {
  const auth = record(path);
  return auth !== undefined && Object.keys(auth).length > 0;
}

/** Keys that make Pi answer with the login it was handed; a missing one leaves it on a provider the user has no key for. */
const INHERITED_SETTINGS = ['defaultProvider', 'defaultModel'] as const;

/** A copy, not a symlink: the isolated dir must be able to refresh a token without writing through to `~/.pi/agent`. Best effort: a login the app cannot read must not turn a working binary into a probe failure. */
function seedCredentials(agentDir: string, source: string): void {
  try {
    if (canonicalPath(source) === canonicalPath(agentDir)) return;

    const auth = join(agentDir, 'auth.json');
    const userAuth = join(source, 'auth.json');
    if (!hasCredentials(auth) && hasCredentials(userAuth)) {
      copyFileSync(userAuth, auth);
      chmodSync(auth, 0o600);
    }

    const settings = join(agentDir, 'settings.json');
    const inherited = record(join(source, 'settings.json'));
    if (inherited === undefined) return;
    const current = record(settings) ?? {};
    let changed = false;
    for (const key of INHERITED_SETTINGS) {
      if (current[key] !== undefined) continue;
      const value = inherited[key];
      if (typeof value !== 'string' || value.trim() === '') continue;
      current[key] = value;
      changed = true;
    }
    if (changed) writeAtomicFile(settings, JSON.stringify(current, null, 2) + '\n');
  } catch {
    // The isolated dir keeps whatever it already had.
  }
}

export function ensurePiAgentDir(root: string = stateRoot(), source: string = userPiAgentDir()): string {
  const agentDir = piAgentDir(root);
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  mkdirSync(join(agentDir, 'skills'), { recursive: true });
  mkdirSync(join(agentDir, 'sessions'), { recursive: true });

  const settings = piSettingsPath(root);
  if (!existsSync(settings)) {
    writeAtomicFile(settings, DEFAULT_SETTINGS);
  }
  seedCredentials(agentDir, source);
  return agentDir;
}
