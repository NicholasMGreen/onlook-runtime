import { isBillingFailure, type SessionErrorCode, type TurnTokens } from '@studio/events';
import { num, obj, str } from '../coerce.js';
import type { EventLog } from '../event-log.js';

export interface PiTurnState {
  textBlockSlot?: string;
  textAccumulated: string;
  thinkingBlockSlot?: string;
  thinkingAccumulated: string;
  activeToolCallId?: string;
  bashOutput: Map<string, string>;
  tokens?: TurnTokens;
}

export function createPiTurnState(): PiTurnState {
  return {
    textAccumulated: '',
    thinkingAccumulated: '',
    bashOutput: new Map(),
  };
}

export interface PiTranslateHooks {
  readonly onTurnStart?: () => void;
  readonly onTurnSettled?: (tokens?: TurnTokens) => void;
  readonly onExtensionError?: (extensionPath: string | undefined, message: string) => void;
}

export function classifyPiError(message: string, status?: number): SessionErrorCode {
  if (isBillingFailure(undefined, status, message)) return 'billing_error';
  if (status === 401 || status === 403 || /\b(?:401|403|invalid api key|unauthorized|api key.*missing|no api key)\b/i.test(message)) {
    return 'credential_rejected';
  }
  if (status === 429 || /\b(?:429|rate limit|too many requests)\b/i.test(message)) {
    return 'rate_limited';
  }
  if (status !== undefined && status >= 500 && status <= 599) return 'api_error';
  if (/ENOENT/i.test(message)) return 'cli_missing';
  return 'api_error';
}

function closeOpenBlocks(log: EventLog, turn: PiTurnState): void {
  if (turn.textBlockSlot !== undefined) {
    const blockId = log.currentBlock(turn.textBlockSlot);
    if (blockId !== undefined) {
      log.push({ type: 'text.end', blockId, text: turn.textAccumulated });
    }
    log.closeBlock(turn.textBlockSlot);
    turn.textBlockSlot = undefined;
    turn.textAccumulated = '';
  }
  if (turn.thinkingBlockSlot !== undefined) {
    const blockId = log.currentBlock(turn.thinkingBlockSlot);
    if (blockId !== undefined) {
      log.push({ type: 'thinking.end', blockId, text: turn.thinkingAccumulated });
    }
    log.closeBlock(turn.thinkingBlockSlot);
    turn.thinkingBlockSlot = undefined;
    turn.thinkingAccumulated = '';
  }
}

function extractTokens(frame: Record<string, unknown>): TurnTokens | undefined {
  const usage = obj(frame['usage']) ?? obj(obj(frame['message'])?.['usage']);
  if (usage === undefined) return undefined;
  const input = num(usage['input']) ?? num(usage['inputTokens']);
  const output = num(usage['output']) ?? num(usage['outputTokens']);
  const cachedInput = num(usage['cacheRead']) ?? num(usage['cachedInputTokens']);
  const cacheWriteInput = num(usage['cacheWrite']) ?? num(usage['cacheWriteInputTokens']);
  const total = num(usage['totalTokens']) ?? num(usage['total']);
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(cacheWriteInput === undefined ? {} : { cacheWriteInput }),
    ...(total === undefined ? {} : { total, context: total }),
  };
}

function resultText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  const record = obj(raw);
  if (record === undefined) return undefined;
  const content = record['content'];
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => str(obj(item)?.['text']))
      .filter((text): text is string => text !== undefined);
    if (parts.length > 0) return parts.join('\n');
  }
  return str(record['text']) ?? str(record['output']);
}

export function handlePiEvent(
  frame: Record<string, unknown>,
  log: EventLog,
  turn: PiTurnState,
  hooks: PiTranslateHooks = {},
): void {
  const type = str(frame['type']);
  if (type === undefined) return;

  switch (type) {
    case 'agent_start': {
      if (!log.isTurnLive) {
        const turnId = log.beginTurn('user');
        log.push({ type: 'turn.started', turnId });
      }
      hooks.onTurnStart?.();
      return;
    }

    case 'message_update': {
      const evt = obj(frame['assistantMessageEvent']) ?? frame;
      const evtType = str(evt['type']);
      const delta = str(evt['delta']);
      if (evtType === 'text_delta' && delta !== undefined) {
        if (turn.thinkingBlockSlot !== undefined) closeOpenBlocks(log, turn);
        if (turn.textBlockSlot === undefined) {
          turn.textBlockSlot = 'pi-text';
          const blockId = log.openBlock(turn.textBlockSlot, 'text');
          log.push({ type: 'text.start', blockId });
        }
        const blockId = log.currentBlock(turn.textBlockSlot);
        if (blockId !== undefined) {
          turn.textAccumulated += delta;
          log.push({ type: 'text.delta', blockId, delta });
        }
        return;
      }
      if (evtType === 'thinking_delta' && delta !== undefined) {
        if (turn.textBlockSlot !== undefined) closeOpenBlocks(log, turn);
        if (turn.thinkingBlockSlot === undefined) {
          turn.thinkingBlockSlot = 'pi-thinking';
          const blockId = log.openBlock(turn.thinkingBlockSlot, 'thinking');
          log.push({ type: 'thinking.start', blockId });
        }
        const blockId = log.currentBlock(turn.thinkingBlockSlot);
        if (blockId !== undefined) {
          turn.thinkingAccumulated += delta;
          log.push({ type: 'thinking.delta', blockId, delta });
        }
        return;
      }
      if (evtType === 'text_end' || evtType === 'thinking_end') {
        closeOpenBlocks(log, turn);
      }
      return;
    }

    case 'message_end': {
      closeOpenBlocks(log, turn);
      const tokens = extractTokens(frame);
      if (tokens !== undefined) turn.tokens = tokens;
      return;
    }

    case 'tool_execution_start': {
      closeOpenBlocks(log, turn);
      const toolCallId = str(frame['toolCallId']) ?? str(frame['id']);
      const name = str(frame['toolName']) ?? str(frame['name']) ?? 'tool';
      if (toolCallId === undefined) return;
      turn.activeToolCallId = toolCallId;
      log.ensureToolStart(toolCallId, name, frame['args'] ?? frame['input'] ?? {}, 'in_progress', {
        source: 'stream',
      });
      return;
    }

    case 'bash_execution_update': {
      const toolCallId = str(frame['id']) ?? str(frame['toolCallId']) ?? turn.activeToolCallId;
      const delta = str(frame['delta']) ?? str(frame['chunk']);
      if (toolCallId === undefined || delta === undefined) return;
      const next = (turn.bashOutput.get(toolCallId) ?? '') + delta;
      turn.bashOutput.set(toolCallId, next);
      log.push({ type: 'tool.update', toolCallId, status: 'in_progress' });
      return;
    }

    case 'tool_execution_end': {
      const toolCallId = str(frame['toolCallId']) ?? str(frame['id']);
      if (toolCallId === undefined) return;
      if (turn.activeToolCallId === toolCallId) turn.activeToolCallId = undefined;
      const isError = frame['isError'] === true;
      const result = resultText(frame['result']) ?? turn.bashOutput.get(toolCallId);
      turn.bashOutput.delete(toolCallId);
      log.endTool(toolCallId, isError ? 'failed' : 'completed', {
        ...(result === undefined ? {} : { result }),
        ...(isError ? { isError: true, errorMessage: result ?? 'Tool execution failed' } : {}),
      });
      return;
    }

    case 'extension_error': {
      const message = str(frame['error']) ?? str(frame['message']) ?? 'Extension error';
      hooks.onExtensionError?.(str(frame['extensionPath']), message);
      return;
    }

    case 'agent_end': {
      // Non-terminal: Pi may still retry, compact, or drain follow-ups before `agent_settled`.
      closeOpenBlocks(log, turn);
      return;
    }

    case 'agent_settled': {
      closeOpenBlocks(log, turn);
      const tokens = extractTokens(frame) ?? turn.tokens;
      if (log.isTurnLive) {
        log.push({
          type: 'turn.ended',
          turnId: log.turnId,
          ...(tokens === undefined ? {} : { tokens }),
        });
      }
      hooks.onTurnSettled?.(tokens);
      return;
    }

    default:
      return;
  }
}
