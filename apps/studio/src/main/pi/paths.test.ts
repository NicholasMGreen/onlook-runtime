import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const agentDir = ensurePiAgentDir(root, join(root, 'no-user-pi'));
    expect(agentDir).toBe(piAgentDir(root));
    expect(existsSync(join(agentDir, 'extensions'))).toBe(true);
    expect(existsSync(join(agentDir, 'skills'))).toBe(true);
    expect(existsSync(join(agentDir, 'sessions'))).toBe(true);
    expect(existsSync(piSettingsPath(root))).toBe(true);
    expect(JSON.parse(readFileSync(piSettingsPath(root), 'utf8'))).toEqual({ quietStartup: true });
    expect(piGuardExtensionPath(root)).toBe(join(agentDir, 'extensions', 'onlook-guard.mjs'));
  });

  it('inherits the user login and model default without writing to the source dir', () => {
    const root = tempRoot();
    const user = join(root, 'user-pi', 'agent');
    mkdirSync(user, { recursive: true });
    writeFileSync(join(user, 'auth.json'), JSON.stringify({ openrouter: { type: 'api_key', key: 'k' } }));
    writeFileSync(join(user, 'settings.json'), JSON.stringify({ defaultProvider: 'openrouter', defaultModel: 'x/y', theme: 'dark' }));
    const before = readFileSync(join(user, 'settings.json'), 'utf8');

    const agentDir = ensurePiAgentDir(root, user);

    expect(JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8'))).toEqual({ openrouter: { type: 'api_key', key: 'k' } });
    expect(JSON.parse(readFileSync(piSettingsPath(root), 'utf8'))).toEqual({ quietStartup: true, defaultProvider: 'openrouter', defaultModel: 'x/y' });
    expect(readFileSync(join(user, 'settings.json'), 'utf8')).toBe(before);
  });

  it('replaces an empty login left by a login that never happened', () => {
    const root = tempRoot();
    const user = join(root, 'user-pi', 'agent');
    mkdirSync(user, { recursive: true });
    writeFileSync(join(user, 'auth.json'), JSON.stringify({ openrouter: { type: 'api_key', key: 'k' } }));
    const agentDir = ensurePiAgentDir(root, join(root, 'no-user-pi'));
    writeFileSync(join(agentDir, 'auth.json'), '{}');
    ensurePiAgentDir(root, user);
    expect(JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8'))).toEqual({ openrouter: { type: 'api_key', key: 'k' } });
  });

  it('leaves an existing login and model default alone once seeded', () => {
    const root = tempRoot();
    const user = join(root, 'user-pi', 'agent');
    mkdirSync(user, { recursive: true });
    writeFileSync(join(user, 'auth.json'), JSON.stringify({ openrouter: { type: 'api_key', key: 'user' } }));
    const agentDir = ensurePiAgentDir(root, user);
    writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ anthropic: { type: 'api_key', key: 'mine' } }));
    ensurePiAgentDir(root, user);
    expect(JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8'))).toEqual({ anthropic: { type: 'api_key', key: 'mine' } });
  });

  it('scopes session dirs deterministically per project cwd', () => {
    const root = tempRoot();
    const a = piSessionDirFor('/tmp/project-a', root);
    const b = piSessionDirFor('/tmp/project-b', root);
    expect(a).not.toBe(b);
    expect(a).toBe(piSessionDirFor('/tmp/project-a', root));
  });
});
