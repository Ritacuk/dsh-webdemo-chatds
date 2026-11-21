# Changelog

All notable changes to this project are documented here. Versions follow semver; pre-release versions use `-rc.N` and are published under the `next` npm dist-tag.

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
