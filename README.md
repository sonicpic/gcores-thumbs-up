# gcores-thumbs-up

机核（GCORES）动态自动点赞工具集。

仓库里有一套**正在使用**的实现，和一份**保留参考**的浏览器端脚本。

## 当前实现：`headless-worker/`

无人值守方案：无头 Chromium + 短生命周期进程，由 Windows 计划任务按间隔唤醒一轮，
另配一个只监听本机的控制台页面。RDP 断开、注销、重启都不会让它停摆。

```powershell
cd headless-worker
npm install
npm run gc:task:install    # 注册计划任务（默认 30 分钟一轮）
npm run gc:ui              # 打开本地控制台
npm run gc:doctor          # 环境与登录态体检
```

完整的配置项、筛选规则、启停方式见 **[headless-worker/README.md](headless-worker/README.md)**。

常用启停：

```powershell
npm run gc:task:stop       # 停止（禁用）自动运行，任务保留
npm run gc:task:start      # 恢复自动运行
npm run gc:task:status     # 查看任务状态与最近日志
```

## 保留参考：`gcores-feeds-auto-like.user.js`

Tampermonkey 油猴脚本（v0.4.0）。**浏览器端**使用：打开机核动态页时脚本自带
可视化配置面板、点赞历史、随机限速与刷新倒计时。

它和 `headless-worker/` 是两种不同的使用方式（前者要开着浏览器，后者无人值守），
并不冲突，因此保留。用不用随你。

## 已移除

v0.2 的 Node 常驻守护进程方案（`scripts/gcores-playwright.js` +
`scripts/gcores-daemon.js` + `scripts/lib/app-config.js`）已被上面的无头方案取代，
连同它专用的根目录 `config.json` / `package.json` 一并删除。
如需回看，可见提交历史。
