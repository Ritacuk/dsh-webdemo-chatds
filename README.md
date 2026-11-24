# WebChat for DeepSeek Harness

**Bringing DeepSeek-style everyday chat into DeepSeek Harness.**

[中文](https://github.com/Ritacuk/dsh-webdemo-chatds/blob/main/README.zh-CN.md) · [GitHub](https://github.com/Ritacuk/dsh-webdemo-chatds) · [Releases](https://github.com/Ritacuk/dsh-webdemo-chatds/releases/latest) · [Issues](https://github.com/Ritacuk/dsh-webdemo-chatds/issues) · [Changelog](https://github.com/Ritacuk/dsh-webdemo-chatds/blob/main/CHANGELOG.md)

> WebChat is an independent community chat plugin running inside **DeepSeek Harness (DSH)**. Built on DeepSeek's official open-source [chat-demo](https://github.com/deepseek-ai/chat-demo), it keeps the familiar chat experience and taps into DSH's models, files, plugins, and Agent capabilities as needed.
>
> **This is a community project — not an official DeepSeek product, and not a direct embedding of the `chat.deepseek.com` website into DSH.**

## Why WebChat?

DSH is great at using tools, handling files, and running complex tasks — but a lot of the time we just want to ask a quick question, work through a formula, translate a paragraph, or upload a handout and keep chatting.

For those things, spinning up a full Agent with large tool definitions and workspace context every time is often unnecessary: **it can be slower, consume more tokens, and complicate plain chatting.**

WebChat targets exactly this:

- **Chat like the DeepSeek web app in everyday use.** Open and ask — no code workspace or Agent setup required first.
- **Keep simple questions simple.** No extra tools are exposed to the model by default; thinking, web search, and local retrieval are opt-in.
- **Use DSH when you need it.** Pick models configured in DSH, read files you uploaded, authorize read-only directories, or create a formal Agent work branch from chat.
- **Chat history is stored reliably.** History is managed by DSH's session system instead of a temporary browser database.

In one sentence: **chat by default; use tools when needed.**

WebChat aims to reduce unnecessary overhead — it does not promise a fixed token-saving ratio. Actual cost still depends on the model, context, cache, thinking, and tool usage.

## What can it do?

### 1. The familiar DeepSeek chat experience

- Multi-turn chat, streaming replies, stop generation, edit & resend.
- Deep thinking, web search for compatible models, web sources and citation display.
- Markdown, code blocks, tables, math formulas (KaTeX), and Mermaid diagram rendering; copy the LaTeX source of formulas.
- Session rename, pin, search, archive, reply version switching, and history restore.
- Session import/export: recognizes official Demo, DeepChat v3, and WebChat archives; export as Markdown, JSON, or ZIP, with preview and deduplication before import.

**Note:** this project is based on the official *open-source chat-demo* — it does not own all of DeepSeek's undisclosed server-side capabilities from the official website; search and special responses depend on the actually selected model and API.

### 2. Use the models in DSH without forcing an Agent

WebChat reads DSH's model catalog directly — no second set of model API keys to maintain. You can:

- Pick models already configured in DSH; set the default model, favorites, and the whitelist.
- Adjust the thinking levels a model supports.
- Switch between **Chat** and **Plan (read-only)**.
- When real execution is needed, create a **DSH-native Agent work branch** from chat and pick a registered DSH workspace.

| Mode | Best for | Key difference |
| --- | --- | --- |
| **Chat** | Everyday Q&A, learning, translation, explanation, reading uploaded material | No extra model tools called by default |
| **Plan (read-only)** | Step-by-step search, reading, and analysis within an explicitly authorized scope | Limited read-only capabilities; no write tasks |
| **Agent work branch** | Coding, file edits, running commands, complex tasks | Handed to the DSH-native Agent, still following workspace, sandbox, and approval rules |

Thinking, web search, file upload, and voice are not work modes; they are independent capabilities.

### 3. Files: upload to chat; local retrieval needs authorization

- **Attachments:** pick, paste, or drag files in; text extraction or server-side parsing depends on the format and model capability.
- **Office documents:** extractable text from DOCX, XLSX, and PPTX; not equivalent to fully understanding layout, embedded images, or formula objects.
- **Local retrieval:** only searches directories you explicitly authorized; supports content retrieval for common text and Office documents. PDF and images in local retrieval should not be assumed to include full OCR — local filename discovery is a different feature from cloud attachment processing.
- **Revocation:** after revoking a directory grant, later retrieval cannot access that directory.

> **Where the files live matters.** If you access a Linux DSH from a browser on another computer, authorized directories are folders **on the Linux DSH host**; files on the browser computer should use attachment upload.

### 4. Use DSH's capabilities instead of rebuilding DSH

- **Plugins & tools:** view available plugins, components, and capabilities; extra model tools are not authorized by default — which read-only capabilities are allowed is up to you.
- **Context & cost:** integrates `dsh-context` and `dsh-cost-meter`. The bottom status bar follows DSH's native footer style — turns, tokens (tok), cache hit, session cost, and the merged budget — and clicking a segment opens the dsh-context panel or the dsh-cost-meter cost page directly. Rich-turn amounts are computed from dsh-cost-meter's price catalog with its peak/off-peak rule.
- **Prompts:** global extra prompts, template library, variable substitution, and draft insertion.
- **Agent Side Chat:** an independent side chat beside a DSH Agent task, inheriting relevant context from committed checkpoints; it never modifies the main task on its own.
- **Voice input:** where the environment allows, uses DSH voice capability or an explicitly configured transcription service to turn recordings into input drafts; never sent automatically by default. On desktop, DSH grants microphone access only to the main frame — WebChat records through a top-frame capture bridge (the same authorized context as DSH native voice), with a live level meter and timer in the recording dialog.

**One package, two main components:**

| Component | Default | Purpose |
| --- | --- | --- |
| **WebChat Main** | On | The main chat page and core features |
| **Agent Side Chat** | Off | An independent discussion panel beside DSH Agent tasks |

Context, cost, and voice are **optional integration capabilities** — not required for the main chat. Globally disabling a DSH plugin and allowing a model to call its tools are two different things.

### 5. Adjust the reading and input interface yourself

The DeepSeek Demo-based default interface is kept, plus **free appearance settings**: accent color, background/panel/composer opacity, layout density, line height, corner radius, composer width, font size, reading width, light/dark/follow-DSH, and in-window frosted glass where the environment supports it. The legacy GPT, Gemini, and Claude imitation layouts are retired; updating migrates them automatically into equivalent free-appearance settings (colors and reading preferences are kept).

The interface offers Chinese, English, and Japanese; switching the UI language does not translate existing chats.

### 6. Data sharing between your own devices (opt-in)

WebChat ships an optional **Data Sharing** plugin row. It is disabled by default and is separate from Main and Side Chat. Turn it on in the DSH plugin manager when you want to move selected chats between devices you own.

- **A single device sync password.** Set a passphrase on the first device. On a second device, open **Data Sharing → Devices → Join existing devices**, choose the first device, and enter the same passphrase. Enable LAN connections on both devices and keep them on the same network for enrollment.
- **Private chat sharing.** Devices authenticate with their own identities. LAN sessions use fresh X25519 exchanges. Cloud objects use one-time keys. The sync passphrase authenticates enrollment.
- **Windows LAN permissions.** Use **Allow local devices to connect**. ChatDS grants access to its sync and discovery traffic on the Private profile for the local subnet. ChatDS can rebind its listener while DSH keeps running.
- **Device removal.** Removing a device stops subsequent sharing with that device. Copies already downloaded stay on that device.

See the [sharing setup and migration guide](docs/sharing-setup.md) for installation, password recovery and backup.

## Install

### What you need

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** installed, with access to its plugin manager.
- At least one chat model configured in DSH; special DeepSeek Rich features need the compatible model and credentials.
- The plugin declares DSH runtime compatibility `>=0.2.2-rc.3 <0.2.3-0`. Building from source needs Node.js **22+** and pnpm.

### Recommended: install through the DSH plugin manager

Open **DSH → Plugins → Add plugin** and enter:

```text
 dsh-webdemo-chatds
```

After installing, enable **WebChat Main** — the **WebChat** entry appears on the left. For Agent side chat, enable **Agent Side Chat** separately.

### Command-line install (web profile example)

```bash
dsh plugin --profile web add dsh-webdemo-chatds@0.12.1
```

If your DSH uses a different profile (for example `desktop` on Windows Desktop), operate in that profile's plugin manager; do not treat `web` as the profile name for every platform.

You can also download the matching `.tgz` from [GitHub Releases](https://github.com/Ritacuk/dsh-webdemo-chatds/releases) and install it through the official DSH plugin manager. **The version in this README is the baseline at writing time; check the actual latest release and compatibility requirements before installing.**

## 30-second quick start

1. Click **WebChat** on the left to enter the welcome page.
2. Pick a configured model on the right of the composer and send a message directly.
3. Use the composer's settings entry to enable **deep thinking**, **web search**, or **local retrieval** as needed.
4. Add attachments when you need to read files; to search host directories, first grant read-only access under **DSH Settings → ChatDS Settings → Files**.
5. For complex tasks that actually modify a workspace, create a DSH **Agent work branch** from the corresponding message; plain Q&A does not need that.

**Recommended everyday setup:** Chat + a low-cost Flash model + thinking off + web search off + no extra model tool grants. Turn on the corresponding capability when you need deeper analysis.

## How is it different from other options?

| Option | Better suited for |
| --- | --- |
| **DeepSeek official website** | Using the official online product without DSH |
| **DSH native Agent** | Coding, tool execution, workspace operations, complex automation |
| **WebChat** | Low-overhead everyday chatting inside DSH, with an on-ramp to DSH capabilities when needed |
| **Plugins that embed the DeepSeek website** | Closer to using the original site; sessions and tool capabilities depend on how the site and container are integrated |

WebChat is **not another standalone DeepSeek account website**, and it does not aim to replace the DSH Agent. It bridges the two ways of working.

## Optional plugins & source projects

### Foundation & direct adaptation

| Project | Role in WebChat |
| --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | **The required runtime platform**: model catalog, credentials, sessions, workspaces, plugins, and desktop/web UI |
| [DeepSeek official chat-demo](https://github.com/deepseek-ai/chat-demo) | **The main source basis**: chat UI, Markdown/formulas, some front-end modules, and the Rich streaming protocol; adapted from its pinned v0.1.1 commit |

### Optional integrations (plain chat works without them)

| Plugin | What it provides | Without it |
| --- | --- | --- |
| [dsh-context](https://github.com/bowenliang123/dsh-context) | Context composition and usage | The detailed views are unavailable or limited |
| [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) | Usage, prices, budget, and cost views | Its official ledger is not shown; missing records must not be read as zero cost |
| The DSH voice input component, if installed | Recording and speech-to-text | Degrades to the actually available services; cloud transcription requires explicit opt-in and may cost money |

### Design references (not copies of their source)

- [YanJiuWeiYuanHui/DeepChat](https://github.com/YanJiuWeiYuanHui/DeepChat): design reference for multi-model, prompts, files, and everyday chat.
- [YinkaiYu/chat-in-dsh](https://github.com/yinkaiyu/chat-in-dsh): a community idea for a natural chat entry in DSH.
- [jaychang1989/dsh-webchat](https://github.com/jaychang1989/dsh-webchat): another route that embeds the official chat website in DSH, useful for comparing product boundaries.
- [Aixineiar/dsh-side-chat](https://github.com/Aixineiar/dsh-side-chat) and [Better Sidebar](https://github.com/omdsh-dev/dsh-better-sidebar): references for side chat, right sidebar, and task-context interactions.
- [Cherry Studio](https://github.com/CherryHQ/cherry-studio), [LobeHub](https://github.com/lobehub/lobehub), [LibreChat](https://github.com/danny-avila/LibreChat): design references for appearance, settings, sessions, and file management.

**Code provenance and copyright are governed by the [NOTICE](packages/chat-main/NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) in the repository.** Referencing a project's interaction design does not mean this project includes its source code.

## Cost, privacy, and limitations

**Cost.** WebChat does not provide free model quota, nor does it promise to be cheaper than other clients. It reduces unnecessary tool and request overhead, but actual cost is decided by the selected model and its service. The DeepSeek Rich path can be merged into statistics via `dsh-cost-meter`'s external usage protocol; **the external totals and the native Agent ledger/budget widget are not identical in every view** — watch the source notes. Per-message and status-bar amounts for Rich turns are computed from dsh-cost-meter's price catalog with its peak/off-peak rule; Rich records created before 0.11.2 carry no session attribution and show tokens without amounts, while combined totals remain in the external usage area. Amount display can also be affected by price matching, time-of-day pricing, and history completeness.

**Files & credentials.** Model credentials are managed by the DSH Host — WebChat never asks you to put API keys into its page. Local directory retrieval is read-only and requires explicit authorization. Files you upload for cloud processing follow that model service's file and privacy rules; revoking local directory access does not automatically delete attachments previously uploaded to the cloud.

**Compatibility.** There are stage-by-stage acceptance records for Windows Desktop, Linux DSH Web, and Apple Silicon macOS DSH Web — but **a pass on an old version for one platform must not be read as a full pass for the latest version**. macOS Desktop, Intel Macs, and future DSH major versions should be tested separately.

**Current limitations.** Some web search / page fetching capabilities depend on the server; Linux hosts without a desktop file picker may need manual path grants; Office documents are mostly extracted as text rather than full visual layout; long-run stability, voice devices, and real compatibility with third-party plugins still depend on the installation environment. WebChat also does not include its own complete long-term memory system.

If you find a problem, please report it in [Issues](https://github.com/Ritacuk/dsh-webdemo-chatds/issues) with the **DSH version, WebChat version, platform, reproduction steps, and sanitized logs**. Do not upload API keys, cookies, or private session content.

## Development

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

The repository is mainly organized as:

```text
packages/
├── chat-shared/   # official Demo Rich / SSE protocol and session data conversion
├── chat-main/     # WebChat Host, React client, published package, and DSH interfaces
└── chat-sidecar/  # Agent Side Chat modules
```

For more details on development, packaging, and installing into a real DSH profile, see the repository sources and the [Changelog](CHANGELOG.md). Read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing; for security issues see [SECURITY.md](SECURITY.md).

## License & acknowledgments

WebChat is released under the [MIT License](LICENSE). The client and the Rich protocol core are heavily adapted from DeepSeek's open-source [chat-demo](https://github.com/deepseek-ai/chat-demo), with the corresponding copyright and license notices kept in place.

Thanks to DeepSeek Harness, chat-demo, and all the authors of the referenced and integrated open-source projects. This project is an independent community project and has no product affiliation with or endorsement from DeepSeek.

---

**WebChat: chat well first; when there's work to do, hand it to DSH.**
