import type { AgentBackend } from '../backend.js';
import { PiSession, type PiSessionOptions } from './session.js';

export function createPiSession(options: PiSessionOptions): AgentBackend {
  return new PiSession(options);
}
