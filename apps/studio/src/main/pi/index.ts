import {
  IDLE_PI_SETUP_STATE,
  IPC_EMIT,
  IPC_INVOKE,
  type AgentConnection,
  type PiSetupState,
} from '@studio/events';
import { handle } from '../ipc/bridge.js';
import { log } from '../log/index.js';
import { piBinarySetting } from '../settings/state.js';
import { broadcastToRenderers } from '../tabs/broadcast.js';
import { probePiBinary } from './resolve.js';

const logger = log('pi');

let current: PiSetupState = IDLE_PI_SETUP_STATE;
let inFlight: Promise<PiSetupState> | undefined;

function setState(next: PiSetupState): void {
  current = next;
  broadcastToRenderers(IPC_EMIT.piState, next);
}

function checkPiSetup(): Promise<PiSetupState> {
  if (inFlight !== undefined) return inFlight;
  setState({ status: 'checking' });
  inFlight = probePiBinary({ override: piBinarySetting() })
    .then((result) => {
      setState(result);
      return result;
    })
    .catch((error: unknown) => {
      logger.warn('pi binary probe failed', { error });
      const broken: PiSetupState = { status: 'broken', detail: 'probe-failed' };
      setState(broken);
      return broken;
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

export async function probePiConnection(): Promise<AgentConnection> {
  const result = await checkPiSetup();
  if (result.status === 'ready') return { status: 'ok', harness: 'pi' };
  if (result.status === 'missing') return { status: 'cli_missing', harness: 'pi' };
  return { status: 'error', harness: 'pi', ...(result.status === 'broken' && result.detail ? { detail: result.detail } : {}) };
}

export function registerPiHost(): void {
  handle(IPC_INVOKE.piStatus, (): PiSetupState => current);
  handle(IPC_INVOKE.piCheck, (): Promise<PiSetupState> => checkPiSetup());
}

export function startPiBootPreCheck(): void {
  void checkPiSetup();
}
