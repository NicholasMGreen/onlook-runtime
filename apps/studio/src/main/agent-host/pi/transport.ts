import type { ChildProcess } from 'node:child_process';
import { startChild } from '../../env/child.js';
import { DISPOSE_SESSION_LIMIT_MS } from '../close-limits.js';

export interface PiRpcResponse {
  readonly id?: string;
  readonly command?: string;
  readonly success?: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: string;
}

export interface PiTransportHandlers {
  readonly onReady?: () => void;
  readonly onEvent?: (frame: Record<string, unknown>) => void;
  readonly onUiRequest?: (frame: Record<string, unknown>) => void;
  readonly onMalformed?: (raw: string, error: Error) => void;
  readonly onStderr?: (chunk: string) => void;
  readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface PiTransportOptions {
  readonly bin: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly sessionDir: string;
  readonly guardExtensionPath: string;
  readonly resumeSession?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly appendSystemPrompt?: string;
}

interface PendingCommand {
  readonly resolve: (res: PiRpcResponse) => void;
  readonly reject: (err: Error) => void;
}

export class PiTransport {
  private readonly child: ChildProcess;
  private readonly handlers: PiTransportHandlers;
  private readonly pending = new Map<string, PendingCommand>();
  private buffer = '';
  private nextId = 1;
  private closed = false;
  private exited = false;
  private readyResolved = false;
  private resolveReady?: () => void;
  private rejectReady?: (err: Error) => void;
  readonly ready: Promise<void>;

  constructor(options: PiTransportOptions, handlers: PiTransportHandlers = {}) {
    this.handlers = handlers;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    const args = [
      '--mode', 'rpc',
      '--no-extensions',
      '--extension', options.guardExtensionPath,
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-approve',
      '--session-dir', options.sessionDir,
      ...(options.resumeSession ? ['--session', options.resumeSession] : []),
      ...(options.provider ? ['--provider', options.provider] : []),
      ...(options.model ? ['--model', options.model] : []),
      ...(options.appendSystemPrompt ? ['--append-system-prompt', options.appendSystemPrompt] : []),
    ];

    this.child = startChild(options.bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Real Pi has no `ready` record: it answers commands as soon as stdin is read, and waiting for a frame it never sends left every turn waiting on a boot that never finished.
    this.child.once('spawn', () => {
      this.markReady();
    });

    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => {
      this.onStdout(chunk);
    });

    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.handlers.onStderr?.(chunk);
    });

    this.child.on('error', (err) => {
      this.failAll(err);
    });

    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this.failAll(new Error(`pi exited (${String(code ?? signal ?? 'unknown')})`));
      this.handlers.onExit?.(code, signal);
    });
  }

  sendCommand(type: string, payload: Record<string, unknown> = {}): Promise<PiRpcResponse> {
    if (this.closed || this.exited) {
      return Promise.reject(new Error('pi transport is closed'));
    }
    const id = `req-${String(this.nextId++)}`;
    return new Promise<PiRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeLine({ id, type, ...payload });
    });
  }

  sendRaw(frame: Record<string, unknown>): void {
    if (this.closed || this.exited) return;
    this.writeLine(frame);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('pi transport closed'));
    if (this.exited) return;

    try {
      this.child.stdin?.end();
    } catch {
      // Stdin may already be closed.
    }

    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(killTimer);
        resolve();
      };
      const killTimer = setTimeout(() => {
        try {
          this.child.kill('SIGKILL');
        } catch {
          // Process may have already exited.
        }
        resolve();
      }, Math.min(DISPOSE_SESSION_LIMIT_MS, 5_000));
      killTimer.unref?.();

      this.child.once('exit', done);
      try {
        this.child.kill('SIGTERM');
      } catch {
        done();
      }
    });
  }

  private writeLine(frame: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim() === '') continue;
      this.dispatchLine(line);
    }
  }

  private dispatchLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.handlers.onMalformed?.(line, error as Error);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    const frame = parsed as Record<string, unknown>;
    const type = typeof frame['type'] === 'string' ? frame['type'] : '';

    if (type === 'ready') {
      this.markReady();
      return;
    }

    if (type === 'response') {
      const id = typeof frame['id'] === 'string' ? frame['id'] : undefined;
      if (id !== undefined) {
        const entry = this.pending.get(id);
        if (entry !== undefined) {
          this.pending.delete(id);
          entry.resolve(frame as unknown as PiRpcResponse);
          return;
        }
      }
      return;
    }

    if (type === 'extension_ui_request') {
      this.handlers.onUiRequest?.(frame);
      return;
    }

    this.handlers.onEvent?.(frame);
  }

  private markReady(): void {
    if (this.readyResolved) return;
    this.readyResolved = true;
    this.resolveReady?.();
    this.handlers.onReady?.();
  }

  private failAll(err: Error): void {
    if (!this.readyResolved) {
      this.readyResolved = true;
      this.rejectReady?.(err);
    }
    for (const entry of this.pending.values()) {
      entry.reject(err);
    }
    this.pending.clear();
  }
}
