import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePiVersion, probePiBinary, resolvePiBinary } from './resolve.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'onlook-pi-resolve-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('Pi binary resolution and preflight', () => {
  it('parses semver strings from --version output', () => {
    expect(parsePiVersion('pi 0.42.1\n')).toBe('0.42.1');
    expect(parsePiVersion('1.2.3-beta.4')).toBe('1.2.3-beta.4');
    expect(parsePiVersion('unknown')).toBeUndefined();
  });

  it('prefers an explicit runnable override path over PATH', () => {
    const dir = tempDir();
    const bin = join(dir, 'pi');
    writeFileSync(bin, '#!/bin/sh\necho 0.9.0\n');
    chmodSync(bin, 0o755);
    expect(resolvePiBinary({ override: bin, env: { PATH: '' } })).toBe(bin);
  });

  it('reports ready with isolated PI_CODING_AGENT_DIR when probe succeeds', async () => {
    const binDir = tempDir();
    const state = tempDir();
    const bin = join(binDir, 'pi');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o755);

    let seenAgentDir: string | undefined;
    const verdict = await probePiBinary({
      override: bin,
      env: { PATH: '' },
      stateRoot: state,
      run: async (_file, _args, env) => {
        seenAgentDir = env['PI_CODING_AGENT_DIR'];
        return { stdout: 'pi 0.55.0\n', stderr: '' };
      },
    });

    expect(verdict).toEqual({ status: 'ready', version: '0.55.0', path: bin });
    expect(seenAgentDir).toBe(join(state, 'pi', 'agent'));
  });

  it('reports missing when no binary is found', async () => {
    const root = tempDir();
    const verdict = await probePiBinary({ env: { PATH: '' }, stateRoot: root });
    expect(verdict).toEqual({ status: 'missing' });
  });
});
