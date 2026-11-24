import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePiAgentDir, piAgentDir, piGuardExtensionPath, piSessionDirFor, piSettingsPath } from './paths.js';

const dirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'onlook-pi-paths-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('isolated Pi paths', () => {
  it('bootstraps an isolated PI_CODING_AGENT_DIR under stateRoot without touching ~/.pi', () => {
    const root = tempRoot();
    const agentDir = ensurePiAgentDir(root);
    expect(agentDir).toBe(piAgentDir(root));
    expect(existsSync(join(agentDir, 'extensions'))).toBe(true);
    expect(existsSync(join(agentDir, 'skills'))).toBe(true);
    expect(existsSync(join(agentDir, 'sessions'))).toBe(true);
    expect(existsSync(piSettingsPath(root))).toBe(true);
    expect(JSON.parse(readFileSync(piSettingsPath(root), 'utf8'))).toEqual({ quietStartup: true });
    expect(piGuardExtensionPath(root)).toBe(join(agentDir, 'extensions', 'onlook-guard.mjs'));
  });

  it('scopes session dirs deterministically per project cwd', () => {
    const root = tempRoot();
    const a = piSessionDirFor('/tmp/project-a', root);
    const b = piSessionDirFor('/tmp/project-b', root);
    expect(a).not.toBe(b);
    expect(a).toBe(piSessionDirFor('/tmp/project-a', root));
  });
});
