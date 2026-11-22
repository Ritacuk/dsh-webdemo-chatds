# Changelog

All notable changes to this project are documented here. Versions follow semver; pre-release versions use `-rc.N` and were published under the `next` npm dist-tag; stable-line releases publish as `latest`.

## 0.11.0 (2026-11-22)

R8.5 — the ten-item real-user feedback round, verified live on an isolated Linux DSH Web profile (DSH 0.2.2-rc.5) and shipped to the production web profile. Windows Desktop acceptance for this round is in progress.

### Fixed

- **[P0] New-chat clicks created endless empty history**: the sidebar "new chat" button now returns to the welcome page locally; a session entity is created only when the first message is sent. Attachments and handovers pre-create a **draft session** that stays out of the history list until its first message lands. Composer text now persists per chat (and across new-chat toggles) in the store.
- **[P0] Side Chat had no entry**: the sidecar registers a real right-sidebar tab (`WebChat 侧聊`, kind `chatds-side-chat` — distinct from dsh-better-sidebar's kinds) plus a per-session header action that opens it bound to the current Agent session; the body hosts the sidecar page with the parent checkpoint sync. The sidecar component now enables/disables live with DSH hot-toggles.
- **[P1] Dark-mode switches were illegible**: both switch families (composer + settings) use an accent track for on / muted track for off, with focus-visible and saving states.
- **[P1] No microphone entry despite voice support**: a mic button sits in the composer when voice is available (DSH voice component detected or explicitly enabled). Transcription prefers the DSH speech service; the paid DeepSeek ASR is a fallback only when voice input is explicitly enabled.
- **[P1] Plugin hot-toggle now recovers the navigation** (verified live on DSH 0.2.2-rc.5 web: disable removes the entry, re-enable restores it, no restart); a disabled-state panel notice replaces the broken-iframe window.
- **[P1] Rich usage now reaches the unified ledger**: per-call records are written to `dsh-cost-meter`'s official `external_usage.json` protocol (source `chatds-rich`, idempotent per message, cache-read separated, unpriced models deferred). The status bar, cost details, and per-message usage lines show the merged view; the reminder chain runs on the merged ratio.
- **[P1] Budget threshold is a real number input** (1–100, saved on blur, quick chips retained), with an honest "no budget set" state and a shortcut into dsh-cost-meter's native settings. Reminder firing verified live with a test budget.
- **[P1] The four UI styles are real layouts now**: GPT (minimal sidebar, wide content, flat composer), Gemini (large gradient greeting, pill composer, blue-violet accent), Claude (serif reading width, paper composer), default (demo). Frosted glass actually blurs: header/composer overlay scrolling content, and floating layers blur it.
- **[P1] Agent work branches pick a DSH workspace**: a workspace dialog lists the official registry (parent chat's workspace preselected); the directory picker only appears when creating a brand-new workspace. Branches inherit context as native seeds and open through the official navigation (verified live).
- **[P2] Full Japanese interface**: complete ja-JP dictionary (383 keys incl. the settings surface), locale-aware month grouping, browser-fallback chain.

### Verified platforms

| Platform | Status |
| --- | --- |
| Linux DSH Web (DSH 0.2.2-rc.5, Node 22) | ✅ R8.5 acceptance in an isolated profile; production web profile upgraded to 0.11.0 |
| Windows Desktop (DSH Desktop 44.7.0, runtime 0.2.2-rc.5) | ✅ R8.2 (0.10.0); 0.11.0 desktop acceptance in progress |
| macOS | ✅ 0.10.0 acceptance; 0.11.0 not re-tested |

## 0.10.0 (2026-11-22)

First cross-platform-verified release: Linux DSH Web (R8.4) and macOS Apple Silicon DSH Web (M01–M05) both acceptance-tested on real hosts; Windows Desktop verified in R8.2.

### Fixed

- **[P1] Search-body relative links were rewritten into fake URLs**: a model-emitted relative link such as `[MIT](LICENSE)` rendered as `https://license/`. Markdown link sanitization now only completes `https://` for host-like specifiers (dot-separated, not a document extension); relative paths render as plain text. Verified against the real search session re-render. (Linux R8.4)
- **[P2] Plan-tool grant API accepted names outside the whitelist**: `PUT .../tools` now rejects non-Plan tool names with a 400 naming the allowed tools. (Linux R8.4)
- **[macOS] Send-shortcut label**: the option shows `⌘ + Enter` on macOS (implementation always accepted ⌘; label only). (macOS acceptance R1)
- **[macOS] Root-level React error boundary**: a once-observed unreproducible blank panel (React production unmount on an uncaught render error) now degrades to an in-panel reload card; session data lives in DSH storage and is unaffected. (macOS acceptance R2)
- **[test] macOS TMPDIR realpath**: the gb18030 snippet test computes the authorized-root id via `realpathSync` — the engine normalizes roots by realpath by design; macOS `/var/folders` symlink made the literal-path id mismatch. Test-side only. (macOS acceptance R3)
- **Sidecar component naming**: the second component row now resolves through the package subpath (`dsh-webdemo-chatds/sidecar`) instead of a raw relative file path in the plugin surfaces.
- **Docs**: install examples updated; platform compatibility matrix updated (macOS Web verified, Desktop/Intel not claimed).

### Verified platforms

| Platform | Status |
| --- | --- |
| Linux DSH Web (DSH 0.2.2-rc.3 → rc.5, Node 22) | ✅ R8.4 real-model acceptance on the upgraded host |
| Windows Desktop (DSH Desktop 44.7.0, runtime 0.2.2-rc.5) | ✅ R8.2 acceptance |
| macOS (Apple Silicon M4, macOS 26.6.2, DSH Web track) | ✅ M01–M05 acceptance (Desktop/Intel not claimed) |

## 0.9.0-rc.9 – 0.9.0-rc.14 (2026-11-21)

Publishing-mechanics corrections (rc.9–rc.12: registry metadata, directory publish, npm CLI), the R8.4 Linux acceptance fixes (rc.14: search-link sanitization + grant validation), and packaging rebuilds so the Health endpoint self-reports the tagged commit (rc.13). Package code identical to rc.8 otherwise.

## 0.9.0-rc.8 (2026-11-21)

First release prepared for public distribution (GitHub + npm). The project was previously developed privately for personal DSH setups; the changelog below summarizes the meaningful engineering history rather than claiming public release dates that never existed.

### Linux DSH Web support (this release's focus)

- **Node 22 compatibility**: replaced four `await using` declarations with explicit handle disposal (`try/finally` + `close()`); build target moved from `node24` to `node22`; `engines` lowered to `>=22`. The plugin previously failed to load at all on Node 22 hosts.
- **Dependency architecture**: all thirteen `@deepseek-ai/dsh-*` packages moved from `dependencies` to `peerDependencies` with a declared range (`>=0.2.2-rc.3 <0.2.3-0`). Exact-pinned rc.5 packages in a profile were disabled by DSH's version gate and crashed startup on rc.3 hosts.
- **Peer ranges widened** for `@deepseek-ai/cordis` (`>=4.0.5 <5`) and `@deepseek-ai/dsh-host-webserver` (range instead of exact rc.5 pin) so DSH's install gate accepts compatible runtimes instead of demanding exact-version exemptions.
- **Account-token authentication**: when no DeepSeek API key credential is configured, the Rich channel now falls back to the signed-in DeepSeek account token via DSH's official account service (`resolveDeepSeekAccountToken`), sent with the `x-dsh-auth-token` header — the same scheme DSH's own account provider uses. Verified end-to-end with a real model round-trip on a Linux host.
- **Directory authorization without a native picker**: the file-access settings page now (1) uses the Desktop native bridge when present, (2) falls back to DSH's official `uiWorkspace.pickDirectory()` service on web, and (3) always offers a manual absolute-path grant, Host-validated (absolute, realpath, readable). Added for headless Linux servers where the official picker cannot open.
- **POSIX directory id fix**: `dirIdOf` lowercased paths unconditionally, colliding distinct directories on case-sensitive filesystems; now lowercases on win32 only.
- **Platform-aware rejection test**: the `..\..\` traversal test now reflects POSIX semantics (backslash is not a separator); an explicit `../../` traversal test added for all platforms.
- **Windows-only label fix**: the appearance "follow system" option no longer says "follow Windows" on non-Windows platforms.
- **Evidence script cleanup**: `collect-evidence.mjs` no longer hardcodes a private Windows installation path; it requires `DSH_NODE`/`DSH_PNPM` env vars.

### Carried from the private development history (R1–R8.2)

- Rich protocol fidelity: thinking blocks with signature chains, web-search steps, fetched pages, citations, refusal handling; dedicated direct channel bypassing the official adapter's Rich circuit-breaker.
- DSH session persistence as the single source of history (official JSONL + flush barrier), interrupted-turn recovery, session title generation.
- Model catalog integration, whitelist, favorites, thinking levels.
- File attachments (cloud Files API or direct), local directory retrieval engine with traversal/symlink protection.
- Prompt templates; context/cost integration surfaces; plugin component display with read-only capability grants.
- Session import/export compatible with official Demo v3, DeepChat v3, and WebChat ZIP; single-session Markdown/JSON/ZIP export; batch import with preview and dedup.
- Appearance system: four UI styles, light/dark/follow-DSH, glass effect, font size and reading width.
- Agent Side Chat for DSH Desktop work branches; Agent work-branch creation with checkpoint verification.
- R8.2 verified on Windows Desktop (125 host unit tests, native UI regression); R8.3 (this release) verified on Linux DSH Web (150 tests, real-model chat, persistence across restarts, uninstall/reinstall).

## 0.9.0-rc.7 (2026-11-20)

Private baseline corresponding to the R8.2 Windows Desktop delivery: settings reorganization, plugin component UI, Windows-native file picker integration, appearance system, import/export and session integrity work. Not published to npm.
