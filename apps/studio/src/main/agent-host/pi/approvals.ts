import type { PermissionOption } from '@studio/events';
import { classifyDestructiveGit } from '../destructive-git.js';
import type { EventLog } from '../event-log.js';

export interface PiUiRequest {
  readonly id: string;
  readonly method: string;
  readonly title?: string;
  readonly message?: string;
}

interface PendingApproval {
  readonly requestId: string;
  readonly toolCallId: string;
}

const CONFIRM_OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', label: 'Allow', kind: 'allow_once' },
  { optionId: 'reject_once', label: 'Deny', kind: 'reject_once' },
];

export class PiApprovalBridge {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly sendResponse: (frame: Record<string, unknown>) => void;
  private readonly onChanged: () => void;

  constructor(sendResponse: (frame: Record<string, unknown>) => void, onChanged: () => void) {
    this.sendResponse = sendResponse;
    this.onChanged = onChanged;
  }

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  request(req: PiUiRequest, log: EventLog, activeToolCallId?: string): void {
    if (req.method !== 'confirm') {
      this.sendResponse({ type: 'extension_ui_response', id: req.id, cancelled: true });
      return;
    }

    const toolCallId = activeToolCallId ?? `pi-ui-${req.id}`;
    const message = req.message ?? '';
    const destructiveClass = classifyDestructiveGit(message);

    this.pending.set(req.id, { requestId: req.id, toolCallId });
    log.push({
      type: 'permission.requested',
      requestId: req.id,
      toolCallId,
      toolName: 'Bash',
      title: req.title ?? 'Approve shell command',
      description: message,
      options: CONFIRM_OPTIONS,
      ...(destructiveClass === undefined ? {} : { destructiveClass }),
    });
    this.onChanged();
  }

  respond(requestId: string, optionId: string, log: EventLog): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false;
    this.pending.delete(requestId);

    const confirmed = optionId === 'allow_once' || optionId === 'allow_always';
    this.sendResponse({ type: 'extension_ui_response', id: requestId, confirmed });
    log.push({
      type: 'permission.resolved',
      requestId,
      toolCallId: entry.toolCallId,
      outcome: confirmed ? 'allow_once' : 'deny',
      optionId,
    });
    this.onChanged();
    return true;
  }

  cancelAll(log: EventLog): void {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      this.sendResponse({ type: 'extension_ui_response', id: entry.requestId, confirmed: false });
      log.push({
        type: 'permission.resolved',
        requestId: entry.requestId,
        toolCallId: entry.toolCallId,
        outcome: 'canceled',
      });
    }
    this.onChanged();
  }
}
