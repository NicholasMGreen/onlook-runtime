import { describe, expect, it } from 'bun:test';
import { inertToolSinks } from '../appserver/tools.js';
import { PiStudioToolServer } from './tools.js';

describe('PiStudioToolServer', () => {
  it('requires bearer auth, lists Studio tools, and dispatches tool calls', async () => {
    const reported: number[] = [];
    const server = new PiStudioToolServer({
      ...inertToolSinks(),
      onServerRunning: (port) => {
        if (typeof port === 'number') reported.push(port);
        return {};
      },
    });

    const url = await server.start();
    try {
      const unauth = await fetch(`${url}/tools`);
      expect(unauth.status).toBe(401);

      const toolsRes = await fetch(`${url}/tools`, {
        headers: { authorization: `Bearer ${server.authToken}` },
      });
      expect(toolsRes.status).toBe(200);
      const specs = (await toolsRes.json()) as Array<{ name: string }>;
      expect(specs.some((spec) => spec.name === 'server_running')).toBe(true);

      const callRes = await fetch(`${url}/call`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${server.authToken}`,
        },
        body: JSON.stringify({ name: 'server_running', args: { port: 3000 } }),
      });
      expect(callRes.status).toBe(200);
      expect(reported).toEqual([3000]);
    } finally {
      await server.close();
    }
  });
});
