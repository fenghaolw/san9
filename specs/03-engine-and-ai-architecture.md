# SPEC-03：桌面多线程引擎架构、2.5D 分块渲染与三层效用 AI 规范

- **状态：** `APPROVED (已确认)`
- **版本：** `v1.0.0`
- **关联模块：** `src/workers/`, `src/render/`, `src/core/ai/`

---

## 1. 主线程与 Web Worker 多线程分离架构

为确保桌面 Web 端与 Tauri 原生桌面端在大规模沙盘推演下始终维持 **60～120 FPS**，引擎采用 **双线程群 + 双缓冲 `TypedArray`** 架构：

### 1.1 线程职责边界
1. **Main Thread（主线程）：**
   * 运行 Three.js 2.5D 沙盘渲染循环（`requestAnimationFrame`）与 React 19 宽屏 HUD / 弹窗 UI。
   * **严禁在主线程执行：** A\* / 流场寻路、热力图卷积、AI 效用评估、10 天 Tick 战斗结算。
2. **Simulation & AI Worker（后台模拟与 AI 线程）：**
   * 维护权威的 `GameState` 与 `SeededPRNG`。
   * **战略阶段“思考时间窃取”（Speculative AI Pre-computation）：**
     * 每当进入新的一旬（`STRATEGY_PHASE`）的第 $0$ 毫秒，Worker 立即在后台异步计算所有非玩家 AI 势力的本旬指令（宏观态势 $\rightarrow$ 战役黑板更新 $\rightarrow$ 内政排期 $\rightarrow$ 出征编队）并缓存于 `pendingAIOrders`。
     * 当玩家完成操作并点击 **【▶ 进行】** 按钮时，主线程只需通过 `postMessage` 发送玩家本旬指令集，Worker 直接合并已算好的 `pendingAIOrders` 并立即开始第 1 Tick 推演，实现 **0 毫秒等待延迟**。

### 1.2 紧凑内存布局（SoA TypedArrays）
大地图高频访问数据一律存储于定长 `TypedArray` 中（大小为 $W \times H$）：
* `terrainType: Uint8Array` — 地形枚举值
* `elevation: Float32Array` — 节点海拔高度
* `ownerFaction: Int16Array` — 领地归属势力 ID（$-1$ 表示无主荒野）
* `zocMask: Uint32Array` — 各势力 ZOC 位掩码（支持 $O(1)$ 位运算判定敌对 ZOC）
* `threatHeatmap: Float32Array` — AI 威胁度卷积场

---

## 2. Three.js 2.5D 分块渲染与五大战略透镜（Map Lenses）

### 2.1 “伪3D”多角度沙盘相机（`MapCameraController`）
* 采用低畸变透视相机（$\text{FOV} = 28^\circ$）：
  * **平移（Pan）：** 键盘 `W/A/S/D`、方向键、鼠标中键拖拽或屏幕边缘滚动；
  * **缩放（Zoom）：** 鼠标滚轮平滑插值相机距离 $d \in [18, 140]$；
  * **旋转与俯仰（Orbit / Tilt）：** 键盘 `Q/E` 或按住鼠标右键拖拽，支持水平 $360^\circ$ 旋转（Yaw）与俯仰角 $\theta \in [35^\circ, 65^\circ]$ 调节，并提供一键归北（`N` 键）快捷操作。

### 2.2 五大战略地图透镜（快捷键 `F1`～`F5`）
通过切换 `ChunkedTerrainMesh` 的 Uniform 模式与 `TacticalOverlayLayer` 实现：

| 快捷键 | 透镜名称 | 视觉表现与战略用途 |
| :---: | :--- | :--- |
| `F1` | **战术兵棋透镜（默认）** | 四季自然写实地形着色、立体兵牌、阵型图标、主将旗号、城外经济/军事设施 |
| `F2` | **政治与外交透镜** | 按势力主色高亮染色各州郡城池疆域，绘制同盟线（蓝）、交战箭头（红）与停战期标记 |
| `F3` | **控制度与世家透镜** | 地面按 `Control%` 呈绿（$100\%$）$\rightarrow$ 黄 $\rightarrow$ 红（$<30\%$）热力分布，城池上方悬浮盘踞世家门阀徽记与态度 |
| `F4` | **人口阶层与流民透镜** | 各城升起自耕农/部曲/工匠三维柱状图，官道上动态播放流民迁徙粒子流向 |
| `F5` | **军需漕运网透镜** | 高亮显示水陆漕运干线、港口吞吐负荷，并以金色/青色流动虚线展示后方基地向一线军镇的粮草军备输送 |

---

## 3. 流场寻路（Flow Field）与分层 HPA\* 混合寻路规范

1. **流场寻路（Flow Field Pathfinding）：**
   * 针对主要战略目标据点（如被围攻的城池、关隘），通过一次 Dijkstra 波前传播生成指向该据点的 `FlowField`（每个格子记录最优 8 方向向量，耗费内存仅 $W \times H$ 字节）。
   * 同一战役下辖的多支部队共享同一张流场图，每 Tick 寻路复杂度为 $O(1)$，并在局部 2 格范围内结合动态单位避让与敌方 ZOC 拦截判定。
2. **A\* 精确路径预览：**
   * 玩家在战略阶段拖拽部队行军箭头时，使用 8 方向带地形/阵型权重的 A\* 实时计算最优路径，并在地图上按每 10 天（1 旬）分段标注预计到达节点（例如：`第 4 日抵达虎牢关前`）。

---

## 4. 三层效用 AI 君主架构与算法实现规范

### 4.1 第一层：宏观势力战略层（`MacroFactionPlanner`）
每旬初执行一次，时间复杂度 $O(|C| + |U|)$：
1. **计算全图威胁度与脆弱度：**
   $$T(x, y) = \sum_{e \in \text{Enemies}} \frac{\text{CombatPower}(e)}{1 + 0.15 \cdot \text{TravelDays}(e, (x, y))^2}$$
   $$V(\text{base}) = \frac{T(\text{base})}{\max(1000,\; \text{GarrisonPower}(\text{base}) + \text{WallDurability}(\text{base}) \times 10)}$$
2. **动态分配城池物流与战略角色：**
   * 若城池 12 天行军范围内无敌方据点 $\rightarrow$ 设为 `REAR_SUPPLY`（后方供应基地），优先扩建 `农田/市场/锻冶场/厩舍` 至 `Lv3`，并将闲置武将调往一线；
   * 若城池邻近敌境且 $V(\text{base}) > 0.85$ $\rightarrow$ 设为 `FRONTLINE_DEFENSE`（前线防守军镇）；
   * 若城池邻近敌方薄弱据点且本城集结兵力充沛 $\rightarrow$ 设为 `STAGING_LAUNCHPAD`（战役进攻策源地）。

### 4.2 第二层：中观跨旬战役黑板与城池效用评分器（`OperationalPlanner`）
为彻底杜绝传统策略游戏 AI“单队添油送死”与“朝令夕改”，每个进攻或防守任务建模为持久化在 `GameState` 中的 **跨旬战役黑板（`MilitaryOperation`）**：

* **战役状态机转换规则：**
  * `STAGING (筹备集结)`：锁定目标据点 $C_{\text{target}}$，计算所需最低兵力阈值 $M_{\text{req}} = 1.4 \times \text{DefenderPower}(C_{\text{target}})$。在此阶段严禁单队贸然出击，而是等待后方漕运补充军备与兵力。
  * `LAUNCHING (集团出击)`：当集结城池可用兵力 $\ge M_{\text{req}}$ 且武将 $\ge 6$ 人时，**在同一旬内同时组建 2～3 支野战护卫队（`鱼鳞/锋矢/雁行`）+ 1 支攻城器械队（`井阑/投石/冲车`）协同出征**！
  * `ENGAGING / SIEGING (交锋围城)`：野战队负责清理敌方出城迎击部队与城外箭楼，攻城队紧随其后轰击城墙。
  * `ABORTED (战役中止)`：若战役总战损超过 $45\%$、随军兵粮低于 3 天且无补给队，或出发城池自身遭到更大规模敌军奇袭（$V(\text{origin}) > 1.3$），则全军有序撤退回城。

### 4.3 第三层：微观五将高联动编队器（`TacticalUnitOptimizer`）
给定出征任务类型（`FIELD_ASSAULT` / `RANGED_SUPPORT` / `SIEGE` / `INTERCEPT`）与城内可用武将集合 $O_{\text{idle}}$，采用 **启发式评分算法** 选出最优 $(F^*, G^*)$：

1. **阵型筛选：** 根据城内现有武库库存（战马、步兵军备、弓弩、攻城器械）与目标地形过滤出合法阵型集合 $\mathcal{F}_{\text{valid}}$。
2. **五将羁绊与联动期望最大化：**
   * 选定统率与武官官职最高的武将作为主将 $g_1$；
   * 对其余候选副将 $g \in O_{\text{idle}}$，按以下协同得分排序选出前 4 名：
     $$\text{Synergy}(g \;|\; g_1, F) = 40 \cdot \mathbf{1}_{\text{SameTacticCat}(g, g_1, F)} + 35 \cdot \text{BondMultiplier}(g, g_1) + 0.3 \cdot \text{PrimaryStat}(g, F) + 15 \cdot \mathbf{1}_{\text{HasSupportTactic}(g)}$$
   * **三列自动排布：** 将高武力近战武将置入 `FRONT (前列)`，将拥有 `弩兵/弓骑/攻城/心攻/治疗/鼓舞` 的高智力或远程武将置入 `MIDDLE / REAR (中后列)`。
