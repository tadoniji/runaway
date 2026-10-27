import { ActiveCurse, GameSettings } from './types';

// Default transport rates in coins / minute
export const DEFAULT_TRANSPORT_RATES: Record<string, number> = {
  TRAIN_TER: 35,
  METRO: 30,
  TELEO: 25,
  BUS_LINEO: 15,
  TRAM: 12,
  BUS_LOCAL: 6,
};

// Default game settings
export const DEFAULT_SETTINGS: GameSettings = {
  pingIntervalMinutes: 10,
  jailTimeMinutes: 15,
  vetoDurationMinutes: 20,
  captureRadiusMeters: 15,
  transportRates: { ...DEFAULT_TRANSPORT_RATES },
  challenges: [],
};

// Initial balance for the Runner
export const INITIAL_RUNNER_COINS = 250;

// Currencies and penalties pool
export const CURSE_TEMPLATES: Omit<ActiveCurse, 'id'>[] = [
  {
    title: 'Sonar Permanent',
    description: 'Votre balise GPS diffuse votre position exacte aux chasseurs en temps réel à chaque ping.',
    coinReward: 50,
    type: 'SONAR',
    durationMs: 20 * 60 * 1000,
  },
  {
    title: 'Arrêt Forcé (Freeze)',
    description: 'Le Runner doit s\'immobiliser immédiatement pendant 5 minutes sans pouvoir se déplacer.',
    coinReward: 75,
    type: 'FREEZE',
    durationMs: 5 * 60 * 1000,
  },
  {
    title: 'Interdiction de Courir',
    description: 'Le Runner n\'a le droit qu\'à la marche normale pendant les 15 prochaines minutes.',
    coinReward: 40,
    type: 'SPEED_LIMIT',
    durationMs: 15 * 60 * 1000,
  },
  {
    title: 'Zone Interdite',
    description: 'Interdiction d\'entrer dans les gares ou stations pendant la durée du véto.',
    coinReward: 60,
    type: 'NO_CHECK_IN',
    durationMs: 20 * 60 * 1000,
  },
];
