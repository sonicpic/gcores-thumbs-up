# 项目长期记忆：gcores-thumbs-up（机核动态自动点赞）

## 当前形态（v0.3.1，2026-09-21 起）
- **正式位置：`D:\Workspace\gcores-thumbs-up\headless-worker\`**（嵌在原 git 仓库里的子目录，
  自带嵌套 .gitignore 保护 config.local.json / .gcores-auto-like/ 密钥）。
  旧 worktree `C:\Users\zhihongpan\WorkBuddy\Worktrees\gcores-thumbs-up\main-1cbac61b` 已不再被引用。
- 入口：`node src/cli.js <run|doctor|ui|session|task|state|notify>`；核心在 `src/lib/*`。
- 运行方式：**无头 Chromium + 短生命周期进程**，由 Windows 计划任务 `GcoresAutoLike`
  每 30 分钟唤醒一次（Interactive 身份，非管理员即可注册）。
- **计划任务走 `cmd.exe → tools/gc.cmd`**，运行期动态解析 Node（优先系统 Node，
  回退 `tools/node-path.txt` / `GC_NODE`），不绑定具体 Node 安装。
- 登录态：`.gcores-auto-like/session.json`（storageState），由 `gc:session:import`
  从浏览器 profile 一次性导入；**运行期不占用任何 profile 目录**。
- 可视化：`tools/gc-ui.cmd` 双击开本地控制台（`src/ui/*`，只监听 127.0.0.1 + 一次性 token）。
  UI 可启停计划任务；**改调度间隔会自动同步重新注册计划任务**（applyIntervalToTask）。
- 通知：PushPlus，token 在 `config.local.json`（gitignored）。
- `scripts/` 与 `gcores-feeds-auto-like.user.js` 是停用的 v0.2 遗留实现，仅存在父目录，未迁入子目录。

## 不可动摇的设计约束（改代码前先读）
1. **不要改回 `headless:false`。** 项目存在的唯一原因就是脱离桌面会话依赖；
   headful 在 RDP 断开时会因合成器停摆 / rAF 节流而失败。
2. **不要重新引入常驻 daemon。** 调度权归 Task Scheduler；常驻进程是上一版的单点故障。
   单轮所有状态都落盘（`state.json` 原子写），进程随时可被杀。
3. **不要用 `schtasks.exe`**：本机程序黑名单会拦截，只能用 PowerShell `ScheduledTasks` 模块。
4. `.ps1` 脚本保持纯 ASCII；读 UTF-8 文件必须带 `-Encoding UTF8`（PS 5.1 默认 ANSI）。

## 仓库状态（2026-09-21 整理后，已推送 GitHub）
- 远端：`https://github.com/sonicpic/gcores-thumbs-up`（公开仓库，默认分支 main）。
- 仓库里只有 **两套** 东西：
  1. `headless-worker/` —— 唯一在用的实现（无头 + 计划任务 + 控制台）。
  2. `gcores-feeds-auto-like.user.js` —— 油猴脚本 v0.4.0，**浏览器端**工具，
     与无人值守的 worker 是使用模式互补，刻意保留。
- **v0.2 的 `scripts/`（playwright + daemon + app-config）已删除**，连同根 `config.json` /
  `package.json` / `package-lock.json`（同代专属产物）。根 README 已重写为索引页。
- 脱敏约定（推公开仓库必守）：PushPlus token 只写在 `config.local.json`（两处均 gitignore）；
  登录后数据 `.gcores-auto-like/`、`.gcores-playwright/` 一律不入库。
- **别删 `.gcores-playwright/profile/`**：`headless-worker/config.json` 的
  `session.sources[0].profileDir` 指向它，是登录态重新导入的来源。

## 常用操作
```powershell
npm run gc:ui               # 图形控制台（可视化，双击 tools\gc-ui.cmd 也行）
npm run gc:doctor           # 任何异常先跑这个
npm run gc:dry              # 改筛选规则后先试运行
npm run gc:session:import   # 登录态失效时重新导入（需先退出对应浏览器）
npm run gc:task:status      # 任务状态 + 最近日志
npm run gc:task:stop        # 停止（禁用）任务；任务保留，可随时 gc:task:start 恢复
npm run gc:task:start       # 启用任务（恢复自动运行）
npm test
```

## 已知边界
- 只处理**当前页**已渲染出的动态（沿用 v0.2 语义，不做翻页）。
- 导入 Edge 的登录态必须**完全退出 Edge**（Cookies 库被独占锁）。
  若旧 Playwright profile 仍可用，则无需动 Edge。
- `--s4u`（无人登录也运行）需要管理员权限。
- 判断登录寿命要看 `appToken`/`userID`，忽略 `acw_tc`/`sensorable`/`wechatTicket` 等短命 cookie。
