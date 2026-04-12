# GCORES 动态自动点赞

基于 Playwright 的机核动态页自动点赞脚本。

## 安装

```powershell
npm install
npx playwright install chromium
```

## 使用

首次登录：

```powershell
npm run gcores:login
```

执行一轮：

```powershell
npm run gcores:run
```

后台定时执行：

```powershell
npm run gcores:daemon
npm run gcores:daemon:status
npm run gcores:daemon:stop
```

自定义参数：

```powershell
npm run gcores:daemon -- --interval-minutes 15
npm run gcores:daemon -- --interval-minutes 15 --pushplus off
```

## 默认行为

- 只处理当前页已渲染出的动态
- `daemon.intervalMinutes = 30`
- `maxLikesPerRun = 0`
- `maxLikesPerDay = 0`
- `maxAgeHours = 0`
- `allowEntryTypes = []`
- `onlyUnliked = true`
- `notifications.enabled = true`

## 通知

如果配置了 `notifications.pushplusToken`，每次真实点赞尝试的结果都会通过 PushPlus 推送。

## 说明

- 本地数据保存在 `.gcores-playwright/`
- `gcores-feeds-auto-like.user.js` 为旧版 Tampermonkey 脚本，仅保留参考
