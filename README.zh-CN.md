# WebChat for DeepSeek Harness

**WebChat** 是一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的独立社区聊天插件：以 DeepSeek 官方 [chat-demo](https://github.com/deepseek-ai/chat-demo)（固定上游提交 `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`，v0.1.1）为界面蓝本，在 DSH 的插件体系内真实运行。

> **WebChat 是基于 DeepSeek Harness 开发的独立社区项目，并非 DeepSeek 官方产品。**
> **WebChat is an independent community project for DeepSeek Harness. It is not an official DeepSeek product.**

```
用户输入 → DSH Host → DeepSeek Rich API → SSE → 结构化回复 → DSH Session 持久化 → UI 恢复
```

## 它解决什么问题

DeepSeek 官方适配器（`dsh-llm-deepseek`）对 Rich 专属块（思考签名、搜索步骤、网页读取、引用、拒绝回复）按协议是"熔断"处理——Rich 内容无法经由 DSH 通用 LLM 通路完整呈现。WebChat 为这些块实现了专用直连通路与完整 UI，同时把历史与设置全部交给 DSH 官方持久化层：DSH 是唯一权威数据源，WebChat 页面自身零本地持久化。

## 核心功能

- **DeepSeek Demo 风格聊天**：新建/多轮对话、流式生成、停止、编辑重发、重新生成、回复分支。
- **思考与搜索**：深度思考块（含签名校验链）、联网搜索步骤、网页读取结果、引用关联——全部结构化渲染。
- **DSH 模型目录**：读取 DSH 模型列表、Provider 分组、模型白名单、收藏、思考等级、默认模型。
- **文件与附件**：聊天附件（云端 Files API 解析或按模型能力直发）；本地目录授权 + 只读检索（TXT/Markdown/CSV/DOCX/XLSX/PPTX 正文与 PDF/图片文件名）。
- **提示词模板**：全局提示词、模板变量、草稿插入。
- **上下文与费用**：接入 `dsh-context` / `dsh-cost-meter`（可选插件）显示上下文占用与用量。
- **插件权限**：显示 DSH 运行中的 Bundle/组件；只读本地能力显式授权。
- **会话导入导出**：兼容官方 Demo v3、DeepChat v3、WebChat ZIP；单会话导出 Markdown/JSON/ZIP，批量 ZIP 勾选导入，导入预览与去重。
- **多种 UI 风格**：WebChat 默认 / GPT / Gemini / Claude 四种风格，浅色/深色/跟随 DSH，窗口内磨砂、字号与阅读宽度。
- **Agent Side Chat**（桌面端）：在 DSH Agent 工作分支旁开旁聊，检查点同步、父会话关联。

## 支持平台

| 平台 | 状态 |
| --- | --- |
| Linux DSH Web（DSH 0.2.2-rc.3，Node 22） | ✅ 本轮完整实测（安装、真实模型聊天、持久化、重启恢复、卸载重装） |
| Windows Desktop（DSH 桌面版 44.7.0，内嵌 runtime 0.2.2-rc.5，Node 24） | ✅ R8.2 轮完整实测（125 项 Host 单测 + 原生 UI 回归） |
| 其它 DSH 版本 / macOS | ⚠️ 未实测。peer 兼容区间声明为 `>=0.2.2-rc.3 <0.2.3-0`，不保证更高大版本 |

## 安装

前提：已安装 DeepSeek Harness 并能启动 `dsh` 命令行。

### 方式一：npm 包（推荐）

```bash
# 在目标 Profile 安装(例如默认 web Profile)
dsh plugin --profile web add dsh-webdemo-chatds@next
# 稳定标签发布后去掉 @next
```

如你的 DSH 版本与 peer 区间不符，安装会被版本门禁拒绝——这是 DSH 的保护机制；请按提示升级插件版本。

### 方式二：GitHub Release

从 [Releases](../../releases) 下载 `dsh-webdemo-chatds-<版本>.tgz`：

```bash
dsh plugin --profile web add ./dsh-webdemo-chatds-0.9.0-rc.8.tgz
```

### 方式三：从源码构建

```bash
git clone <本仓库>
cd <仓库目录>
pnpm install            # Node >= 22,Corepack 提供 pnpm
pnpm --filter @dsh-chat/shared run build     # 先构建协议核心(client 类型检查依赖其产物)
pnpm -r run typecheck   # 全部包类型检查
pnpm -r run test        # shared 21 + main 126 + sidecar 3 项测试
pnpm --filter dsh-webdemo-chatds run build   # host bundle + client 页面
cd packages/chat-main && pnpm pack --pack-destination ../../dist-packages
dsh plugin --profile web add ../../dist-packages/dsh-webdemo-chatds-<版本>.tgz
```

安装后**重启 DSH Web 服务**（或在 DSH 插件管理器中启用组件），侧栏出现「WebChat Web」入口。

## 快速上手

1. 打开侧栏「WebChat Web」进入聊天面板。
2. 底部模型菜单选择模型（列表来自 DSH 模型目录）。
3. 需要深度思考/联网搜索时，在输入区开启对应开关（仅 DeepSeek 官方模型支持）。
4. 本地文件检索：DSH 设置 → ChatDS 设置 → 文件，授权目录后开启「本地检索」。

## 认证与计费

WebChat 复用 DSH 的正式凭证体系，按优先级：

1. DeepSeek **API Key**（DSH Models 页或 `$DSH_HOME/.credentials.yaml` 中的 `DEEPSEEK_API_KEY`）；
2. DSH **已登录的 DeepSeek 账号 token**（官方 account 服务按目的地放行）。

WebChat 不会让 DeepSeek API 变成免费服务：模型请求、联网搜索、文件解析与第三方模型服务可能产生费用。Rich 通路的用量由模型服务如实返回并在消息内标注；它是否进入 `dsh-cost-meter` 统一账本取决于该插件对 Rich 通路的覆盖（见已知限制）。

## 权限与安全

- **本地目录授权**：只读；授权经 Host 校验（绝对路径、realpath、存在且可读），软链接逃逸与路径穿越在引擎层拒绝（有专项测试覆盖）。
- **无目录选择器的环境**（如无图形界面的 Linux 服务器）：设置页提供手动输入绝对路径的授权通道，Host 端做同等校验。
- **凭证**：浏览器永不接触 key/token；Rich 请求由 Host 每次实时解析凭证。
- **会话数据**：全部存于 DSH 官方 Session 存储（`$DSH_HOME/sessions`），WebChat 不另建副本。

## 可选依赖

| 插件 | 作用 | 未安装时 |
| --- | --- | --- |
| `dsh-cost-meter` | 费用/用量展示 | 费用区提示未连接，主聊天不受影响 |
| `dsh-context` | 上下文占用展示 | 同上 |

## 已知限制（如实）

- **真实联网搜索**：协议与 UI 已实现；真实搜索计费需用户自行确认预算（本轮未做真实搜索验收）。
- **语音**：录音转写依赖 DeepSeek ASR 接口与凭证；桌面端本地朗读仅支持 Windows 语音。
- **Agent 工作分支目录选择**：仅 DSH Desktop（`dsh-app:` 协议）提供原生选择器；Linux Web 下创建带工作目录的原生分支会明确提示不可用。
- **Rich 用量账本**：Rich 通路用量如实标注但未经 `dsh-cost-meter` 计入统一账本（等待上游支持）。
- **Linux 目录选择器**：无 portal 的服务器上 DSH 官方目录选择服务可能不可用——请使用手动路径授权。
- 中文文件名附件落盘时按白名单转写为安全文件名（内容不受影响）。

## 开源协议与致谢

- 本项目代码以 [MIT](LICENSE) 发布。
- 客户端界面与协议核心大规模改编自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT，Copyright (c) 2026 DeepSeek）——完整的衍生范围声明见 [NOTICE](packages/chat-main/NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 运行于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）。
- 本项目不使用 DeepSeek 品牌资产；随附图标为本项目原创。
