/**
 * SPEC-02: 武将被动特技 (特技)、CK3 性格特质、东汉世家门阀与君主国策定义
 */

export const PASSIVE_TRAITS = {
  flying_general: {
    id: 'flying_general',
    name: '飞将',
    color: '#ef4444',
    desc: '陆地行军无视敌军 ZOC 阻挡，兵法触发率 +25%，对武力低于己者兵法必暴击（伤害×1.35）。',
  },
  gallop: {
    id: 'gallop',
    name: '疾驰',
    color: '#f59e0b',
    desc: '骑兵阵型移动速度 +20%；发动骑兵系兵法时若武力高于敌主将，35% 概率使其陷入【混乱】。',
  },
  divine_calc: {
    id: 'divine_calc',
    name: '神算',
    color: '#3b82f6',
    desc: '智略/谋略系兵法触发率 +30% 且伤害 +25%，所在部队免疫敌方谋略混乱。',
  },
  iron_wall: {
    id: 'iron_wall',
    name: '铁壁',
    color: '#10b981',
    desc: '部队防御力 +25%，驻守城池或关隘时受到的城墙耐久与守军伤害降低 30%。',
  },
  archer_god: {
    id: 'archer_god',
    name: '弓神',
    color: '#8b5cf6',
    desc: '弩兵与弓骑兵法伤害 +30%，狙击敌方中/后列武将的概率翻倍。',
  },
  tuntian_master: {
    id: 'tuntian_master',
    name: '屯田',
    color: '#84cc16',
    desc: '驻留城池或关隘时，每旬额外产出 +600 兵粮，且所在部队野外行军耗粮降低 35%。',
  },
  king_advisor: {
    id: 'king_advisor',
    name: '王佐',
    color: '#06b6d4',
    desc: '所在城市政令控制度 +12%，锻冶场与市场被动产出 +25%，且每旬加速恢复伤兵。',
  },
  fierce_vanguard: {
    id: 'fierce_vanguard',
    name: '陷阵',
    color: '#ec4899',
    desc: '位于前列时，步兵系兵法威力 +25% 且部队士气衰减减半。',
  },
};

export const PERSONALITY_TRAITS = {
  RECKLESS: {
    id: 'RECKLESS',
    name: '刚愎骁勇',
    desc: '【CK3性格】近战兵法触发率 +15%，但遭遇敌军伪退或残敌时极易触发【贪功冒进】。',
  },
  CAUTIOUS: {
    id: 'CAUTIOUS',
    name: '沉稳谨慎',
    desc: '【CK3性格】部队防御 +10%，陷入混乱或被围时触发【临危不乱】，士气损耗减半。',
  },
  BENEVOLENT: {
    id: 'BENEVOLENT',
    name: '仁德宽厚',
    desc: '【CK3性格】所在城池流民迁入吸引力 +30%，俘虏登庸成功率大幅提升。',
  },
  RUTHLESS: {
    id: 'RUTHLESS',
    name: '果忍枭雄',
    desc: '【CK3性格】压制地方世家豪族权势，遇到血仇死敌时部队攻击力暴涨 +25%。',
  },
  LOYAL: {
    id: 'LOYAL',
    name: '忠烈义士',
    desc: '【CK3性格】免疫常规离间，与义兄弟或同族同队时联动概率额外 +25%。',
  },
  AMBITIOUS: {
    id: 'AMBITIOUS',
    name: '野心勃勃',
    desc: '【CK3性格】带兵作战战功卓著，但若长期不封官赏赐或被握有把柄，易生异心。',
  },
};

export const GENTRY_CLANS = {
  clan_yingchuan_xun: {
    id: 'clan_yingchuan_xun',
    name: '颍川荀氏·陈氏',
    homeProvince: '豫州',
    homeSettlementId: 4, // 许昌
    influence: 68,
    attitudeByFaction: { 1: 85, 2: 55, 3: 30, 4: 25, 5: 65 },
    description: '豫州顶级士族门阀，“荀氏八龙”与陈群家族所在，掌控中原清议与士人命脉。',
  },
  clan_runan_yuan: {
    id: 'clan_runan_yuan',
    name: '汝南袁氏（四世三公）',
    homeProvince: '冀州/豫州',
    homeSettlementId: 7, // 邺城 / 汝南
    influence: 78,
    attitudeByFaction: { 1: 45, 2: 92, 3: 40, 4: 30, 5: 55 },
    description: '门生故吏遍天下之天下第一名门，在河北与汝南拥有庞大部曲私兵与庄园。',
  },
  clan_qiaojun_cao: {
    id: 'clan_qiaojun_cao',
    name: '谯郡曹氏·夏侯氏',
    homeProvince: '兖州',
    homeSettlementId: 5, // 陈留
    influence: 64,
    attitudeByFaction: { 1: 95, 2: 35, 3: 30, 4: 35, 5: 40 },
    description: '沛国谯县宗族军事集团，世代为曹魏提供最核心的宗亲统帅与亲卫部曲。',
  },
  clan_henei_sima: {
    id: 'clan_henei_sima',
    name: '河内司马氏·洛阳世家',
    homeProvince: '司隶',
    homeSettlementId: 2, // 洛阳
    influence: 72,
    attitudeByFaction: { 1: 65, 2: 60, 3: 40, 4: 45, 5: 55 },
    description: '司隶河内名门，深谙权谋韬略，在洛阳与关中拥有极高政治话语权。',
  },
  clan_xuzhou_mi: {
    id: 'clan_xuzhou_mi',
    name: '东海糜氏·徐州豪族',
    homeProvince: '徐州',
    homeSettlementId: 11, // 徐州
    influence: 62,
    attitudeByFaction: { 1: 35, 2: 45, 3: 60, 4: 30, 5: 90 },
    description: '富甲一方的徐州大商贾与豪强，僮客万人，资财亿计。',
  },
};

export const FACTION_POLICIES = {
  BALANCED: {
    id: 'BALANCED',
    name: '均衡治国',
    desc: '兼顾国家编户与地方豪强利益，无额外奖惩。',
    controlBonus: 0,
    taxMult: 1.0,
    clanAttitudeDelta: 0,
  },
  TUNTIAN: {
    id: 'TUNTIAN',
    name: '军屯制度（屯田令）',
    desc: '【曹操特色国策】流民转化自耕农速度×3，农田兵粮产出 +25%，控制度 +8%。',
    controlBonus: 8,
    taxMult: 1.15,
    clanAttitudeDelta: -5,
  },
  MERITOCRACY: {
    id: 'MERITOCRACY',
    name: '唯才是举·清丈隐户',
    desc: '每旬强制将 8% 世家隐匿部曲清丈转回国家自耕农，控制度 +15%，但世家好感下降。',
    controlBonus: 15,
    taxMult: 1.2,
    clanAttitudeDelta: -12,
  },
  NINE_RANK_CLAN: {
    id: 'NINE_RANK_CLAN',
    name: '礼遇世家·九品官人',
    desc: '世家门阀好感大幅提升，可随时征调世家精锐私兵与战马，但世家兼并隐户加速。',
    controlBonus: -5,
    taxMult: 0.92,
    clanAttitudeDelta: 15,
  },
};
