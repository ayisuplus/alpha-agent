# 真实模型菜单与 MiniMax 环境凭据清理

本记录接续 `2026-10-01-native-model-configuration.md` 的历史预览阻塞。本轮没有修改产品源码、Skill 或依赖，使用现有 OMP 模型目录与桌面设置接口完成运行时验证。

## 模型菜单

原用户预览读取隔离验收目录，仅显示两个 `ui-fixture` 模型。另一个读取真实配置的旧后端与当前界面不匹配，界面出现 HTTP 404，未作为交付实例。

本轮使用当前源码启动新预览。Alpha 数据保存在独立目录 `artifacts/native-model-menu-2026-10-01/workspace`，原生 OMP 配置读取 `C:\Users\36322\.omp\agent`；旧预览进程及其数据保留。

- 内置浏览器模型菜单显示 64 个实际可用模型，没有验收用的虚构模型。
- 四个已配置服务商的可用模型数：Alibaba 12、DeepSeek 4、OpenCode Go 41、Xiaomi 7，总计 64。
- 验证服务商搜索；首页选择 DeepSeek-V4-Pro 后刷新，选择保持，随后恢复 MiMo-V2.6-Pro。只修改新预览的首页选择，没有发送模型请求。
- 设置页正确显示 MiMo-V2.6-Pro；原生默认角色仍为 `opencode-go/mimo-v2.6-pro:high`。
- 当前源码界面和后端配套，未再出现上述 HTTP 404。

## MiniMax 凭据

按用户明确要求清理 `MINIMAX_API_KEY`。清理前该变量只存在于继承的进程环境；Windows 用户和系统环境变量没有保存值，检查过的 OMP、Codex、项目环境文件及 PowerShell 配置文件没有该变量定义。原生 MiniMax 服务商没有已存 API Key 或 OAuth 凭据。

停止本轮新启动且无会话、无定时任务、无子进程的预览，在启动环境中删除 `MINIMAX_API_KEY` 后用同一 Alpha 数据目录重新启动。另对 Windows 用户环境执行该变量的删除，并核对用户及系统环境均无值。

- 原生目录中 `minimax`、`minimax-cn`、`minimax-code`、`minimax-code-cn` 的凭据来源均为 null；无已存 API Key、无 OAuth、可用模型数为 0。
- 内置浏览器设置页的 MiniMax 环境凭据提示消失，其余四个服务商和 64 个可用模型保留。
- 没有显示或记录凭据值，没有向 MiniMax 发送请求，也没有执行服务商侧的远程密钥撤销。
- 其他已经运行的程序仍可能保留继承的环境副本，需要重启才能清除。本轮未终止无关进程。

## 证据与验证边界

脱敏证据保存在主工作区 `artifacts/native-model-menu-2026-10-01/`：

- `catalog-without-minimax.json`：原生目录、默认角色、服务商数量及 MiniMax 凭据状态。
- `minimax-removal.json`：Windows 环境变量存在性及 Alpha 清理结果。
- `menu-models.json`：实际菜单的 64 个模型条目。
- `providers-without-minimax.png`：清理后设置页及四个已配置服务商。

当前预览启动信息为 `startup-without-minimax.json`。启动信息及服务日志包含本地访问令牌，仅保存在本机，不提交 Git。

本轮启动源码为 `faa17f8`，模型显示修复为 `1464e3b`。源码未发生变化，沿用上一轮在同一源码上的 `bun run check`、`bun run test`（138 通过、0 失败、977 断言、30 文件）及 `bun run build:desktop-ui` 通过记录；本轮新增的是实际原生目录和内置浏览器运行时验证。未重新打包，也未把目录可用状态等同于远端模型调用验收。
