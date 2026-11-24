/**
 * Pi's binary-discovery verdict. There is nothing to install: Pi is either on the user's PATH
 * (or at the override path) and new enough, or the setup screen says what to do.
 */
export type PiSetupStatus = PiSetupState['status'];

export type PiSetupState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ready'; version: string; path: string }
  | { status: 'missing'; detail?: string }
  | { status: 'outdated'; version: string; detail?: string }
  | { status: 'broken'; detail?: string };

export const IDLE_PI_SETUP_STATE: PiSetupState = { status: 'idle' };
