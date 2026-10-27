export const TRANSIT_RATES: Record<string, number> = {
  TRAIN_TER: 35,
  METRO: 30,
  TELEO: 25,
  BUS_LINEO: 15,
  TRAM: 12,
  BUS_LOCAL: 6,
};

export const DEFAULT_INITIAL_COINS = 250;
export const DEFAULT_JAIL_TIME_MINUTES = 15;
export const DEFAULT_PING_INTERVAL_MINUTES = 10;
export const DEFAULT_VETO_DURATION_MINUTES = 20;
export const CAPTURE_RADIUS_METERS = 15;

export interface CurseTemplate {
  id: string;
  title: string;
  description: string;
  durationMinutes: number;
}

export const CURSE_TEMPLATES: CurseTemplate[] = [
  {
    id: 'curse_sonar',
    title: 'Sonar Permanent',
    description: 'Votre balise GPS diffuse votre position exacte aux chasseurs en temps réel à chaque ping.',
    durationMinutes: 20,
  },
  {
    id: 'curse_freeze',
    title: 'Arrêt Forcé (Freeze)',
    description: 'Le Runner doit s\'immobiliser immédiatement pendant 5 minutes sans pouvoir se déplacer.',
    durationMinutes: 5,
  },
  {
    id: 'curse_speed_limit',
    title: 'Interdiction de Courir',
    description: 'Le Runner n\'a le droit qu\'à la marche normale pendant 15 minutes.',
    durationMinutes: 15,
  },
  {
    id: 'curse_no_station',
    title: 'Zone Interdite',
    description: 'Interdiction d\'entrer dans les gares ou stations pendant la durée du véto.',
    durationMinutes: 20,
  },
];
