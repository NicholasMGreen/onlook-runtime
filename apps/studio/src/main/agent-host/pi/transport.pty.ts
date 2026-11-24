import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiTransport } from './transport.js';

describe('PiTransport RPC lifecycle & config isolation', () => {
  it('passes isolated PI_CODING_AGENT_DIR and --no-extensions/--no-skills, handshakes, and tears down cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onlook-pi-pty-'));
    const isolatedAgentDir = join(dir, 'onlook-pi-agent');
    const sessionDir = join(isolatedAgentDir, 'sessions', 'proj');
    const guardPath = join(isolatedAgentDir, 'extensions', 'onlook-guard.mjs');
    const fakePi = join(dir, 'fake-pi.mjs');

    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'get_state') {
    process.stdout.write(JSON.stringify({
      type: 'response',
      id: msg.id,
      command: 'get_state',
      success: true,
      data: {
        sessionId: 'pi-sess-1',
        agentDir: process.env.PI_CODING_AGENT_DIR,
        argv: process.argv.slice(2),
      },
    }) + '\\n');
  }
});
rl.on('close', () => process.exit(0));
`,
    );
    chmodSync(fakePi, 0o755);

    const transport = new PiTransport({
      bin: fakePi,
      cwd: dir,
      env: { ...process.env, PI_CODING_AGENT_DIR: isolatedAgentDir, PI_NO_TITLE: '1' },
      sessionDir,
      guardExtensionPath: guardPath,
    });

    try {
      await transport.ready;
      const res = await transport.sendCommand('get_state');
      assert.equal(res.success, true);
      assert.equal(res.data?.['agentDir'], isolatedAgentDir);
      const argv = res.data?.['argv'] as string[];
      assert.ok(argv.includes('--mode'));
      assert.ok(argv.includes('rpc'));
      assert.ok(argv.includes('--no-extensions'));
      assert.ok(argv.includes('--no-skills'));
      assert.ok(argv.includes('--no-prompt-templates'));
      assert.ok(argv.includes('--no-themes'));
      assert.ok(argv.includes('--no-approve'));
      assert.ok(argv.includes(guardPath));
      assert.ok(argv.includes(sessionDir));
    } finally {
      await transport.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('boots against a Pi that never sends a ready record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onlook-pi-silent-'));
    const fakePi = join(dir, 'fake-pi.mjs');
    // Real Pi has no `ready` record: it answers commands when stdin is read and says nothing on its own.
    writeFileSync(
      fakePi,
      `#!/usr/bin/env node
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: 'response', id: msg.id, command: msg.type, success: true, data: { sessionId: 'pi-silent-1' } }) + '\\n');
});
rl.on('close', () => process.exit(0));
`,
    );
    chmodSync(fakePi, 0o755);

    const transport = new PiTransport({
      bin: fakePi,
      cwd: dir,
      env: { ...process.env },
      sessionDir: join(dir, 'sessions'),
      guardExtensionPath: join(dir, 'onlook-guard.mjs'),
    });

    try {
      await transport.ready;
      const res = await transport.sendCommand('get_state');
      assert.equal(res.data?.['sessionId'], 'pi-silent-1');
    } finally {
      await transport.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
