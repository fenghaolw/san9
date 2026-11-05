/**
 * SPEC-04: 核心数据结构与 JSON 数据库契约定义 (TypeScript Type Contracts)
 */

export type XunPeriod = 0 | 1 | 2; // 0: 上旬 (1日), 1: 中旬 (11日), 2: 下旬 (21日)
export type GamePhase = 'STRATEGY_PHASE' | 'EXECUTION_PHASE' | 'XUN_SETTLEMENT';
export type MapLensMode = 'TACTICAL' | 'POLITICAL' | 'CONTROL_CLAN' | 'POPS_REFUGEE' | 'LOGISTICS';

export interface GameDate {
  year: number;
  month: number;
  xun: XunPeriod;
  dayInXun: number;   // 1 ~ 10
  tickInXun: number;  // 0 ~ 39 (1旬 = 40 Ticks)
}

export type TerrainType =
  | 'PLAIN'
  | 'ROAD'
  | 'FOREST'
  | 'MOUNTAIN'
  | 'WATER'
  | 'FORD'
  | 'MARSH'
  | 'CLIFF';

export type TacticCategory =
  | 'INFANTRY'
  | 'CAVALRY'
  | 'HORSE_ARCHER'
  | 'CROSSBOW'
  | 'NAVAL'
  | 'SIEGE'
  | 'KNOWLEDGE'
  | 'STRATAGEM'
  | 'STRATEGY';

export type PersonalityTraitId =
  | 'RECKLESS'
  | 'CAUTIOUS'
  | 'BENEVOLENT'
  | 'RUTHLESS'
  | 'LOYAL'
  | 'AMBITIOUS'
  | 'GREEDY';

export interface OfficerHook {
  holderFactionId: number;
  type: 'WEAK_FAVOR' | 'STRONG_BLACKMAIL' | 'LIFE_SAVING_DEBT';
  description: string;
  expiresYear: number;
}

export interface OfficerState {
  id: number;
  name: string;
  courtesyName: string;
  factionId: number | null;
  locationSettlementId: number | null;
  assignedUnitId: number | null;
  status: 'ACTIVE' | 'UNRECRUITED' | 'CAPTIVE' | 'DEAD';
  captorFactionId?: number | null;
  hasActedThisXun: boolean;

  leadership: number;
  might: number;
  intelligence: number;
  politics: number;

  courtOfficeId: string | null;
  loyalty: number;
  ambition: number;
  duty: number;
  compatibility: number; // 1 ~ 150

  proficiencies: Record<TacticCategory, number>;
  learnedTactics: string[];
  passiveTraits: string[];
  personalities: PersonalityTraitId[];
  clanId: string | null;

  bloodLineId: number | null;
  swornBrotherIds: number[];
  nemesisIds: number[];
  hooks: OfficerHook[];
}

export type SettlementType = 'MAJOR_CITY' | 'PASS' | 'PORT' | 'COUNTY_TOWN';
export type LogisticsRole = 'REAR_SUPPLY' | 'BALANCED' | 'FRONTLINE_DEMAND';

export interface PopulationStructure {
  freePeasants: number;
  clanRetainers: number;
  artisans: number;
  refugees: number;
}

export interface CityArsenal {
  infantryArms: number;
  crossbows: number;
  warhorses: number;
  batteringRams: number;
  siegeTowers: number;
  catapults: number;
  warships: number;
}

export interface EconomicPlotState {
  id: number;
  settlementId: number;
  type: 'FARM' | 'MARKET' | 'BARRACKS' | 'SMITHY' | 'STABLE' | 'WORKSHOP' | 'SHIPYARD';
  level: 1 | 2 | 3;
  x: number;
  y: number;
  durability: number;
  maxDurability: number;
  buildProgress: number; // 0 ~ 100
  isUpgrading: boolean;
}

export interface SettlementState {
  id: number;
  name: string;
  province: string;
  type: SettlementType;
  factionId: number | null;
  prefectOfficerId: number | null;
  x: number;
  y: number;
  footprintOffsets: [number, number][];
  zocRadius: number;
  economicPlots: EconomicPlotState[];
  connectedSettlementIds: number[];

  troops: number;
  woundedTroops: number;
  morale: number;
  gold: number;
  food: number;
  wallDurability: number;
  maxWallDurability: number;
  publicOrder: number;

  pops: PopulationStructure;
  controlRate: number;
  dominantClanId: string | null;
  logisticsRole: LogisticsRole;
  arsenal: CityArsenal;
  regionalBonuses: string[];
}

export type RowPosition = 'FRONT' | 'MIDDLE' | 'REAR';

export interface UnitOfficerSlot {
  officerId: number;
  row: RowPosition;
  isCommander: boolean;
}

export interface UnitState {
  id: number;
  factionId: number;
  originSettlementId: number;
  formationId: string;
  slots: UnitOfficerSlot[];
  troops: number;
  wounded: number;
  morale: number;
  goldCarried: number;
  foodCarried: number;
  x: number;
  y: number;
  order: {
    type: 'MARCH_AND_ATTACK' | 'INTERCEPT_ZONE' | 'GARRISON_ENTER' | 'BUILD_FACILITY' | 'RETREAT';
    targetX: number;
    targetY: number;
    targetSettlementId?: number;
    targetUnitId?: number;
    path: [number, number][];
  };
  statusEffect: 'NORMAL' | 'CONFUSED' | 'TRAPPED' | 'BLOOD_FEUD_RAGE';
  statusDurationTicks: number;
  lastTacticBanner?: {
    text: string;
    chainCount: number;
    damage: number;
    tick: number;
  } | null;
}

export interface GentryClanState {
  id: string;
  name: string;
  homeProvince: string;
  homeSettlementId: number;
  influence: number; // 0 ~ 100
  attitudeByFaction: Record<number, number>; // 0 ~ 100
  description: string;
}

export interface FactionState {
  id: number;
  name: string;
  rulerOfficerId: number;
  capitalSettlementId: number;
  color: string;
  bannerChar: string;
  courtRank: string;
  prestige: number;
  activePolicy: 'BALANCED' | 'TUNTIAN' | 'MERITOCRACY' | 'NINE_RANK_CLAN';
  relations: Record<number, number>;
}

export interface GameState {
  meta: {
    scenarioId: string;
    scenarioName: string;
    seed: number;
    turnCount: number;
    date: GameDate;
    phase: GamePhase;
    playerFactionIds: number[];
    activeHotseatFactionId: number;
  };
  map: {
    width: number;
    height: number;
    terrain: number[];
    elevation: number[];
  };
  factions: Record<number, FactionState>;
  settlements: Record<number, SettlementState>;
  officers: Record<number, OfficerState>;
  units: Record<number, UnitState>;
  clans: Record<string, GentryClanState>;
  facilities: Record<number, {
    id: number;
    type: 'CAMP' | 'FORT' | 'TOWER' | 'CATAPULT_TOWER' | 'STONE_WALL' | 'FIRE_TRAP';
    name: string;
    factionId: number;
    x: number;
    y: number;
    durability: number;
    maxDurability: number;
  }>;
  battleLogs: {
    id: number;
    dateStr: string;
    type: 'TACTIC_CHAIN' | 'COMBAT' | 'PERSONALITY' | 'ECONOMY' | 'POLITICS' | 'CAPTURE';
    text: string;
    highlight?: boolean;
    x?: number;
    y?: number;
  }[];
  activeCutin: {
    id: number;
    officerNames: string[];
    tacticName: string;
    chainCount: number;
    damage: number;
    targetName: string;
    factionColor: string;
    barkText?: string;
  } | null;
}
