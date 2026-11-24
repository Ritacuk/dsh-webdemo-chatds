# Known Limitations

Kept truthful and version-stamped. Last updated: 2026-11-21 (0.9.0-rc.8).

## Not verified (implemented, but no real-usage acceptance)

- **Real web search billing**: the search protocol path is implemented and protocol-tested; real search with the official API was not exercised in acceptance (cost confirmation belongs to the user).
- **Voice transcription**: depends on the DeepSeek ASR endpoint and credentials; not exercised on Linux.
- **IME composition edge cases** and exhaustive font-size/width layout matrices.

## Environment boundaries

- **Linux directory picker**: DSH's official `uiWorkspace.pickDirectory()` exists on web, but on hosts without a desktop portal the Host-side chooser may fail or hang. The settings page therefore always offers a manual absolute-path grant with the same Host-side validation.
- **Agent work-branch workspace picking**: the dialog lists registered DSH workspaces via the official registry; the directory picker is only offered when creating a new workspace.
- **Attachment filename sanitization**: non-ASCII filenames are rewritten to a whitelist (`[A-Za-z0-9._() -]`) on disk; message content is unaffected.

## Cost accounting

- Rich-channel usage is recorded into the `dsh-cost-meter` unified ledger through its official `external_usage.json` protocol (source `chatds-rich`, idempotent per message). The meter's native budget widget still counts the DSH ledger only; WebChat's budget view merges both and states the caveat in the UI.

## Compatibility

- Peer range declared for DSH `>=0.2.2-rc.3 <0.2.3-0` (verified at rc.3 on Linux and rc.5 on Windows Desktop). Higher minor/major DSH versions are expected to work but are not claimed.
- macOS: untested.
- **Agent Side Chat** requires DSH Desktop; on Linux Web the component row exists but is disabled by default.

## Import/export

- Archives whose attachments were originally cloud-only references cannot restore the underlying blobs; the UI states this explicitly and preserves the metadata.

## 0.12.2 local candidate

The WebChat conversation sidebar can move within its own panel. Native DSH right-side tabs attach to native sessions and remain the integration point for Agent Side Chat.

The detected DSH 0.2.2-rc.5 translation and automatic title providers depend on managed DSH sessions. Detached WebChat sessions use their own single reasoning display and the DSH deterministic title fallback. The experimental session-search service is isolated in its bundle, and dsh-context 0.84.1 exposes context projections. WebChat has no public, permission-scoped access to their native search or memory management operations.

Voice selection uses a registered DSH speech provider. Local browser voices can read replies; audio output availability depends on the OS and browser. Vision follows DSH model metadata. Standalone OCR, image generation, and continuous calls are unavailable in this candidate.

## 0.12.2-rc.1 preview

ChatDS remains the authority for its isolated conversation history. The preview directly calls the DSH Translator for confirmed Bing or Google reasoning requests. Paid translation and automatic use of native title providers require managed Sessions. Full-text search and memory are local ChatDS capabilities with profile scope. Model-assisted titles and memory extraction are optional generic-model requests. The stable npm channel is 0.12.1.
