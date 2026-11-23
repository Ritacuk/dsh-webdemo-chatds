# WebChat for DeepSeek Harness

**把 DeepSeek 风格的日常聊天，带进 DeepSeek Harness。**

[English](https://github.com/Ritacuk/dsh-webdemo-chatds/blob/main/README.md) · [GitHub](https://github.com/Ritacuk/dsh-webdemo-chatds) · [下载与更新](https://github.com/Ritacuk/dsh-webdemo-chatds/releases/latest) · [问题反馈](https://github.com/Ritacuk/dsh-webdemo-chatds/issues) · [更新日志](https://github.com/Ritacuk/dsh-webdemo-chatds/blob/main/CHANGELOG.md)

> WebChat 是一个运行在 **DeepSeek Harness（DSH）** 中的独立社区聊天插件。它以 DeepSeek 官方开源的 [chat-demo](https://github.com/deepseek-ai/chat-demo) 为基础，保留熟悉的聊天体验，再按需接入 DSH 的模型、文件、插件与 Agent 能力。
>
> **这是社区项目，不是 DeepSeek 官方产品，也不是将 `chat.deepseek.com` 网页直接嵌入 DSH。**

## 为什么做 WebChat？

DSH 擅长使用工具、处理文件和执行复杂任务，但很多时候，我们只想问一个简单问题、推导一道公式、翻译一段文字，或者上传一份讲义接着聊天。

对于这些事情，每次都启动完整 Agent、携带大量工具定义和工作上下文，往往没有必要：**可能更慢，消耗更多 Token，也让纯聊天变得复杂。**

WebChat 希望解决的正是这个问题：

- **平常像 DeepSeek 网页版一样聊天。** 打开就能问，不需要先建立代码工作区或启动 Agent。
- **简单问题尽量简单处理。** 默认不向模型开放额外工具；思考、联网搜索、本地检索按需开启。
- **需要能力时再用 DSH。** 选择 DSH 已配置的模型，读取自己上传的文件，授权只读目录，或从聊天创建正式 Agent 工作分支。
- **聊天记录可靠保存。** 历史交给 DSH 的会话系统管理，而不是只保存在浏览器的临时数据库里。

一句话：**默认是聊天，需要时才使用工具。**

WebChat 的目标是减少不必要的开销，而不是承诺某个固定的 Token 节省比例。实际费用仍取决于模型、上下文、缓存、思考和工具使用情况。

## 可以做什么？

### 1. 熟悉的 DeepSeek 聊天体验

- 多轮聊天、流式回复、停止生成、编辑与重新生成。
- 深度思考、兼容模型的联网搜索、网页来源及引用展示。
- Markdown、代码块、表格、数学公式（KaTeX）及 Mermaid 图表渲染；支持复制公式的 LaTeX 源码。
- 会话重命名、置顶、搜索、归档、回复版本切换与历史恢复。
- 会话导入导出：支持当前实现可识别的官方 Demo、DeepChat v3 和 WebChat 归档；可导出 Markdown、JSON 或 ZIP，导入前可预览和去重。

**说明：** 本项目基于官方 *开源 chat-demo*，并不意味着拥有 DeepSeek 官网所有未公开的服务端能力；搜索和特殊响应由实际选用的模型及接口决定。

### 2. 使用 DSH 里的模型，但不强制运行 Agent

WebChat 直接读取 DSH 的模型目录，不需要再维护第二套模型 API Key。你可以：

- 选择当前 DSH 已配置的模型，设置默认模型、收藏及白名单。
- 调整模型支持的思考等级。
- 在 **Chat** 和 **Plan（只读）** 之间切换。
- 在需要实际执行任务时，从聊天创建 **DSH 原生 Agent 工作分支**，选择已注册的 DSH 工作区。

| 工作方式 | 适合做什么 | 主要区别 |
| --- | --- | --- |
| **Chat** | 普通问答、学习、翻译、解释、阅读上传的资料 | 默认不调用额外的模型工具 |
| **Plan（只读）** | 在明确授权的范围内分步检索、阅读、分析 | 可以使用有限的只读能力，不执行写入任务 |
| **Agent 工作分支** | 编程、修改文件、运行命令、完成复杂任务 | 交给 DSH 原生 Agent，继续遵守工作区、沙箱和审批规则 |

思考、联网搜索、文件上传和语音并不等同于工作模式；它们是各自独立的能力。

### 3. 文件：上传即聊，本地检索需授权

- **上传附件：** 选择、粘贴或拖入文件，按格式与模型能力进行文本提取或服务端解析。
- **Office 文档：** 可提取 DOCX、XLSX、PPTX 中可解析的文本内容；不等于完整理解版式、嵌入图片或公式对象。
- **本地检索：** 只搜索用户明确授权的目录；支持常见文本和 Office 文档的正文检索。PDF、图片在本地检索中不应被理解为默认具备完整 OCR——其本地文件名发现与附件云端处理是不同功能。
- **撤销权限：** 撤销目录授权后，后续检索不得继续访问该目录。

> **文件在哪里很重要。** 如果通过另一台电脑的浏览器访问 Linux DSH，授权目录指的是 **Linux DSH 主机上的文件夹**；浏览器电脑上的文件请使用附件上传。

### 4. 用 DSH 的能力，而不是重造一套 DSH

- **插件与工具：** 查看可用的插件、组件和能力；额外模型工具默认不授权，允许使用哪些只读能力由用户决定。
- **上下文与费用：** 可接入 `dsh-context` 和 `dsh-cost-meter`。聊天底部的状态条按 DSH 原生底栏风格显示轮数、Token（tok）、缓存命中、本会话金额与合并预算，点击对应分段直接打开 dsh-context 面板或 dsh-cost-meter 费用页；Rich 轮的金额由 dsh-cost-meter 价表与峰谷规则计算。
- **提示词：** 全局附加提示词、模板库、变量替换和草稿插入。
- **Agent Side Chat：** 在 DSH Agent 任务的右侧进行独立旁聊，按已提交检查点继承相关上下文；不会擅自修改主任务。
- **语音输入：** 在环境允许时通过 DSH 语音能力或明确配置的转写服务，把录音转成输入草稿；不会默认自动发送。桌面端 DSH 只向主框架授予麦克风权限，WebChat 通过顶层采集桥接完成录音（与 DSH 原生语音同一授权环境），录音界面实时显示音量与计时。桌面端 DSH 只向主框架授予麦克风权限，WebChat 通过顶层采集桥接完成录音（与 DSH 原生语音同一授权环境），录音界面实时显示音量与计时。

**一个安装包、两个主要组件：**

| 组件 | 默认状态 | 作用 |
| --- | --- | --- |
| **WebChat Main** | 开启 | 主聊天页面和基础功能 |
| **Agent Side Chat** | 关闭 | DSH Agent 任务旁的独立讨论面板 |

上下文、费用和语音属于**可选集成能力**，不是使用主聊天的必装条件。全局停用某个 DSH 插件与允许模型调用它提供的工具，是两件不同的事。

### 5. 自己调节阅读与输入界面

保留以 DeepSeek Demo 为基础的默认界面，并提供**自由外观设置**：强调色、背景/面板/输入框透明度、布局密度、行距、圆角、输入框宽度、字体大小、阅读宽度、浅色/深色/跟随 DSH，以及适用环境下的窗口内磨砂。旧版的 GPT、Gemini、Claude 模仿布局已退役，安装更新时会自动迁移为等效的自由外观配置（保留颜色与阅读偏好）。

界面提供中文、英文和日语选项；切换界面语言不会翻译已有聊天记录。

## 安装

### 需要什么？

- 已安装 **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**，并能够进入其插件管理器。
- 配置了至少一个 DSH 可用的聊天模型；特殊 DeepSeek Rich 功能需要对应的兼容模型和凭证。
- 插件当前声明的 DSH 运行时兼容区间为 `>=0.2.2-rc.3 <0.2.3-0`。从源码构建需要 Node.js **22 或更高版本**及 pnpm。

### 推荐：通过 DSH 插件管理器安装

打开 **DSH → 插件 → 添加插件**，输入：

```text
 dsh-webdemo-chatds
```

安装后启用 **WebChat Main**，左侧出现 **WebChat** 入口。如果需要 Agent 旁聊，再单独启用 **Agent Side Chat**。

### 命令行安装（以 Web Profile 为例）

```bash
dsh plugin --profile web add dsh-webdemo-chatds@0.11.7
```

如果你的 DSH 使用其他 Profile（例如 Windows Desktop 的 `desktop`），应在对应 Profile 的插件管理器中操作；不要把 `web` 直接当作所有平台的 Profile 名称。

也可从 [GitHub Releases](https://github.com/Ritacuk/dsh-webdemo-chatds/releases) 下载版本对应的 `.tgz`，再经 DSH 官方插件管理器安装。**README 中的版本是撰写时的基线；安装前请查看实际最新 Release 和兼容要求。**

## 30 秒上手

1. 在 DSH 左侧点击 **WebChat**，进入欢迎页面。
2. 在输入框右侧选择已配置的模型，直接发送一条消息。
3. 点击输入框的设置入口，按需开启**深度思考**、**智能搜索**或**本地检索**。
4. 需要阅读文件时直接添加附件；要在主机目录里检索，先到 **DSH 设置 → ChatDS 设置 → 文件** 给予只读授权。
5. 复杂任务需要实际修改工作区时，从对应消息创建 DSH **Agent 工作分支**；普通问答不需要这样做。

**推荐的日常配置：** Chat + 低成本 Flash 模型 + 思考关闭 + 联网搜索关闭 + 额外模型工具不授权。需要更深入的分析再主动开启对应能力。

## 和其他方案有什么不同？

| 方案 | 更适合的场景 |
| --- | --- |
| **DeepSeek 官方网页** | 使用官方在线产品，不依赖 DSH |
| **DSH 原生 Agent** | 编程、工具执行、工作区操作、复杂自动化 |
| **WebChat** | 在 DSH 内低负担地日常聊天，同时保留按需使用 DSH 能力的入口 |
| **直接嵌入 DeepSeek 官网的插件** | 更接近使用原网站；但会话与工具能力取决于网页及容器的实际集成方式 |

WebChat **不是另一个独立的 DeepSeek 账号网站**，也不打算取代 DSH Agent。它连接这两种使用方式。

## 可选插件与来源项目

### 运行基础与直接改编

| 项目 | 在 WebChat 中的作用 |
| --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | **必须安装的运行平台**：模型目录、凭证、Session、工作区、插件与桌面/Web UI |
| [DeepSeek 官方 chat-demo](https://github.com/deepseek-ai/chat-demo) | **主要源码基础**：聊天界面、Markdown/公式、部分前端模块与 Rich 流协议；本项目基于其 v0.1.1 固定提交改编 |

### 可选集成（不安装也能普通聊天）

| 插件 | 提供什么 | 没安装时 |
| --- | --- | --- |
| [dsh-context](https://github.com/bowenliang123/dsh-context) | 上下文组成和使用情况 | 相关详细视图不可用或显示有限信息 |
| [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) | 用量、价格、预算和费用视图 | 不显示其官方账本；不能把缺失记录解释为零费用 |
| DSH 已安装的语音输入组件 | 录音与语音转写能力 | 按实际可用服务降级；云转写需明确启用，可能收费 |

### 设计参考（不代表复制了其源码）

- [YanJiuWeiYuanHui/DeepChat](https://github.com/YanJiuWeiYuanHui/DeepChat)：多模型、提示词、文件与日常聊天体验的设计参考。
- [YinkaiYu/chat-in-dsh](https://github.com/yinkaiyu/chat-in-dsh)：在 DSH 中提供自然聊天入口的社区思路。
- [jaychang1989/dsh-webchat](https://github.com/jaychang1989/dsh-webchat)：将官方聊天网站嵌入 DSH 的另一种路线，用于比较产品边界。
- [Aixineiar/dsh-side-chat](https://github.com/Aixineiar/dsh-side-chat) 与 [Better Sidebar](https://github.com/omdsh-dev/dsh-better-sidebar)：旁聊、右侧栏和任务上下文交互的参考。
- [Cherry Studio](https://github.com/CherryHQ/cherry-studio)、[LobeHub](https://github.com/lobehub/lobehub)、[LibreChat](https://github.com/danny-avila/LibreChat)：外观、设置、会话与文件管理的设计参考。

**代码来源和版权归属以仓库中的 [NOTICE](packages/chat-main/NOTICE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 为准。** 参考某项目的交互设计，不意味着本项目直接包含它的源码。

## 费用、隐私与限制

**费用。** WebChat 不提供免费的模型额度，也不承诺一定比其他客户端便宜。它减少不必要的工具和请求负担，但实际费用由所选模型及其服务决定。DeepSeek Rich 通路可通过 `dsh-cost-meter` 的外部用量协议合并统计；**外部合计与原生 Agent 账本/预算组件并非在所有视图中完全相同**，请留意来源说明。Rich 轮的每条消息与状态条会显示金额——由 dsh-cost-meter 价表与峰谷规则计算；0.11.2 之前的 Rich 记录不带会话归属，显示 Token 而无金额，合计仍以外部用量区为准。金额显示也可能受到价格表匹配、时段定价和历史记录完整性的影响。

**文件与凭证。** 模型凭证由 DSH Host 管理，不要求把 API Key 填进 WebChat 页面。本地目录检索只读且需显式授权。主动上传到云端处理的文件则遵循对应模型服务的文件与隐私规则；撤销本地目录权限不等于自动删除此前上传到云端的附件。

**兼容性。** 已有 Windows Desktop、Linux DSH Web 和 Apple Silicon macOS DSH Web 的不同阶段验收记录，但**不能把某平台旧版本的通过结果直接当作最新版本全功能通过**。macOS Desktop、Intel Mac 和未来 DSH 大版本应另行测试。

**当前局限。** 某些联网搜索/网页抓取能力取决于服务端；无桌面文件选择器的 Linux Host 可能需要手动授权路径；Office 文档主要提取文本而不是完整视觉排版；长时稳定性、语音设备和第三方插件的实际兼容性仍需结合安装环境验证。WebChat 也不内置独立的完整长期记忆系统。

发现问题请在 [Issues](https://github.com/Ritacuk/dsh-webdemo-chatds/issues) 反馈，并附上 **DSH 版本、WebChat 版本、运行平台、复现步骤和脱敏日志**。不要上传 API Key、Cookie 或私人会话内容。

## 开发

```bash
git clone https://github.com/Ritacuk/dsh-webdemo-chatds.git
cd dsh-webdemo-chatds
corepack enable
pnpm install
pnpm --filter @dsh-chat/shared run build
pnpm -r run typecheck
pnpm -r run test
pnpm --filter dsh-webdemo-chatds run build
```

仓库主要分为：

```text
packages/
├── chat-shared/   # 官方 Demo Rich / SSE 协议与会话数据转换
├── chat-main/     # WebChat Host、React 客户端、发布包与 DSH 接口
└── chat-sidecar/  # Agent Side Chat 相关模块
```

开发、打包和真实 DSH Profile 安装的更多细节请查看仓库源码与 [更新日志](CHANGELOG.md)。贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请参阅 [SECURITY.md](SECURITY.md)。

## 开源协议与致谢

WebChat 以 [MIT License](LICENSE) 发布。项目客户端及 Rich 协议核心大量改编自 DeepSeek 的开源 [chat-demo](https://github.com/deepseek-ai/chat-demo)，保留相应版权和许可声明。

感谢 DeepSeek Harness、chat-demo 及所有被参考和集成的开源项目作者。本项目为独立社区项目，与 DeepSeek 官方不存在产品隶属或背书关系。

---

**WebChat：先好好聊天；需要做事时，再交给 DSH。**
