import { Curse, TransitMode } from './types';

// Transit cost in coins per minute
export const TRANSIT_RATES: Record<TransitMode, number> = {
  TRAIN_TER: 35,
  METRO: 30,
  TELEO: 25,
  BUS_LINEO: 15,
  TRAM: 12,
  BUS_LOCAL: 6,
};

// Initial runner balance
export const INITIAL_COINS = 250;

// Veto duration applied when balance drops below 0 (20 minutes)
export const VETO_DURATION_MS = 20 * 60 * 1000;

// Interval between regular hunter location pings (10 minutes)
export const HUNTER_PING_INTERVAL_MS = 10 * 60 * 1000;

// List of curses pool for overdraft penalties
export const CURSE_POOL: Omit<Curse, 'id' | 'appliedAt'>[] = [
  {
    type: 'SONAR',
    name: 'Sonar Permanent',
    description: 'Votre balise GPS diffuse votre position exacte aux chasseurs en temps réel à chaque ping.',
    durationMs: 20 * 60 * 1000,
  },
  {
    type: 'FREEZE',
    name: 'Arrêt Forcé (Freeze)',
    description: 'Le Runner doit s\'immobiliser immédiatement pendant 5 minutes sans pouvoir se déplacer.',
    durationMs: 5 * 60 * 1000,
  },
  {
    type: 'SPEED_LIMIT',
    name: 'Interdiction de Courir',
    description: 'Le Runner n\'a le droit qu\'à la marche normale pendant les 15 prochaines minutes.',
    durationMs: 15 * 60 * 1000,
  },
  {
    type: 'NO_CHECK_IN',
    name: 'Zone Interdite',
    description: 'Interdiction d\'entrer dans les gares ou stations pendant la durée du véto.',
    durationMs: 20 * 60 * 1000,
  },
];
