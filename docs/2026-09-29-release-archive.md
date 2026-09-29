# Alpha Windows 发行归档（2026-09-29）

项目根目录的 `Alpha-Setup-0.1.0-x64.exe` 是本次交付的双击安装入口。相同文件的原始构建产物、`SHA256SUMS.txt` 和 `build.json` 保存在 `release/alpha-installer-2026-09-29T13-25-33-421Z/`；对应可携带版保存在 `release/alpha-portable-2026-09-29T13-23-18-668Z/`。这两个当前版本留在 `release/` 顶层；此前的 69 个便携版和安装包目录移至 `release/archive/`，原文件完整保留，未合并或覆盖。

- 安装包大小：559,876,638 字节
- SHA-256：`EB5B42E85786F3692F3E17F35EBC1AC520865DA7B06D589361C8FDEB5BCDEB9B`
- 源码提交：`c4f3d65`（原生 OMP 启动检查和安装包适配）
- 验证：类型检查、7 项原生测试、可携带版 Office/OMP/UI 探针、安装包内 OMP/UI/Office 探针通过；根目录副本与归档原件的 SHA-256 相同。
- 边界：安装包未在本机执行安装流程；文件未签名，Windows 可能显示 SmartScreen 提示。

OMP 更新只在每次启动时检查一次，发现新版本后提醒用户，不自动安装。
