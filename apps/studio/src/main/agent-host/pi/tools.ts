import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { studioToolDefinitions, type StudioToolSinks } from '../studio-tools.js';

export interface PiToolSpec {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

interface StudioDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  annotations?: { title?: string };
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
}

function toJsonSchema(shape: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  const converted = z.toJSONSchema(z.object(shape), { io: 'input' }) as Record<string, unknown>;
  delete converted['$schema'];
  return { ...converted, type: 'object', additionalProperties: false };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

export class PiStudioToolServer {
  private readonly server: Server;
  private readonly token = randomBytes(32).toString('hex');
  private readonly specs: PiToolSpec[];
  private readonly byName: Map<string, StudioDefinition>;
  private port: number | undefined;

  constructor(sinks: StudioToolSinks) {
    const defs = studioToolDefinitions(sinks) as unknown as StudioDefinition[];
    this.specs = defs.map((def) => ({
      name: def.name,
      title: def.annotations?.title ?? def.name,
      description: def.description,
      inputSchema: toJsonSchema(def.inputSchema),
    }));
    this.byName = new Map(defs.map((def) => [def.name, def]));
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  get authToken(): string {
    return this.token;
  }

  get url(): string | undefined {
    return this.port === undefined ? undefined : `http://127.0.0.1:${String(this.port)}`;
  }

  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        const addr = this.server.address();
        if (addr === null || typeof addr === 'string') {
          reject(new Error('Pi Studio tool server failed to bind a TCP port'));
          return;
        }
        this.port = addr.port;
        resolve(`http://127.0.0.1:${String(addr.port)}`);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    if (req.method === 'GET' && req.url === '/tools') {
      sendJson(res, 200, this.specs);
      return;
    }
    if (req.method === 'POST' && req.url === '/call') {
      try {
        const parsed = JSON.parse(await readBody(req)) as { name?: unknown; args?: unknown };
        const name = typeof parsed.name === 'string' ? parsed.name : '';
        const def = this.byName.get(name);
        if (def === undefined) {
          sendJson(res, 404, { ok: false, content: [{ type: 'text', text: `Onlook has no tool called '${name}'.` }] });
          return;
        }
        const args = typeof parsed.args === 'object' && parsed.args !== null ? (parsed.args as Record<string, unknown>) : {};
        const result = (await def.handler(args, {})) as { isError?: boolean; content?: unknown } | undefined;
        sendJson(res, 200, {
          ok: result?.isError !== true,
          content: Array.isArray(result?.content)
            ? result.content
            : [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
        });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          content: [{ type: 'text', text: (error as Error).message }],
        });
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not-found' });
  }
}
