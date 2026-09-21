# GCORES 动态自动点赞（v0.3 · 无头 / 无 RDP 依赖）

机核动态页自动点赞。**不依赖桌面会话**：浏览器全程无头离屏渲染，进程短生命周期，
由 Windows 计划任务按间隔唤醒 —— RDP 断开、注销、重启都不会让自动化停摆。

---

## 为什么重做

v0.2 是「常驻 daemon + 有头浏览器」，两个设计点直接导致了脆弱：

| 旧方案 | 后果 |
| --- | --- |
| `headless: false` 起真实浏览器窗口 | 必须有**活跃桌面会话**。RDP 一断，会话进入 disconnected，窗口无法合成；Chromium 对不可见/被遮挡页面会节流 `requestAnimationFrame`，页面交互与截图随之卡死 |
| 常驻 daemon + PID 文件 | 进程挂在用户会话下，会话结束/重启即死，且**没有任何东西负责把它拉起来** |
| 单一持久化 profile 目录 | 崩溃后残留 `SingletonLock` 会直接导致下次启动失败 |

`D:\Workspace\gcores-thumbs-up\.gcores-playwright\daemon.log` 是最直接的证据：
69 轮执行**全部退出码 0**（说明逻辑本身没问题），但日志在 `2026/4/13 20:17:20`
「等待下一轮，剩余 1792 秒」之后**戛然而止，没有任何报错** —— 进程被静默回收，
并且再也没起来。

## 新架构

```
Windows 计划任务 (每 30 分钟，IgnoreNew + 20 分钟硬超时)
        │
        └─> node src/cli.js run --quiet        ← 短生命周期，跑完即退
                 │
                 ├─ 读 .gcores-auto-like/session.json（与浏览器解耦的登录态）
                 ├─ 无头 Chromium 打开 /feeds → 提取 → 点赞 → 校验
                 ├─ 写 state.json（原子写：tmp + rename）
                 ├─ 写 worker.log（按大小轮转）
                 └─ PushPlus 通知（可选）
```

关键设计：

- **无头离屏渲染**。页面 `visibilityState === 'visible'` 且 `requestAnimationFrame`
  不节流（实测 60 帧、中位 17.9ms），因此与桌面是否有窗口无关。
- **无常驻进程**。调度权交给 Task Scheduler，单轮崩溃/卡死只影响那一轮，
  下一轮照常；`StartWhenAvailable` 还能补跑关机期间错过的触发。
- **登录态与浏览器解耦**。从任意 Chromium 系 profile 一次性导出成
  `session.json`（纯文本 cookie），运行期不再占用任何 profile 目录，也就没有锁文件问题。
- **多道保险**：`MultipleInstances=IgnoreNew` + 自建 `run.lock` + 单轮 `maxRunMs` 硬超时
  + 连续失败熔断 + 401/403/429 冷却期 + 原子状态写入。

## 安装

```powershell
npm install
npx playwright install chromium     # 已有 ms-playwright 内核则自动复用
```

### 不需要每次都开终端

项目里带了两个双击即用的批处理（`tools\` 目录，纯 ASCII，避免乱码）：

- **`gc-ui.cmd`** —— 双击打开图形控制台（最省事，见下文）；
- **`gc.cmd`** —— 命令行入口，用法 `gc.cmd run` / `gc.cmd doctor` / `gc.cmd ui`。

它们会自动在系统里找可用的 Node.js（`C:\Program Files\nodejs` 等标准位置），
找不到才回退到 `tools\node-path.txt` 里记录的那份，或 `GC_NODE` 环境变量。

> 计划任务也是通过 `cmd.exe → gc.cmd` 这条链跑的，所以它**不绑定某个具体 Node 安装**：
> 升级 Node、卸载装 Node 的工具（比如某个 IDE 自带的运行时）都不会让任务失效。

## 导入登录态

工具**不会**替你输入账号密码，而是复用浏览器里已经存在的登录态。
配置里的来源按顺序尝试（`config.json` → `session.sources`）：

```powershell
npm run gc:session:import                       # 依次尝试所有来源
npm run gc:session:import -- --source "本机 Edge（Default）"
npm run gc:session
```

导入原理：把 `Cookies` / `Local State` / `Local Storage` 等最小文件集拷到临时目录，
用对应内核无头启动一次（**由浏览器自己完成 DPAPI / App-Bound 解密**），
再导出成 `session.json`。之后运行期完全不再碰 profile。

> **注意**：浏览器正在运行时，其 Cookies 库被独占锁住，无法读取。
> 导入 Edge 前需要**完全退出 Edge**（含后台进程）。`gc:doctor` 会提前告诉你哪个来源可用。
> 若「旧版 Playwright profile」等其它来源可用，则无需动 Edge。

万一所有来源都不可用，可以在有桌面会话时手动登录一次：

```powershell
npm run gc:login      # 打开有头窗口，登录完按 Enter，登录态即被固化到 session.json
```

## 日常使用

```powershell
npm run gc:ui         # 图形控制台（推荐）：双击 tools\gc-ui.cmd 或 npm run gc:ui
npm run gc:dry        # 试运行：只做规则匹配，不点赞（推荐先跑这个）
npm run gc:run        # 手动跑一轮
npm run gc:doctor     # 体检：渲染方式 / 登录态 / 来源 / 调度 / 最近一轮
npm run gc:state      # 查看运行时状态
npm run gc:notify:test # 发一条测试通知
npm test              # 单元测试
```

### 图形控制台（可视化）

不装任何东西，**双击 `tools\gc-ui.cmd`** 就会：

1. 启动一个只监听本机 `127.0.0.1:7317` 的小型网页服务；
2. 用默认浏览器打开控制台页面（每次生成一次性 token，只有本机能开）；
3. 页面上可以直接：**试运行 / 立即点赞一轮 / 重新导入登录态 / 测试通知 / 注册计划任务**，
   还能**改筛选规则、限速、调度间隔**（保存即生效），实时看状态与日志。

关掉那个黑色命令行窗口（或关掉页面）服务就停，**不留常驻进程**。
想改端口就改 `config.json` 里的 `ui.port`。

> 控制台只是"遥控器"，底层跑的还是同一个 `src/cli.js`；它自己**不常驻**，
> 所以不增加任何后台占用。

## 接入计划任务（核心步骤）

```powershell
npm run gc:task:install                 # 注册，默认每 30 分钟
npm run gc:task:install -- --interval-minutes 15
npm run gc:task:install -- --project-root D:\Workspace\gcores-thumbs-up
npm run gc:task:status                  # 查看任务状态 + 最近日志
npm run gc:task:stop                    # 停止（禁用）任务，不再自动运行；任务保留
npm run gc:task:start                   # 重新启用任务，恢复每 30 分钟自动跑
npm run gc:task:remove                  # 删除任务（彻底移除，重新跑需再次 install）
```

> **停止 ≠ 删除**：`gc:task:stop` 只是把任务禁用（并终止正在跑的那一轮），
> 任务本身还在，随时 `gc:task:start` 恢复；`gc:task:remove` 才是彻底移除。
> 控制台的开关、命令行窗口的打开与关闭都**不会**影响任务状态——只有上面这几条
> 命令（或控制台里的对应按钮）才会改变任务是跑还是停。

> 计划任务里固化的是**绝对路径**，所以别在临时目录里注册。
> 项目搬家后记得用 `--project-root` 重新注册一次。

注册出来的任务：

- 触发方式：wall-clock 重复触发，每 N 分钟一次；
- `MultipleInstances = IgnoreNew`：上一轮没跑完就跳过本次触发；
- `ExecutionTimeLimit = 20 分钟`：由操作系统兜底杀超时进程；
- `StartWhenAvailable`：关机错过的触发，开机后补跑。

### 执行时刻的随机浮动（反规律）

Windows 计划任务的触发间隔**做不到随机**（repetition trigger 只有固定的
`Interval`），所以抖动在 worker 进程内部实现：

- **位置**：`src/lib/runner.js` 的 `runRound()`，在冷却/每日上限检查之后、
  启动浏览器之前；
- **范围**：由 `timing.jitterMsRange` 控制，默认 `[0, 120000]`，即每轮随机
  睡 0～120 秒；
- **随机方式**：`Math.random()` 均匀分布，`min + floor(random × (max − min + 1))`；
- **效果**：计划任务仍每 30 分钟触发，但真正打开网页的时刻在
  `[触发时刻, 触发时刻+2分钟]` 之间随机，不再整点卡点；
- 抖动不计入 `lastRun.durationMs`（那是纯工作时间），日志会单独打印
  `随机抖动 N 秒后开始本轮`。

想调整就把 `config.json` 的 `timing.jitterMsRange` 改成你要的毫秒区间，
比如 `[0, 300000]` 是 0～5 分钟。设 `[0, 0]` 则完全关闭抖动。

### 关于「无需登录也能跑」

默认使用 **Interactive** 身份 —— 只要当前账号有会话（RDP 连接或断开都算）就能运行，
**不需要管理员权限**，这已经覆盖了「RDP 断开导致失败」这个原始痛点。

如果你要求机器**完全无人登录**时也照跑，需要 S4U 身份：

```powershell
npm run gc:task:install -- --s4u --force      # 必须在管理员 PowerShell 里执行
```

非管理员执行会返回「拒绝访问」（本机已实测），脚本此时会给出明确提示，
并且**不会破坏原有任务**。

## 配置

`config.json` 是主配置，`config.local.json` 用于放私密项（已 gitignore），
两者深合并，后者优先。常用项：

| 路径 | 说明 |
| --- | --- |
| `browser.headless` | 默认 `true`。设 `false` 会重新引入桌面依赖，仅用于本机排障 |
| `browser.channel` | `chromium`（自带内核）/ `msedge` / `chrome` |
| `ui.port` / `ui.openBrowser` | 控制台监听端口 / 启动时是否自动开浏览器 |
| `schedule.intervalMinutes` | 调度间隔 |
| `run.maxRunMs` | 单轮硬超时 |
| `run.screenshotOnError` | 失败时截图（无头下同样有效） |
| `limits.maxLikesPerRun` / `maxLikesPerDay` | `0` 表示不限 |
| `timing.actionDelayMsRange` | 每个点赞动作之间的随机抖动 |
| `timing.jitterMsRange` | 每轮开始前的随机等待（避免执行时刻过于规律） |
| `timing.cooldownAfterBlockMs` | 命中 401/403/429 后的冷却时长 |
| `filters.*` | `allow*` 任一命中即通过；`deny*` 一票否决；留空表示全收 |
| `notifications.*` | PushPlus 开关与分场景开关（`onLike` / `onFailure` / `onSessionExpired` / `onRunSummary`） |

v0.2 的平铺配置（`headless` / `storage.*` / `daemon.*`）会自动迁移，无需手工改。

## 数据文件

| 文件 | 说明 |
| --- | --- |
| `.gcores-auto-like/session.json` | 登录态（纯文本 cookie，注意保密） |
| `.gcores-auto-like/state.json` | 已处理条目 / 每日计数 / 冷却 / 会话健康度 |
| `.gcores-auto-like/worker.log` | 运行日志，超 2MB 自动轮转保留 3 份 |
| `.gcores-auto-like/last-error.png` | 最近一次失败的整页截图 |

## 代码结构

```
src/cli.js              命令入口（run / doctor / ui / session / task / state / notify）
src/lib/config.js       配置加载、校验、v0.2 → v0.3 迁移
src/lib/session.js      登录态导入 / 导出 / 健康度；浏览器启动参数
src/lib/gcores.js       页面侧 actor（提取、点赞、校验、风控捕获）
src/lib/rules.js        筛选规则
src/lib/runner.js       单轮编排（限流、熔断、超时、通知）
src/lib/store.js        状态持久化（原子写）与跨进程互斥锁
src/lib/notify.js       PushPlus 通知
src/lib/logger.js       文件日志 + 轮转
src/ui/server.js        控制台服务端（只监听 127.0.0.1，一次性 token）
src/ui/index.html       控制台页面（单文件，零依赖）
tools/gc.cmd            双击/命令行入口（自动定位 Node）
tools/gc-ui.cmd         双击打开控制台
tools/*.ps1             计划任务注册 / 卸载 / 查看 / 启停
test/unit.test.js       单元测试
```

> `scripts/` 与 `gcores-feeds-auto-like.user.js` 是 v0.2 的实现与更早的
> Tampermonkey 脚本，**均已停用，仅保留参考**，`package.json` 不再引用它们。
