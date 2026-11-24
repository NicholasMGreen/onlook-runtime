import { describe, expect, it } from 'bun:test';
import type { StudioEvent } from '@studio/events';
import { EventLog } from '../event-log.js';
import { PiApprovalBridge } from './approvals.js';
import { PI_PRESENTATION } from './presentation.js';

describe('PiApprovalBridge', () => {
  it('classifies destructive git commands and resolves allow/deny round-trips', () => {
    const emitted: StudioEvent[] = [];
    const sent: Record<string, unknown>[] = [];
    const log = new EventLog({
      sessionId: 'pi-approval-1',
      cwd: '/tmp/project',
      emit: (e) => emitted.push(e),
      presentation: PI_PRESENTATION,
    });
    const bridge = new PiApprovalBridge((frame) => sent.push(frame), () => {});

    bridge.request(
      { id: 'ui-1', method: 'confirm', title: 'Approve shell command?', message: 'git push --force origin main' },
      log,
      'tc-bash-1',
    );

    expect(bridge.hasPending).toBe(true);
    const req = emitted.find((e) => e.type === 'permission.requested');
    expect(req?.type === 'permission.requested' && req.destructiveClass).toBe('force_push');

    expect(bridge.respond('ui-1', 'allow_once', log)).toBe(true);
    expect(bridge.hasPending).toBe(false);
    expect(sent).toEqual([{ type: 'extension_ui_response', id: 'ui-1', confirmed: true }]);
    expect(emitted.at(-1)?.type).toBe('permission.resolved');
  });

  it('fails closed on cancelAll', () => {
    const emitted: StudioEvent[] = [];
    const sent: Record<string, unknown>[] = [];
    const log = new EventLog({
      sessionId: 'pi-approval-2',
      cwd: '/tmp/project',
      emit: (e) => emitted.push(e),
      presentation: PI_PRESENTATION,
    });
    const bridge = new PiApprovalBridge((frame) => sent.push(frame), () => {});

    bridge.request({ id: 'ui-2', method: 'confirm', message: 'gh pr create --title test' }, log);
    bridge.cancelAll(log);

    expect(bridge.hasPending).toBe(false);
    expect(sent).toEqual([{ type: 'extension_ui_response', id: 'ui-2', confirmed: false }]);
    const resolved = emitted.find((e) => e.type === 'permission.resolved');
    expect(resolved?.type === 'permission.resolved' && resolved.outcome).toBe('canceled');
  });
});
