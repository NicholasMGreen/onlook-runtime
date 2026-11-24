import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
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

export function ensurePiAgentDir(root: string = stateRoot()): string {
  const agentDir = piAgentDir(root);
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  mkdirSync(join(agentDir, 'skills'), { recursive: true });
  mkdirSync(join(agentDir, 'sessions'), { recursive: true });

  const settings = piSettingsPath(root);
  if (!existsSync(settings)) {
    writeAtomicFile(settings, DEFAULT_SETTINGS);
  }
  return agentDir;
}
