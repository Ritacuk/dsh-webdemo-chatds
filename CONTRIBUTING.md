# Contributing

Thanks for your interest in improving WebChat!

## Ground rules

- This is an independent community project — it is not an official DeepSeek product. Please do not present it as one.
- Never commit credentials, session data, or machine-specific paths. CI and reviews reject private data.
- Do not modify or redistribute DeepSeek Harness's own binaries/packages; this plugin only consumes them as peers.

## Development

```bash
pnpm install
pnpm -r run typecheck
pnpm -r run test        # shared 21 + main 126 + sidecar 3
pnpm --filter dsh-webdemo-chatds run build
```

The published npm package is `packages/chat-main` (`dsh-webdemo-chatds`); build it with `pnpm pack` and install into an isolated DSH profile first (`dsh plugin --profile <test-profile> add <tarball>`) before touching a daily profile.

## Pull requests

1. Keep changes minimal and focused; one topic per PR.
2. Add or update tests for behavior changes — the local-search and session-writer suites are good templates.
3. Run the full typecheck + test pipeline before pushing.
4. Describe what you verified on a real DSH instance (and on which DSH version).
