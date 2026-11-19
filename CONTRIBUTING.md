# 贡献指南

欢迎为 TL;DR Crawler 提 Issue 和 Pull Request。

## 提 Issue

描述清楚：在哪个页面、做了什么操作、期望什么、实际发生了什么。如果是渲染相关问题，附上截图会很有帮助。面板 header 右上角的版本号请一并提供，方便判断是不是加载了旧版。

## 提 PR

1. Fork 仓库，从 `main` 开一个分支。
2. 直接修改源码即可——项目是纯 JS、无构建步骤、无第三方依赖，请勿引入 npm 包或打包器。
3. 改完在 `chrome://extensions` 刷新扩展，在真实 Chrome 里端到端验证一遍（面板 header 会显示版本号，确认加载的是你的改动）。
4. 保持代码风格与现有文件一致；视觉改动请遵循既有规范：面板 chrome 一律中性灰，颜色只出现在蛛网图谱内部。
5. 提交 PR，说明改了什么、为什么改、怎么验证的。

## 本地自检

提交前在仓库根目录跑一次：

```bash
node .github/scripts/check.mjs
```

它会校验：`manifest.json` 结构与引用文件是否存在、两份 README 的版本徽章与 `manifest.json` 是否一致、`CHANGELOG.md` 是否有当前版本小节、JS 源码能否通过语法编译。CI 跑的是同一个脚本，所以本地通过基本就等于 CI 通过。

## 发布新版本

1. 改 `manifest.json` 的 `version`。
2. 同步两份 README 的版本徽章，并在 `CHANGELOG.md` 顶部新增 `## [x.y.z] - YYYY-MM-DD` 小节——上面三处对不上，CI 会直接失败。
3. 跑一次 `node .github/scripts/check.mjs` 确认全绿。
4. 打 tag 并推送：`git tag vX.Y.Z && git push origin vX.Y.Z`。
5. 在 GitHub Releases 用该 tag 建 release，附上一个 `tldr-crawler-vX.Y.Z.zip`（扩展根目录的干净打包，不要带 `.git`、演示文件、截图）。

## 行为准则

友善交流，就事论事。
