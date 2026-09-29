# Alpha Windows 发行归档（2026-09-29）

## 当前版本：0.2.0（2026-09-30 重构发版）

根目录入口为 `Alpha-Setup-0.2.0-x64.exe`。原始安装包位于 `release/alpha-installer-2026-09-29T22-47-26-380Z/`，便携包位于 `release/alpha-portable-2026-09-29T22-37-26-834Z/`。0.1.1 的两个发行目录、当日一次被 0.2.0 取代的中间便携包（`alpha-portable-2026-09-29T22-22-54-674Z`，内容为浏览器授权修复前的构建）以及旧根目录 EXE 均移入 `release/archive/`（EXE 在 `release/archive/root-launchers/`），原文件完整保留。

- 安装包大小：560,000,882 字节。
- SHA-256：`FDC5C3019AA97818BB2123A473326F60CB76CCFFCAB0EE13C4394F077AF23A55`。根目录副本与原始构建文件哈希一致。
- 内容：原生 sidecar + OMP 18.4.3 + 30 个 Alpha Skill（`presets/alpha-plugin`）+ 天枢证据层 + `alpha_office`/媒体能力 + 浏览器宿主 + 纸墨桌面（0.2.0 架构见 [原生 OMP 重构](2026-09-29-omp-native-refactor.md)）。
- 验证：`bun run check`；`bun run test` 62 项原生测试（含 native-launch、native-imports、native-capabilities、native-tianshu、native-browser-consent、native-comfy-client）；`bun run validate:skills` 30 个 Skill；便携包探针（UI 哈希、OMP RPC、Office 链）与安装包内探针通过；真实模型端到端冒烟（身份/合规 Skill 阅读、alpha_office 产出、浏览器会话级授权与页面打开）。
- 边界：安装器未签名（SmartScreen 可能提示）；新安装器的完整安装流程本轮未在本机重新执行（与 0.1.1 相同口径）；ComfyUI 生成需用户自备服务，不在离线探针内。

## 0.1.1（22:24 更新，历史）

根目录入口为 `Alpha-Setup-0.1.1-x64.exe`（现已移入 `release/archive/root-launchers/`）。原始安装包位于 `release/archive/alpha-installer-2026-09-29T14-17-35-648Z/`，便携包位于 `release/archive/alpha-portable-2026-09-29T14-14-35-861Z/`。

- 安装包大小：559,886,267 字节。
- SHA-256：`0335910FF4391C5272308E44F229FA822846EA10B212D185CA1AF576CB2EA597`。
- 根目录副本与原始构建文件哈希一致；类型检查、9 项原生测试、便携包和安装包的 UI/OMP/Office 探针通过。
- 已安装程序经过文件备份和增量更新，桌面启动与欢迎页/设置入口探针通过；新安装器完整安装流程本轮未重新执行。文件仍未签名。
- 本次恢复的欢迎页与可视化设置详见 [桌面界面恢复](2026-09-29-desktop-ui-restoration.md)。

## 0.1.0 交付时记录（历史）

项目根目录的 `Alpha-Setup-0.1.0-x64.exe` 是本次交付的双击安装入口。相同文件的原始构建产物、`SHA256SUMS.txt` 和 `build.json` 保存在 `release/alpha-installer-2026-09-29T13-25-33-421Z/`；对应可携带版保存在 `release/alpha-portable-2026-09-29T13-23-18-668Z/`。这两个当前版本留在 `release/` 顶层；此前的 69 个便携版和安装包目录移至 `release/archive/`，原文件完整保留，未合并或覆盖。

- 安装包大小：559,876,638 字节
- SHA-256：`EB5B42E85786F3692F3E17F35EBC1AC520865DA7B06D589361C8FDEB5BCDEB9B`
- 源码提交：`c4f3d65`（原生 OMP 启动检查和安装包适配）
- 验证：类型检查、7 项原生测试、可携带版 Office/OMP/UI 探针、安装包内 OMP/UI/Office 探针通过；根目录副本与归档原件的 SHA-256 相同。
- 边界：安装包未在本机执行安装流程；文件未签名，Windows 可能显示 SmartScreen 提示。

OMP 更新只在每次启动时检查一次，发现新版本后提醒用户，不自动安装。
