import { randomUUID } from 'node:crypto';
import type {
  AgentConnection,
  EffortLevel,
  ModelChoice,
  PermissionMode,
  PromptAttachment,
  PromptOrigin,
  QuestionAnswers,
  StudioEvent,
  WelcomeProject,
} from '@studio/events';
import { briefing, type StarterBriefing } from '../../../instructions/context.js';
import { userEnvSync } from '../../env/shell-env.js';
import { log as createLogger } from '../../log/index.js';
import { piSessionDirFor } from '../../pi/paths.js';
import { isolatedPiEnv, resolvePiBinary } from '../../pi/resolve.js';
import { piBinarySetting } from '../../settings/state.js';
import type { AgentBackend, BackendState, ModelPick } from '../backend.js';
import { EventLog } from '../event-log.js';
import { rememberPiSession, storedPiSession } from '../sessions.js';
import type { StudioToolSinks } from '../studio-tools.js';
import { PiApprovalBridge } from './approvals.js';
import { materializeGuardExtension } from './guard-source.js';
import { PI_PRESENTATION } from './presentation.js';
import { PiStudioToolServer } from './tools.js';
import { classifyPiError, createPiTurnState, handlePiEvent, type PiTurnState } from './translate.js';
import { PiTransport } from './transport.js';

const logger = createLogger('agent-host');

export interface PiSessionOptions {
  readonly cwd: string;
  readonly workspace?: WelcomeProject;
  readonly starter?: StarterBriefing;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly restored?: readonly StudioEvent[];
  readonly studioSinks?: StudioToolSinks;
  readonly onEvent: (event: StudioEvent) => void;
  readonly onConnection?: (connection: AgentConnection) => void;
  readonly onState?: (state: BackendState) => void;
}

function parseModels(data: Record<string, unknown> | undefined): ModelChoice[] {
  const raw = data?.['models'];
  if (!Array.isArray(raw)) return [];
  const out: ModelChoice[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec['id'] === 'string' ? rec['id'] : typeof rec['modelId'] === 'string' ? rec['modelId'] : undefined;
    if (!id) continue;
    const provider = typeof rec['provider'] === 'string' ? rec['provider'] : undefined;
    const value = provider && !id.includes('/') ? `${provider}/${id}` : id;
    const displayName = typeof rec['name'] === 'string' ? rec['name'] : typeof rec['displayName'] === 'string' ? rec['displayName'] : value;
    out.push({ value, displayName });
  }
  return out;
}

export class PiSession implements AgentBackend {
  readonly id = randomUUID();
  readonly cwd: string;
  readonly harness = 'pi' as const;

  private readonly eventLog: EventLog;
  private readonly options: PiSessionOptions;
  private readonly approvals: PiApprovalBridge;
  private readonly toolServer?: PiStudioToolServer;
  private transport?: PiTransport;
  private turn: PiTurnState = createPiTurnState();
  private streaming = false;
  private turnLive = false;
  private closed = false;
  private currentModel?: string;
  private availableModels: ModelChoice[] = [];
  private bootPromise?: Promise<void>;

  constructor(options: PiSessionOptions) {
    this.cwd = options.cwd;
    this.options = options;
    this.currentModel = options.model;
    this.eventLog = new EventLog({
      sessionId: this.id,
      cwd: options.cwd,
      emit: options.onEvent,
      presentation: PI_PRESENTATION,
    });
    if (options.restored && options.restored.length > 0) {
      this.eventLog.restore(options.restored);
    }
    this.approvals = new PiApprovalBridge(
      (frame) => this.transport?.sendRaw(frame),
      () => this.publishState(),
    );
    if (options.studioSinks) {
      this.toolServer = new PiStudioToolServer(options.studioSinks);
    }
  }

  get events(): readonly StudioEvent[] {
    return this.eventLog.events;
  }

  get isRestoringTranscript(): boolean {
    return this.eventLog.isRestoringTranscript;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  get needsAttention(): boolean {
    return this.approvals.hasPending;
  }

  get isTurnLive(): boolean {
    return this.turnLive;
  }

  get midTurn(): 'steer' {
    return 'steer';
  }

  get lastSeq(): number {
    return this.eventLog.lastSeq;
  }

  eventsSince(sinceSeq?: number): StudioEvent[] {
    return this.eventLog.since(sinceSeq);
  }

  welcome(workspace: WelcomeProject): void {
    this.eventLog.push({ type: 'session.welcome', workspace });
  }

  open(): void {
    this.eventLog.push({
      type: 'session.started',
      cwd: this.cwd,
      harnessId: 'pi',
      ...(this.currentModel === undefined ? {} : { model: this.currentModel }),
    });
    this.publishState();
    this.bootPromise = this.boot();
  }

  prompt(
    text: string,
    attachments?: PromptAttachment[],
    context?: string,
    origin: PromptOrigin = 'user',
    display?: { origin: PromptOrigin; hidden?: true },
  ): boolean {
    if (this.closed) return false;
    const messageId = randomUUID();
    const isSteer = this.streaming;
    if (!this.turnLive) {
      this.eventLog.beginTurn(origin);
      this.turnLive = true;
    }
    this.streaming = true;
    this.eventLog.push({
      type: 'message.user',
      turnId: this.eventLog.turnId,
      messageId,
      text,
      origin: display?.origin ?? origin,
      ...(display?.hidden ? { hidden: true as const } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(context ? { context } : {}),
      ...(isSteer ? { delivery: 'steering' as const } : {}),
    });
    this.publishState();

    const fullMessage = context ? `${text}\n\n${context}` : text;
    void this.dispatchPrompt(fullMessage, isSteer);
    return true;
  }

  setPermissionMode(_mode: PermissionMode): Promise<boolean> {
    return Promise.resolve(false);
  }

  respond(requestId: string, optionId: string, _answers?: QuestionAnswers): boolean {
    return this.approvals.respond(requestId, optionId, this.eventLog);
  }

  answerQuestion(_text: string, _attachments?: PromptAttachment[], _context?: string): boolean {
    return false;
  }

  dismissQuestion(): Promise<boolean> {
    return Promise.resolve(false);
  }

  async setModel(model: string): Promise<ModelPick> {
    await this.bootPromise;
    if (!this.transport || this.closed) return { accepted: false };
    try {
      const res = await this.transport.sendCommand('set_model', { model });
      if (res.success === false) return { accepted: false };
      this.currentModel = model;
      this.eventLog.push({ type: 'session.settings', model });
      return { accepted: true };
    } catch {
      return { accepted: false };
    }
  }

  async setEffort(effort: EffortLevel | null): Promise<void> {
    await this.bootPromise;
    if (!this.transport || this.closed || effort === null) return;
    await this.transport.sendCommand('set_thinking_level', { level: effort }).catch(() => undefined);
  }

  async interrupt(): Promise<void> {
    this.approvals.cancelAll(this.eventLog);
    this.streaming = false;
    this.publishState();
    if (this.transport && !this.closed) {
      await this.transport.sendCommand('abort').catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.approvals.cancelAll(this.eventLog);
    this.streaming = false;
    this.turnLive = false;
    this.publishState(true);
    await this.transport?.close();
    await this.toolServer?.close();
  }

  private async boot(): Promise<void> {
    const baseEnv = userEnvSync() ?? (process.env as Record<string, string>);
    const bin = resolvePiBinary({ override: piBinarySetting(), cwd: this.cwd, env: baseEnv });
    if (bin === undefined) {
      this.options.onConnection?.({ status: 'cli_missing', harness: 'pi' });
      this.eventLog.push({
        type: 'session.error',
        code: 'cli_missing',
        message: 'Pi CLI not found on PATH.',
      });
      return;
    }

    const guardPath = materializeGuardExtension();
    const sessionDir = piSessionDirFor(this.cwd);
    const resumeSession = storedPiSession(this.cwd);

    let toolEnv: Record<string, string> | undefined;
    if (this.toolServer) {
      try {
        const url = await this.toolServer.start();
        toolEnv = {
          ONLOOK_STUDIO_TOOLS_URL: url,
          ONLOOK_STUDIO_TOOLS_TOKEN: this.toolServer.authToken,
        };
      } catch (error) {
        logger.warn('pi studio tool server failed to start', { error });
      }
    }

    const env = isolatedPiEnv(baseEnv, this.cwd, toolEnv);
    const systemPrompt = briefing(this.options.workspace, {
      harness: 'pi',
      ...(this.options.starter === undefined ? {} : { starter: this.options.starter }),
    });

    this.transport = new PiTransport(
      {
        bin,
        cwd: this.cwd,
        env,
        sessionDir,
        guardExtensionPath: guardPath,
        ...(resumeSession === undefined ? {} : { resumeSession }),
        ...(this.currentModel === undefined ? {} : { model: this.currentModel }),
        ...(systemPrompt === undefined ? {} : { appendSystemPrompt: systemPrompt }),
      },
      {
        onEvent: (frame) => {
          handlePiEvent(frame, this.eventLog, this.turn, {
            onTurnStart: () => {
              this.streaming = true;
              this.turnLive = true;
              this.publishState();
            },
            onTurnSettled: () => {
              this.streaming = false;
              this.turnLive = false;
              this.turn = createPiTurnState();
              this.publishState();
            },
            onExtensionError: (_path, message) => {
              logger.warn('pi extension error', { message });
            },
          });
        },
        onUiRequest: (frame) => {
          const id = typeof frame['id'] === 'string' ? frame['id'] : randomUUID();
          const method = typeof frame['method'] === 'string' ? frame['method'] : 'confirm';
          this.approvals.request(
            {
              id,
              method,
              ...(typeof frame['title'] === 'string' ? { title: frame['title'] } : {}),
              ...(typeof frame['message'] === 'string' ? { message: frame['message'] } : {}),
            },
            this.eventLog,
            this.turn.activeToolCallId,
          );
        },
        onMalformed: () => {
          logger.warn('malformed JSONL from pi stdout');
        },
        onStderr: () => {
          // Stderr is suppressed from protocol logs to avoid leaking sensitive content.
        },
        onExit: (code) => {
          if (this.closed) return;
          this.approvals.cancelAll(this.eventLog);
          this.streaming = false;
          this.turnLive = false;
          this.publishState(true);
          if (code !== 0 && code !== null) {
            this.eventLog.push({
              type: 'session.error',
              code: 'spawn_failed',
              message: `Pi exited with code ${String(code)}.`,
            });
          }
        },
      },
    );

    try {
      await this.transport.ready;
      this.options.onConnection?.({ status: 'ok', harness: 'pi' });

      const [stateRes, modelsRes] = await Promise.all([
        this.transport.sendCommand('get_state').catch(() => undefined),
        this.transport.sendCommand('get_available_models').catch(() => undefined),
      ]);

      const piSessionId = typeof stateRes?.data?.['sessionId'] === 'string' ? stateRes.data['sessionId'] : undefined;
      const activeModel = typeof stateRes?.data?.['model'] === 'string' ? stateRes.data['model'] : this.currentModel;
      if (activeModel !== undefined) this.currentModel = activeModel;
      if (piSessionId !== undefined) rememberPiSession(this.cwd, piSessionId, this.currentModel);

      this.availableModels = parseModels(modelsRes?.data);
      this.eventLog.push({
        type: 'session.settings',
        models: this.availableModels,
        ...(this.currentModel === undefined ? {} : { model: this.currentModel }),
        permissionModes: [],
      });
    } catch (error) {
      const message = (error as Error).message;
      const code = classifyPiError(message);
      this.options.onConnection?.({ status: code === 'cli_missing' ? 'cli_missing' : 'error', harness: 'pi' });
      this.eventLog.push({ type: 'session.error', code, message });
    }
  }

  private async dispatchPrompt(message: string, isSteer: boolean): Promise<void> {
    await this.bootPromise;
    if (!this.transport || this.closed) {
      this.streaming = false;
      this.turnLive = false;
      this.publishState();
      return;
    }
    try {
      const command = isSteer ? 'follow_up' : 'prompt';
      const res = await this.transport.sendCommand(command, { message });
      if (res.success === false) {
        const errMsg = res.error ?? 'Pi rejected the prompt.';
        this.streaming = false;
        this.turnLive = false;
        this.eventLog.push({ type: 'session.error', code: classifyPiError(errMsg), message: errMsg });
        this.publishState();
        return;
      }
      if (res.data?.['disposition'] === 'handled') {
        this.streaming = false;
        this.turnLive = false;
        if (this.eventLog.isTurnLive) {
          this.eventLog.push({ type: 'turn.ended', turnId: this.eventLog.turnId });
        }
        this.publishState();
      }
    } catch (error) {
      const errMsg = (error as Error).message;
      this.streaming = false;
      this.turnLive = false;
      this.eventLog.push({ type: 'session.error', code: classifyPiError(errMsg), message: errMsg });
      this.publishState();
    }
  }

  private publishState(turnEnding?: boolean): void {
    this.options.onState?.({
      isStreaming: this.streaming,
      isTurnLive: this.turnLive,
      midTurn: 'steer',
      needsAttention: this.approvals.hasPending,
      ...(turnEnding ? { turnEnding: true } : {}),
    });
  }
}
