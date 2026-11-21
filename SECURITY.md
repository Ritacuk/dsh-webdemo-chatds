# Security Policy

## Reporting

Please report suspected vulnerabilities privately via GitHub Security Advisories ("Report a vulnerability" on the Security tab) rather than public issues. Include the plugin version, DSH version, and a minimal description — do not include real credentials or private session data.

## Scope

- The WebChat host (`packages/chat-main/lib`), its HTTP routes, and its client page.
- The local directory authorization engine (path traversal, symlink escapes) and the import/export pipeline.

## Out of scope

- Vulnerabilities in DeepSeek Harness itself — report those upstream to https://github.com/deepseek-ai/deepseek-harness.
- Issues requiring an attacker to already hold the DSH web auth token (the DSH web listener is loopback-only and token-gated by DSH).

## Design notes

- The browser never receives credentials; the Host resolves them per request from DSH's credential store.
- Local directory grants are read-only and validated Host-side (absolute path, realpath, existence, readability); the search engine re-validates every path it touches against the authorized roots.
- Session data lives exclusively in DSH's official persistence layer.
