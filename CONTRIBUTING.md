# 参与 Alpha

先阅读 AGENTS.md 和 README.md。问题反馈请包含版本、Windows 版本、复现步骤、预期与实际结果；日志须移除账号、令牌和私人文件内容。

代码改动围绕原生 OMP 扩展与桌面接线，不恢复旧执行编排。提交前运行：

```powershell
bun run check
bun run test
bun run validate:skills
bun run build:desktop-ui
```

说明验证覆盖范围与未测边界。修改 Skill 时保留来源和第三方许可；贡献按项目 Apache-2.0 许可提交。打包的额外依赖见 README.md。
