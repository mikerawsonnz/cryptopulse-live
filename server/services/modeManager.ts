export type MomentumStatus = 'AGGRESSIVE' | 'NEUTRAL' | 'DEFENSIVE' | 'HIBERNATE';

export interface ModeState {
  name: string;
  currentScore: number;
  emaScore: number;
  gap: number;
  status: MomentumStatus;
  sizeMultiplier: number;
}

const ALPHA = 0.2;
const HIBERNATE_THRESHOLD = -5;
const OVERHEAT_THRESHOLD = 50;

const modes: Map<string, ModeState> = new Map();

function initializeMode(name: string, seedScore: number = 0): ModeState {
  const state: ModeState = {
    name,
    currentScore: seedScore,
    emaScore: seedScore,
    gap: 0,
    status: 'NEUTRAL',
    sizeMultiplier: 0.75,
  };
  modes.set(name, state);
  return state;
}

export function updateMode(modeName: string, newRawScore: number): ModeState {
  let mode = modes.get(modeName);

  if (!mode) {
    mode = initializeMode(modeName, newRawScore);
  }

  mode.emaScore = (newRawScore * ALPHA) + (mode.emaScore * (1 - ALPHA));
  mode.gap = newRawScore - mode.emaScore;
  mode.currentScore = newRawScore;

  if (mode.gap < HIBERNATE_THRESHOLD) {
    mode.status = 'HIBERNATE';
    mode.sizeMultiplier = 0;
    console.log(`[ModeManager] ${modeName} HIBERNATE - momentum lost. Gap: ${mode.gap.toFixed(1)}`);
  } else if (mode.gap > OVERHEAT_THRESHOLD) {
    mode.status = 'DEFENSIVE';
    mode.sizeMultiplier = 0.5;
    console.log(`[ModeManager] ${modeName} DEFENSIVE - overheated. Gap: ${mode.gap.toFixed(1)}`);
  } else if (mode.gap > 0) {
    mode.status = 'AGGRESSIVE';
    mode.sizeMultiplier = 1.0;
  } else {
    mode.status = 'NEUTRAL';
    mode.sizeMultiplier = 0.75;
  }

  return mode;
}

export function getModeState(name: string): ModeState | undefined {
  return modes.get(name);
}

export function getAllModeStates(): Record<string, ModeState> {
  const result: Record<string, ModeState> = {};
  modes.forEach((value, key) => {
    result[key] = { ...value };
  });
  return result;
}

export function getSizeMultiplier(modeName: string): number {
  const mode = modes.get(modeName);
  return mode?.sizeMultiplier ?? 1.0;
}

export function isHibernating(modeName: string): boolean {
  const mode = modes.get(modeName);
  return mode?.status === 'HIBERNATE';
}

export interface SerializedEmaState {
  [modeName: string]: {
    emaScore: number;
    currentScore: number;
  };
}

export function getEmaStateForPersistence(): SerializedEmaState {
  const state: SerializedEmaState = {};
  modes.forEach((value, key) => {
    state[key] = {
      emaScore: value.emaScore,
      currentScore: value.currentScore,
    };
  });
  return state;
}

export function restoreEmaState(saved: SerializedEmaState): void {
  for (const [modeName, data] of Object.entries(saved)) {
    const mode = modes.get(modeName);
    if (mode) {
      mode.emaScore = data.emaScore;
      mode.currentScore = data.currentScore;
      mode.gap = data.currentScore - data.emaScore;
      if (mode.gap < HIBERNATE_THRESHOLD) {
        mode.status = 'HIBERNATE';
        mode.sizeMultiplier = 0;
      } else if (mode.gap > OVERHEAT_THRESHOLD) {
        mode.status = 'DEFENSIVE';
        mode.sizeMultiplier = 0.5;
      } else if (mode.gap > 0) {
        mode.status = 'AGGRESSIVE';
        mode.sizeMultiplier = 1.0;
      } else {
        mode.status = 'NEUTRAL';
        mode.sizeMultiplier = 0.75;
      }
    } else {
      const newMode = initializeMode(modeName, data.currentScore);
      newMode.emaScore = data.emaScore;
      newMode.gap = data.currentScore - data.emaScore;
      if (newMode.gap < HIBERNATE_THRESHOLD) {
        newMode.status = 'HIBERNATE';
        newMode.sizeMultiplier = 0;
      } else if (newMode.gap > OVERHEAT_THRESHOLD) {
        newMode.status = 'DEFENSIVE';
        newMode.sizeMultiplier = 0.5;
      } else if (newMode.gap > 0) {
        newMode.status = 'AGGRESSIVE';
        newMode.sizeMultiplier = 1.0;
      } else {
        newMode.status = 'NEUTRAL';
        newMode.sizeMultiplier = 0.75;
      }
    }
  }
  console.log(`[ModeManager] Restored EMA state for ${Object.keys(saved).length} modes`);
}

initializeMode('meanReversion');
initializeMode('volExpansion');
initializeMode('pairsTrading');
