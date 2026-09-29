# GCORES 动态自动点赞 Worker

无人值守的机核（[GCORES](https://www.gcores.com/)）动态自动点赞工具：无头浏览器 +
短生命周期进程 + Windows 计划任务调度，附带一个本地可视化控制台。

不依赖桌面会话——远程桌面断开、锁屏、注销、重启，都不影响自动运行。

## 工作方式

```
Windows 计划任务（每 N 分钟）
  └─ gc.cmd → node src/cli.js run        一轮 = 一个短生命周期进程
       ├─ 无头 Chromium 打开机核动态页
       ├─ 提取动态 → 规则筛选 → 逐条点赞（带随机间隔）
       ├─ 状态原子落盘（已处理 / 计数 / 历史 / 登录态回写）
       └─ 进程退出，不留任何常驻服务
```

三条核心设计原则：

1. **无头渲染**。有头浏览器需要活跃的桌面会话，远程桌面断开后合成器停摆、
   渲染节流，自动化随之失效；无头模式没有这个依赖。
2. **短生命周期进程**。调度权交给操作系统，每轮跑完即退。没有常驻进程，
   就没有"挂着挂着就死了"的单点；崩溃、断电之后的下一轮调度自动恢复。
3. **状态全部落盘**。每轮的所有状态（已处理条目、计数、冷却、登录态）
   原子写入磁盘，进程随时可被杀，数据不会坏。

## 环境要求

- Windows 10 / 11（计划任务调度依赖 PowerShell `ScheduledTasks` 模块）
- Node.js ≥ 18（建议 20 / 22 LTS）
- 一个能登录机核的 Chromium 系浏览器（Edge / Chrome），仅在导入登录态时需要

## 安装

```powershell
git clone https://github.com/sonicpic/gcores-thumbs-up.git
cd gcores-thumbs-up/headless-worker
npm install
npx playwright install chromium
```

## 快速开始

```powershell
npm run gc:session:import   # ① 从本机浏览器导入机核登录态（一次性）
npm run gc:dry              # ② 试运行：只做规则匹配，不真正点赞
npm run gc:task:install     # ③ 注册计划任务，默认每 30 分钟一轮
```

之后可以随时打开控制台查看状态、调整配置：

```powershell
npm run gc:ui               # 或直接双击 tools\gc-ui.cmd
```

## 登录态

Worker 与浏览器 profile 完全解耦：导入时把机核的 cookie 导出为
`storageState` 文件（`.gcores-auto-like/session.json`），运行期只读这个文件，
不占用任何浏览器目录。

```powershell
npm run gc:session          # 查看当前登录态详情（凭证类型 / 剩余有效期）
npm run gc:session:import   # 从 config.json 里配置的来源导入
npm run gc:login            # 备选：打开有头浏览器手动登录一次
```

几点说明：

- **导入来源**在 `config.json` 的 `session.sources` 里配置，按顺序尝试；
  支持 Chromium 系浏览器的 profile 目录。
- 浏览器**正在运行**时其 cookie 库被独占锁定，需要先完全退出对应浏览器再导入；
  也可以改用 `gc:login` 手动登录，不受此限制。
- 每轮运行结束会把服务端续期后的 cookie 写回 `session.json`，正常情况下
  无需反复导入。
- 凭证剩余不足 14 天时，每天推送一次到期提醒（跟随通知开关），避免静默失效。
- 判断登录寿命看 `appToken` / `userID` 这类长命凭证；`acw_tc` 等短命 cookie
  是 WAF / 埋点用途，每次访问都会刷新，不代表登录状态。

## 计划任务

```powershell
npm run gc:task:install                 # 注册，默认每 30 分钟
npm run gc:task:install -- --interval-minutes 15
npm run gc:task:status                  # 查看任务状态 + 最近一次运行结果
npm run gc:task:stop                    # 停止（禁用）自动运行，任务保留
npm run gc:task:start                   # 恢复自动运行
npm run gc:task:remove                  # 删除任务
```

> **停止 ≠ 删除**：`stop` 只是禁用任务（并终止正在跑的一轮），随时 `start` 恢复；
> `remove` 才是彻底移除。控制台窗口的开关不影响任务状态。

注册出来的任务：

- wall-clock 重复触发，每 N 分钟一次；
- `MultipleInstances = IgnoreNew`：上一轮没跑完就跳过本次触发；
- `ExecutionTimeLimit = 20 分钟`：操作系统兜底杀超时进程；
- `StartWhenAvailable`：关机错过的触发，开机后补跑；
- Worker 内部另有跨进程互斥锁与单轮硬超时，双保险。

默认以 **Interactive** 身份注册（当前账号有会话即可，无需管理员）。
如果需要机器完全无人登录时也照跑，用 S4U 身份注册（需要管理员权限）：

```powershell
npm run gc:task:install -- --s4u --force
```

### 执行时刻的随机抖动

计划任务的触发间隔无法随机化，抖动在 worker 进程内实现：每轮在冷却 / 上限
检查之后、启动浏览器之前，随机睡 `timing.jitterMsRange`（默认 0～120 秒）。
计划任务仍按固定间隔触发，但真正开始工作的时刻带随机偏移，不会整点卡点。
配合每个点赞动作之间的 `actionDelayMsRange`（默认 2.5～7 秒）与可配置的
活跃时段窗口，整体节奏不会机械规律。

## 日常使用

```powershell
npm run gc:ui            # 图形控制台（推荐）
npm run gc:run           # 手动跑一轮
npm run gc:dry           # 试运行（不点赞）
npm run gc:doctor        # 体检：环境 / 登录态 / 调度 / 最近一轮
npm run gc:state         # 查看运行时状态
npm run gc:notify:test   # 发一条测试通知
npm test                 # 单元测试
```

## 控制台

双击 `tools\gc-ui.cmd`（或 `npm run gc:ui`）即可打开，不需要安装任何东西：

- **状态总览**：今日 / 累计点赞、近 14 天趋势、近 48 轮柱状图（失败轮标红）、
  下次运行倒计时、登录凭证剩余寿命、冷却状态；
- **最近点赞**：最近 300 条明细，标题可点回机核原文；
- **实时日志**：SSE 流式推送运行日志，手动任务的输出自动切换展示；
- **一键操作**：试运行 / 立即点赞 / 导入登录态 / 测试通知 / 任务启停 /
  解除风控冷却 / 查看失败截图；
- **设置**：筛选规则、限制与调度、通知开关，分组页签编辑，保存即生效
  （改调度间隔会自动重新注册计划任务）；
- **维护**：备份导出 / 导入（规则 + 设置 + 已处理记录，JSON 文件）。

安全模型：

- 只监听 `127.0.0.1`，拒绝一切非本机访问；
- 每次启动生成一次性 token，并校验 Host / Origin（防 DNS rebinding）；
  token 打开页面后存入 localStorage 并从地址栏清除；
- PushPlus token 只写入 gitignore 的 `config.local.json`，界面永不回显；
- 控制台是按需启动的进程，关掉窗口即停止，不常驻。

## 配置

`config.json` 是主配置；`config.local.json` 存放私密项（已 gitignore），
两者深合并，后者优先。

| 路径 | 说明 |
| --- | --- |
| `browser.headless` | 默认 `true`。设 `false` 会重新引入桌面会话依赖，仅用于排障 |
| `browser.channel` | `chromium`（Playwright 自带内核）/ `msedge` / `chrome` |
| `ui.port` / `ui.openBrowser` | 控制台监听端口 / 启动时是否自动打开浏览器 |
| `schedule.intervalMinutes` | 调度间隔（分钟） |
| `schedule.activeHours` | 活跃时段 `{enabled, start, end}`；支持跨零点（如 `22:00`~`07:00`），时段外的轮次静默跳过 |
| `run.maxRunMs` | 单轮硬超时 |
| `run.screenshotOnError` | 失败时自动整页截图（无头下同样有效） |
| `run.scrollRounds` | 滚动加载轮数，默认 `1`（只处理首屏）；调大可覆盖更多动态，单轮封顶 80 条 |
| `limits.maxLikesPerRun` / `maxLikesPerDay` | 单轮 / 每日点赞上限，`0` 表示不限 |
| `timing.actionDelayMsRange` | 每个点赞动作之间的随机间隔（毫秒） |
| `timing.jitterMsRange` | 每轮开始前的随机等待，避免执行时刻规律 |
| `timing.cooldownAfterBlockMs` | 命中 401/403/429 风控后的冷却时长（控制台可手动解除） |
| `filters.*` | `allow*` 任一命中即通过；`deny*` 一票否决；全部留空 = 所有可见动态都收 |
| `session.sources` | 登录态导入来源列表（浏览器 profile 目录） |
| `notifications.*` | PushPlus 开关与分场景开关（`onLike` / `onFailure` / `onSessionExpired` / `onRunSummary`） |

### PushPlus token

**不要**把 token 写进 `config.json`（会入库）。正确方式：

| 方式 | 说明 |
| --- | --- |
| 控制台（推荐） | 设置 → 通知 → `PushPlus token` 输入框。密码类型输入框，不回显原值，留空 = 保持当前值 |
| 环境变量 | `PUSHPLUS_TOKEN`，优先级最高 |

- token 只落盘到 `config.local.json`（gitignore）；
- 保存普通配置时会强制把 `config.json` 里的 `notifications.pushplusToken`
  写成空串，历史误填也会被自动擦除；
- 读取优先级：`PUSHPLUS_TOKEN` > `config.local.json` > `config.json`。

## 数据文件

| 文件 | 说明 |
| --- | --- |
| `.gcores-auto-like/session.json` | 登录态（纯文本 cookie，注意保密，已 gitignore） |
| `.gcores-auto-like/state.json` | 运行时状态：已处理条目 / 每日计数 / 冷却 / 运行历史（200 轮）/ 点赞明细（300 条） |
| `.gcores-auto-like/worker.log` | 运行日志，超 2MB 自动轮转保留 3 份 |
| `.gcores-auto-like/last-error.png` | 最近一次失败的整页截图 |

## 筛选规则语义

- **允许**项（`allowAuthors` / `allowTopics` / `allowKeywords` / `allowEntryTypes`）
  命中任意一条即通过；全部留空表示"默认全收"；
- **屏蔽**项（`deny*`）一票否决，优先于允许项；
- `onlyUnliked`：跳过已经点过赞的动态（默认开启）；
- `maxAgeHours`：只处理 N 小时内发布的动态，`0` 不限。

## 开发

```powershell
npm test        # 25 条单元测试（规则 / 状态 / 调度窗口 / 配置校验）
```

```
src/cli.js              命令入口（run / doctor / ui / session / task / state / notify）
src/lib/config.js       配置加载、校验与合并
src/lib/session.js      登录态导入 / 导出 / 健康度；浏览器启动参数
src/lib/gcores.js       页面侧 actor（提取、点赞、校验、风控捕获、滚动加载）
src/lib/rules.js        筛选规则引擎
src/lib/runner.js       单轮编排（活跃时段、限流、熔断、超时、通知）
src/lib/store.js        状态持久化（原子写、历史环、点赞留档）与跨进程互斥锁
src/lib/notify.js       PushPlus 通知
src/lib/logger.js       文件日志 + 轮转
src/ui/server.js        控制台服务端（127.0.0.1 + 一次性 token + SSE）
src/ui/index.html       控制台页面（单文件，零依赖）
tools/gc.cmd            命令行入口（自动定位 Node）
tools/gc-ui.cmd         双击打开控制台
tools/*.ps1             计划任务注册 / 卸载 / 查看 / 启停
test/unit.test.js       单元测试
```

## 常见问题

**计划任务没有跑起来？**
先 `npm run gc:doctor` 做整体体检，再看 `npm run gc:task:status`
的任务状态与最近一次返回码，最后翻 `.gcores-auto-like/worker.log`。

**提示登录态失效？**
`npm run gc:session` 查看剩余有效期；重新执行 `npm run gc:session:import`
（需先完全退出对应浏览器），或 `npm run gc:login` 手动登录一次。

**想暂停自动点赞？**
`npm run gc:task:stop`（或控制台的"停止任务"）。任务保留，随时恢复；
触发风控冷却时也可以在控制台手动解除。

**换了电脑 / 项目换了目录？**
计划任务里固化的是绝对路径，搬家后用
`npm run gc:task:install -- --force` 重新注册一次，并重新导入登录态。
