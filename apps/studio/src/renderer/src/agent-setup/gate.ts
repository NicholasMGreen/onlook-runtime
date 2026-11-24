import { HARNESS_IDS, type HarnessId } from '@studio/events';
import { isConnected, type SetupFacts } from '../agents/mapping.js';

/** A credential the boot pre-check found enables nothing until a tap (ONL-2186). */
export function canContinue(facts: Pick<SetupFacts, 'claude' | 'codex' | 'pi' | 'touched'>): boolean {
  return HARNESS_IDS.some((harness) => facts.touched[harness] && isConnected(facts, harness));
}

export function skipsDetectedSetup(facts: Pick<SetupFacts, 'claude' | 'codex' | 'pi' | 'touched'>, harness: HarnessId): boolean {
  return !facts.touched[harness] && isConnected(facts, harness);
}

export function harnessToRecord(store: { lastConnected: HarnessId | null }): HarnessId {
  return store.lastConnected ?? 'claude';
}
