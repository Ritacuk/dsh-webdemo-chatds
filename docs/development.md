# Development

## Layout

| Path | Role |
| --- | --- |
| `packages/chat-shared` | Wire protocol core: Rich request/response types, SSE parsing, content-block merging, DSH block mapping. Bundled into both host and client. |
| `packages/chat-main` | The plugin: Cordis host (`src/host/`), hand-written client bootstrap (`client.js`), React page (`client/`), published npm package `dsh-webdemo-chatds`. |
| `packages/chat-sidecar` | Agent side-chat component scaffold (bundle row disabled by default). |

## Build & test (verified on Node 22 / Linux)

```bash
pnpm install
pnpm --filter @dsh-chat/shared run build    # FIRST: the protocol core (client typecheck depends on its output)
pnpm -r run typecheck                       # all packages
pnpm -r run test                            # shared 21 + main 126 + sidecar 3
pnpm --filter dsh-webdemo-chatds run build  # host bundle (tsdown) + client page (rspack)
cd packages/chat-main && pnpm pack --pack-destination ../../dist-packages
```

The host build (`tsdown`) injects the current git commit into the Health endpoint; the built lib targets `node22`. `client.js` is a hand-written CommonJS factory registered through DSH's `window.__ModuleLoader__` protocol — it is not processed by rspack and ships as-is.

## Plugin metadata

`packages/chat-main/package.json` carries the `dsh` field:

- `bundle.patch` — `cordis.patch.yml` inserting the `chatds-main` component (page `/chat-workspace`) and the disabled `chatds-sidecar` row.
- `client` — web platform, injected modules, `immediately: true`.

All `@deepseek-ai/dsh-*` packages are **peer** dependencies with the range `>=0.2.2-rc.3 <0.2.3-0`; the devDependencies pin rc.5 for compilation. Keep this split — runtime packages installed as real dependencies get disabled by DSH's version gate on mismatched hosts.

## Testing in an isolated DSH profile

```bash
export DSH_HOME=/tmp/dsh-iso-home
dsh plugin --profile webchat-iso add ./dist-packages/dsh-webdemo-chatds-<version>.tgz
node <path-to-dsh>/lib/bin.js --profile webchat-iso --port 3091 --no-open
# open http://127.0.0.1:3091/?token=<printed token>
```

The isolated profile starts with only `@deepseek-ai/dsh-base` + the plugin; add `@deepseek-ai/dsh-web-app` to the profile's `dsh.profile.bundles` (bundle rows resolve from the global DSH installation — do not install it as a profile dependency) when you need the full web UI stack.

## Acceptance history

- R8.2 (Windows Desktop, DSH 44.7.0 / runtime rc.5): 125 host unit tests, native UI regression, desktop acceptance — internal round.
- R8.3 (Linux DSH Web, DSH 0.2.2-rc.3 / Node 22): 150 tests, real-model round-trip via account token, settings/file-authorization/session persistence across restarts, uninstall/reinstall — the round that produced the first public release.
