# WebChat for DeepSeek Harness

**WebChat** is an independent community chat plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): it brings the look and behavior of DeepSeek's official [chat-demo](https://github.com/deepseek-ai/chat-demo) (pinned upstream commit `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`, v0.1.1) into the DSH plugin system, running for real.

> **WebChat is an independent community project for DeepSeek Harness. It is not an official DeepSeek product.**
> **WebChat 是基于 DeepSeek Harness 开发的独立社区项目，并非 DeepSeek 官方产品。**

中文说明：[README.zh-CN.md](README.zh-CN.md)

```
user input → DSH host → DeepSeek Rich API → SSE → structured reply → DSH session persistence → UI restore
```

## Why WebChat exists

DeepSeek's official adapter (`dsh-llm-deepseek`) intentionally "circuit-breaks" on Rich-only blocks — thinking signatures, search steps, fetched web pages, citations, refusals — so this content cannot survive the generic DSH LLM pipeline. WebChat implements a dedicated direct channel for these blocks with full UI rendering, while handing all history and settings to DSH's official persistence layer: DSH remains the single source of truth; the WebChat page keeps zero local state.

## Features

- **Demo-style chat**: new/multi-turn conversations, streaming output, stop, edit & resend, regenerate, reply branching.
- **Thinking & search**: deep-thinking blocks (with signature chain), web-search steps, fetched page results, citation linking — all rendered structurally.
- **DSH model catalog**: DSH model list, provider grouping, model whitelist, favorites, thinking levels, default model.
- **Files & attachments**: chat attachments (cloud Files API parsing or direct send by model capability); local directory authorization + read-only retrieval (TXT/Markdown/CSV/DOCX/XLSX/PPTX content, PDF/image by filename).
- **Prompt templates**: global prompts, template variables, draft insertion.
- **Context & cost**: integrates `dsh-context` / `dsh-cost-meter` (optional plugins) for context usage and spend display.
- **Plugin permissions**: shows running DSH bundles/components; read-only local capabilities require explicit grants.
- **Session import/export**: compatible with official Demo v3, DeepChat v3, and WebChat ZIP; per-session Markdown/JSON/ZIP export, batch ZIP import with preview and dedup.
- **UI styles**: WebChat default / GPT / Gemini / Claude, light/dark/follow-DSH, in-window glass, font size and reading width.
- **Agent Side Chat** (Desktop): side chats beside DSH Agent work branches with checkpoint sync.

## Compatibility

| Platform | Status |
| --- | --- |
| Linux DSH Web (DSH 0.2.2-rc.3, Node 22) | ✅ fully verified this round (install, real-model chat, persistence, restart recovery, uninstall/reinstall) |
| Windows Desktop (DSH Desktop 44.7.0, bundled runtime 0.2.2-rc.5, Node 24) | ✅ fully verified in the R8.2 round (125 host unit tests + native UI regression) |
| macOS (Apple Silicon) DSH Web | ✅ acceptance-tested (macOS 26.6.2, Apple M4, DSH Web track; Desktop/Intel not claimed) |
| Other DSH versions | ⚠️ peer range declared as `>=0.2.2-rc.3 <0.2.3-0`; higher major versions are not guaranteed |

## Installation

Prerequisite: DeepSeek Harness installed and the `dsh` CLI available.

### Option 1: npm package (recommended)

```bash
# install into a target profile (e.g. the default web profile)
dsh plugin --profile web add dsh-webdemo-chatds@next
# drop @next once a stable tag is published
```

If your DSH version falls outside the peer range, DSH's version gate will reject the install — that is a protection mechanism; follow its guidance to update the plugin.

### Option 2: GitHub Release

Download `dsh-webdemo-chatds-<version>.tgz` from [Releases](../../releases):

```bash
dsh plugin --profile web add ./dsh-webdemo-chatds-0.10.0.tgz
```

### Option 3: build from source

```bash
git clone <this repository>
cd <repository>
pnpm install            # Node >= 22, pnpm via Corepack
pnpm --filter @dsh-chat/shared run build     # build the protocol core first (client typecheck depends on its output)
pnpm -r run typecheck
pnpm -r run test        # shared 21 + main 126 + sidecar 3 tests
pnpm --filter dsh-webdemo-chatds run build   # host bundle + client page
cd packages/chat-main && pnpm pack --pack-destination ../../dist-packages
dsh plugin --profile web add ../../dist-packages/dsh-webdemo-chatds-<version>.tgz
```

After installing, **restart the DSH web service** (or enable the components in DSH's plugin manager); a "WebChat" entry appears in the sidebar.

## Quick start

1. Open "WebChat" from the sidebar.
2. Pick a model from the picker at the bottom (the list comes from DSH's model catalog).
3. Toggle deep thinking / web search in the input area (official DeepSeek models only).
4. Local file retrieval: DSH settings → ChatDS settings → Files; authorize directories, then enable local retrieval.

## Authentication & costs

WebChat reuses DSH's official credential system, in priority order:

1. DeepSeek **API key** (configured on DSH's Models page or as `DEEPSEEK_API_KEY` in `$DSH_HOME/.credentials.yaml`);
2. DSH's **signed-in DeepSeek account token** (the official account service decides per destination).

WebChat does not make the DeepSeek API free: model requests, web search, file parsing, and third-party model services may incur costs. Rich-channel usage is reported truthfully by the model service and labeled on each message; whether it reaches the `dsh-cost-meter` unified ledger depends on that plugin's Rich coverage (see known limitations).

## Security & privacy

- **Local directory grants**: read-only; every grant is Host-validated (absolute path, realpath, existing and readable). Path traversal and symlink escapes are rejected at the engine level (covered by dedicated tests).
- **Environments without a directory picker** (e.g. headless Linux servers): the settings page offers a manual absolute-path grant with the same Host-side validation.
- **Credentials**: the browser never sees keys/tokens; the Host resolves credentials per request.
- **Session data**: stored entirely in DSH's official session storage (`$DSH_HOME/sessions`); WebChat keeps no copies.

## Optional integrations

| Plugin | Purpose | When missing |
| --- | --- | --- |
| `dsh-cost-meter` | cost/usage display | cost area shows "not connected"; main chat unaffected |
| `dsh-context` | context usage display | same |

## Known limitations (truthful)

- **Real web search**: protocol and UI implemented; real search billing must be confirmed by the user (not acceptance-tested this round).
- **Voice**: transcription depends on DeepSeek ASR plus credentials; desktop local speech uses Windows voices only.
- **Agent work-branch directory picking**: only DSH Desktop (`dsh-app:` protocol) offers a native picker; on Linux Web, creating a native branch with a working directory is explicitly refused.
- **Rich usage ledger**: Rich usage is labeled truthfully but is not yet merged into the `dsh-cost-meter` unified ledger (pending upstream support).
- **Linux directory picker**: on servers without a portal, DSH's official picker service may be unavailable — use the manual path grant.
- Non-ASCII attachment filenames are rewritten to a safe whitelist on disk (content is unaffected).

## Development

```bash
pnpm install
pnpm -r run typecheck
pnpm -r run test
pnpm --filter @dsh-chat/shared run build
pnpm --filter dsh-webdemo-chatds run build
```

Layout: `packages/chat-shared` (wire protocol core) · `packages/chat-main` (host + client page, the published npm package) · `packages/chat-sidecar` (side-chat component scaffold). The host build injects the current git commit into the Health endpoint (`/chat-workspace/api/health`).

## Credits & license

- This project's code is released under the [MIT license](LICENSE).
- The client UI and the wire-protocol core are substantially adapted from [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) (MIT, Copyright (c) 2026 DeepSeek) — the full derivation statement ships in [NOTICE](packages/chat-main/NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Runs on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT).
- This project uses no DeepSeek brand assets; the bundled icon is an original work of this project.
