# Known Limitations

Kept truthful and version-stamped. Last updated: 2026-11-21 (0.9.0-rc.8).

## Not verified (implemented, but no real-usage acceptance)

- **Real web search billing**: the search protocol path is implemented and protocol-tested; real search with the official API was not exercised in acceptance (cost confirmation belongs to the user).
- **Voice transcription**: depends on the DeepSeek ASR endpoint and credentials; not exercised on Linux.
- **IME composition edge cases** and exhaustive font-size/width layout matrices.

## Environment boundaries

- **Linux directory picker**: DSH's official `uiWorkspace.pickDirectory()` exists on web, but on hosts without a desktop portal the Host-side chooser may fail or hang. The settings page therefore always offers a manual absolute-path grant with the same Host-side validation.
- **Agent work-branch directory picking** requires DSH Desktop's `dsh-app:` protocol; Linux Web refuses explicitly with a user-facing message.
- **Attachment filename sanitization**: non-ASCII filenames are rewritten to a whitelist (`[A-Za-z0-9._() -]`) on disk; message content is unaffected.

## Cost accounting

- Rich-channel usage (WebChat's dedicated DeepSeek channel) is reported by the model service and labeled per message, but is **not merged into the `dsh-cost-meter` unified ledger** — the official meter does not yet observe this channel. DSH's own LLM traffic is unaffected.

## Compatibility

- Peer range declared for DSH `>=0.2.2-rc.3 <0.2.3-0` (verified at rc.3 on Linux and rc.5 on Windows Desktop). Higher minor/major DSH versions are expected to work but are not claimed.
- macOS: untested.
- **Agent Side Chat** requires DSH Desktop; on Linux Web the component row exists but is disabled by default.

## Import/export

- Archives whose attachments were originally cloud-only references cannot restore the underlying blobs; the UI states this explicitly and preserves the metadata.
