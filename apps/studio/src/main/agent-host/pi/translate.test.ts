import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StudioEvent } from '@studio/events';
import { EventLog } from '../event-log.js';
import { PI_PRESENTATION } from './presentation.js';
import { classifyPiError, createPiTurnState, handlePiEvent } from './translate.js';

describe('Pi event translator', () => {
  it('replays a recorded Pi JSONL turn into canonical StudioEvents and waits for agent_settled', () => {
    const emitted: StudioEvent[] = [];
    const log = new EventLog({
      sessionId: 'pi-test-1',
      cwd: '/tmp/project',
      emit: (event) => emitted.push(event),
      presentation: PI_PRESENTATION,
    });
    const turn = createPiTurnState();
    let settled = 0;

    const fixture = readFileSync(join(import.meta.dir, 'fixtures', 'sample-turn.jsonl'), 'utf8');
    for (const line of fixture.trim().split('\n')) {
      handlePiEvent(JSON.parse(line) as Record<string, unknown>, log, turn, {
        onTurnSettled: () => {
          settled += 1;
        },
      });
    }

    expect(settled).toBe(1);
    const types = emitted.map((e) => e.type);
    expect(types).toContain('turn.started');
    expect(types).toContain('thinking.start');
    expect(types).toContain('thinking.delta');
    expect(types).toContain('thinking.end');
    expect(types).toContain('tool.start');
    expect(types).toContain('tool.update');
    expect(types).toContain('tool.end');
    expect(types).toContain('text.start');
    expect(types).toContain('text.delta');
    expect(types).toContain('text.end');
    expect(types.at(-1)).toBe('turn.ended');

    const textEnd = emitted.find((e) => e.type === 'text.end');
    expect(textEnd?.type === 'text.end' && textEnd.text).toBe('Updated the button.');

    const turnEnded = emitted.find((e) => e.type === 'turn.ended');
    expect(turnEnded?.type === 'turn.ended' && turnEnded.tokens?.total).toBe(165);
  });

  it('classifies provider auth, billing, rate limit, and missing binary errors', () => {
    expect(classifyPiError('402 Payment Required', 402)).toBe('billing_error');
    expect(classifyPiError('Invalid API key', 401)).toBe('credential_rejected');
    expect(classifyPiError('Too many requests', 429)).toBe('rate_limited');
    expect(classifyPiError('spawn pi ENOENT')).toBe('cli_missing');
  });
});
