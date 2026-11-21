# Third-Party Notices

This project contains code adapted from, or distributed alongside, the following third-party sources. Each entry lists the source, the license, and how it is used.

## deepseek-ai/chat-demo

- **Source**: https://github.com/deepseek-ai/chat-demo — pinned upstream commit `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c` (v0.1.1)
- **License**: MIT — Copyright (c) 2026 DeepSeek
- **Use**:
  - The React client (`packages/chat-main/client/src/`) is a derivative of the official demo's client: base/markdown/search components, their CSS, markdown services, i18n infrastructure, and utilities are taken from or adapted from upstream; conversation-specific screens are heavily modified extensions.
  - The wire-protocol core (`packages/chat-shared/src/chat/`, `packages/chat-shared/src/protocol/`) is ported from the upstream demo; affected files carry source notes in their headers.
  - Directly adapted modules with header notes: the history ZIP reader (`packages/chat-main/src/host/archive-zip.ts`) and the microphone recorder (`packages/chat-main/client/src/services/speech/recorder.ts`).
  - Some host fragments: system-prompt constant (`turns.ts`), archive v3 export/validation logic (`archive.ts`), and `demo-reminder.ts` (from upstream latestReminder).
  - The full scope statement ships in `packages/chat-main/NOTICE`.
- DeepSeek and the DeepSeek logo are trademarks of DeepSeek. This project is an independent community project, is not an official DeepSeek product, and does not use DeepSeek brand assets; the bundled `webchat-icon.svg` is an original work of this project.

## deepseek-ai/deepseek-harness

- **Source**: https://github.com/deepseek-ai/deepseek-harness
- **License**: MIT
- **Use**: This plugin runs on top of the Harness and consumes its published npm packages (`@deepseek-ai/*`) as peers at runtime. No Harness source is copied into this repository; its packages are declared as peer dependencies and are not redistributed by this project.

## Bundled client libraries (compiled into `client-dist/`)

The React client bundles the following open-source libraries; all are distributed under permissive licenses (MIT unless noted):

| Library | License | Use |
| --- | --- | --- |
| react / react-dom | MIT | UI runtime |
| zustand | MIT | client state |
| katex (incl. bundled fonts) | MIT | math rendering |
| mermaid | MIT | diagram rendering |
| prismjs | MIT | code highlighting |
| marked family (`mdast-util-*`, `micromark-*`) | MIT | markdown pipeline |
| dompurify | (MPL-2.0 OR Apache-2.0) | HTML sanitization |
| clsx | MIT | class helpers |

## Bundled host dependencies (compiled into `lib/`)

| Library | License | Use |
| --- | --- | --- |
| zod | MIT | config/schema validation |
| fflate | MIT | ZIP import/export |

## Runtime peer dependencies (not redistributed)

`@deepseek-ai/cordis`, `@deepseek-ai/dsh-host-webserver`, `@deepseek-ai/schemastery`, and the `@deepseek-ai/dsh-*` service packages are provided by the installed DeepSeek Harness at runtime and are declared as peer dependencies of `dsh-webdemo-chatds`. They are not copied into or redistributed with this package.

## Fonts

KaTeX fonts under `client-dist/assets/media/` are distributed as part of KaTeX; the font files are licensed under the SIL Open Font License 1.1 (copyright © KaTeX contributors). The KaTeX code itself is MIT.
