# SPEC-04：核心数据结构与 JSON 数据库契约规范 (Data Schemas)

- **状态：** `APPROVED (已确认)`
- **版本：** `v1.0.0`
- **关联模块：** `src/core/types/`, `src/data/`

---

## 1. 全局游戏状态契约 (`GameState`)

所有游戏运行时状态必须满足纯 JSON 可序列化要求（无函数引用、无循环指针），以便在 Web Worker 间传输及直接持久化存档：

```typescript
export type XunPeriod = 0 | 1 | 2; // 0: 上旬 (1日), 1: 中旬 (11日), 2: 下旬 (21日)
export type GamePhase = 'STRATEGY_PHASE' | 'EXECUTION_PHASE' | 'XUN_SETTLEMENT';

export interface GameDate {
  year: number;       // 例如 190, 200
  month: number;      // 1 ~ 12
  xun: XunPeriod;     // 0: 上旬, 1: 中旬, 2: 下旬
  dayInXun: number;   // 1 ~ 10 (进行阶段当前第几天)
  tickInXun: number;  // 0 ~ 39 (1旬 = 40 Ticks)
}

export interface GameState {
  meta: {
    scenarioId: string;
    seed: number;
    turnCount: number;
    date: GameDate;
    phase: GamePhase;
    playerFactionIds: number[]; // 支持 1~8 人同屏热座模式
    activeHotseatFactionId: number;
  };
  map: {
    width: number;
    height: number;
    // 存档时可序列化为数组或 Base64，运行时转为 TypedArray
    tiles: TileData[];
  };
  factions: Record<number, FactionState>;
  settlements: Record<number, SettlementState>;
  economicPlots: Record<number, EconomicPlotState>;
  militaryFacilities: Record<number, MilitaryFacilityState>;
  officers: Record<number, OfficerState>;
  units: Record<number, UnitState>;
  clans: Record<string, GentryClanState>;
  operations: Record<string, MilitaryOperation>;
  battleLogs: BattleLogEntry[];
}
```

---

## 2. 武将、性格、把柄与九系兵法契约 (`OfficerState`)

```typescript
export type TacticCategory =
  | 'INFANTRY'      // 步兵: 奋战/奋斗/奋迅
  | 'CAVALRY'       // 骑兵: 突破/突进/突击
  | 'HORSE_ARCHER'  // 弓骑: 骑射/走射/飞射
  | 'CROSSBOW'      // 弩兵: 齐射/连射/连弩
  | 'NAVAL'         // 水军: 矢雨/矢岚/强袭/强攻
  | 'SIEGE'         // 攻城: 破城/射岚/投石
  | 'KNOWLEDGE'     // 智略: 扰乱/伪退/攻心
  | 'STRATAGEM'     // 谋略: 混乱/陷阱/心攻/幻术
  | 'STRATEGY';     // 策略: 骂声/鼓舞/治疗/妖术

export type PersonalityTraitId =
  | 'RECKLESS'      // 刚愎/骁勇 (易贪功追击)
  | 'CAUTIOUS'      // 沉稳/谨慎 (防伏兵、稳守)
  | 'BENEVOLENT'    // 仁德 (招抚流民与登庸加成)
  | 'RUTHLESS'      // 残暴/果忍 (威慑世家与死战加成)
  | 'LOYAL'         // 忠义 (极难被离间或策反)
  | 'AMBITIOUS'     // 野心 (高官职需求，太守易独立)
  | 'GREEDY';       // 重利 (易受财宝与把柄策反)

export interface OfficerHook {
  holderFactionId: number;
  type: 'WEAK_FAVOR' | 'STRONG_BLACKMAIL' | 'LIFE_SAVING_DEBT';
  description: string;
  expiresYear: number;
}

export interface OfficerState {
  id: number;
  name: { zh: string; en: string };
  courtesyName?: string;        // 字，如 "孟德"、"云长"
  birthYear: number;
  deathYear: number;
  portraitId: string;

  // 核心四维 (1 ~ 100)
  leadership: number;           // 统率
  might: number;                // 武力
  intelligence: number;         // 智力
  politics: number;             // 政治

  // 归属与状态
  factionId: number | null;     // null 表示在野/未发现
  locationSettlementId: number | null;
  assignedUnitId: number | null;
  status: 'ACTIVE' | 'UNRECRUITED' | 'CAPTIVE' | 'DEAD';
  captorFactionId?: number | null;
  hasActedThisXun: boolean;

  // 官职与忠诚
  courtOfficeId: string | null; // 文官或武官官职 ID
  loyalty: number;              // 0 ~ 100
  ambition: number;             // 野心 0 ~ 100
  duty: number;                 // 义理 0 ~ 100
  compatibility: number;        // 隐藏相性 1 ~ 150

  // 9系兵法熟练度 (0 ~ 1000) 与已学兵法
  proficiencies: Record<TacticCategory, number>;
  learnedTactics: string[];     // 如 ['inf_3_fenxun', 'cav_3_tuji', 'str_2_guwu']

  // 被动特技 (San11 风格) 与 CK3 人物深层属性
  passiveTraits: string[];      // 如 ['flying_general', 'gallop']
  personalities: PersonalityTraitId[];
  clanId: string | null;        // 所属世家门阀 ID，如 'clan_yingchuan_xun'

  // 宗族、义兄弟与死敌关系
  bloodLineId: number | null;   // 血缘宗亲组 ID
  swornBrotherIds: number[];    // 义兄弟 ID 列表
  nemesisIds: number[];         // 血海深仇死敌 ID 列表
  opinionLedger: Record<number, { reason: string; value: number }[]>;
  hooks: OfficerHook[];
}
```

---

## 3. 据点、人口阶层、武库与物流契约 (`SettlementState`)

```typescript
export type SettlementType = 'MAJOR_CITY' | 'PASS' | 'PORT' | 'COUNTY_TOWN';
export type LogisticsRole = 'REAR_SUPPLY' | 'BALANCED' | 'FRONTLINE_DEMAND';

export interface PopulationStructure {
  freePeasants: number;         // 自耕农 (赋税、农田劳动力、正规征兵源)
  clanRetainers: number;        // 世家部曲/佃农 (被豪族隐匿兼并人口)
  artisans: number;             // 工匠 (锻冶场、工房、造船厂劳动力)
  refugees: number;             // 流民 (动态跨城迁徙、可招抚或军屯)
}

export interface CityArsenal {
  infantryArms: number;         // 步兵军备 (刀盾/枪戟)
  crossbows: number;            // 弓弩
  warhorses: number;            // 战马
  batteringRams: number;        // 冲车
  siegeTowers: number;          // 井阑
  catapults: number;            // 投石机
  warships: number;             // 蒙冲/楼船/斗舰
}

export interface SettlementState {
  id: number;
  name: { zh: string; en: string };
  provinceId: string;           // 所属州，如 'SILI (司隶)', 'YANZHOU (兖州)'
  type: SettlementType;
  factionId: number | null;
  prefectOfficerId: number | null; // 现任太守

  // 网格坐标与占地
  x: number;
  y: number;
  footprintOffsets: [number, number][]; // 大都市 [[0,0],[1,0],[0,1],[1,1]] 或 [0,0]
  zocRadius: number;
  economicPlotIds: number[];    // 所属领地内政用地 ID 列表

  // 城防与资源
  troops: number;               // 现役守军
  woundedTroops: number;        // 城内待恢复伤兵
  morale: number;               // 守军士气 (0 ~ 100)
  gold: number;                 // 资金
  food: number;                 // 兵粮
  wallDurability: number;
  maxWallDurability: number;
  publicOrder: number;          // 民心/治安 (0 ~ 100)

  // P社融合属性：四阶人口、控制度、世家与漕运
  pops: PopulationStructure;
  controlRate: number;          // 政令控制度 10 ~ 100 (%)
  dominantClanId: string | null;// 盘踞的本土世家门阀
  logisticsRole: LogisticsRole; // 军需漕运网角色标记
  arsenal: CityArsenal;

  // 特殊地域加成标签
  regionalBonuses: ('HORSE_PASTURE' | 'NAVAL_HUB' | 'METROPOLIS' | 'FERTILE_PLAIN')[];
}
```

---

## 4. 野战部队与阵型三列契约 (`UnitState`)

```typescript
export type RowPosition = 'FRONT' | 'MIDDLE' | 'REAR';

export interface UnitOfficerSlot {
  officerId: number;
  row: RowPosition;
  isCommander: boolean;
}

export type UnitOrderType =
  | 'MARCH_AND_ATTACK'          // 进军并攻击目标据点/部队
  | 'INTERCEPT_ZONE'            // 迎击进入指定区域的敌军
  | 'GARRISON_ENTER'            // 进驻目标友方据点
  | 'BUILD_FACILITY'            // 在目标格修筑军事设施 (阵/砦/橹/投石台/陷阱)
  | 'TRANSPORT_SUPPLY'          // 向目标据点或友军输送钱粮军备
  | 'RETREAT';                  // 撤退回所属据点

export interface UnitState {
  id: number;
  factionId: number;
  originSettlementId: number;
  formationId: string;          // 当前陆地阵型 ID，如 'FISH_SCALE', 'ARROWHEAD'
  navalFormationId: string;     // 入水切换的水军阵型 ID，如 'NAVAL_LIGHT', 'NAVAL_TOWER'

  // 1~5 名武将及前中后三列站位
  slots: UnitOfficerSlot[];

  // 兵力、伤兵、士气与携带物资
  troops: number;
  wounded: number;
  morale: number;               // 0 ~ 100 (<= 0 时立即全军溃灭!)
  goldCarried: number;
  foodCarried: number;
  equippedBows: boolean;        // 锥行/箕形等可选配弓弩标记

  // 地图位置与行军路线
  x: number;
  y: number;
  order: {
    type: UnitOrderType;
    targetX: number;
    targetY: number;
    targetSettlementId?: number;
    targetUnitId?: number;
    buildFacilityType?: string;
    path: [number, number][];
  };

  // 战斗状态异常与 CK3 战场性格触发标记
  statusEffect: 'NORMAL' | 'CONFUSED' | 'TRAPPED' | 'TAUNTED' | 'BLOOD_FEUD_RAGE';
  statusDurationTicks: number;
}
```
