# Installation

All commands below were executed on real DSH installations. Linux commands verified on DSH 0.2.2-rc.3 (Node 22, Linux Mint); Windows Desktop steps verified at R8.2 on DSH Desktop 44.7.0 (bundled runtime 0.2.2-rc.5).

## Before you start

- DeepSeek Harness installed; `dsh` available on PATH (or use the full path to the CLI).
- Know your target **profile** name. The default web profile on Linux is `web` (`dsh --profile web`). Plugin installs are per-profile.
- Recommended: test in an isolated profile first:

  ```bash
  dsh plugin --profile webchat-test add dsh-webdemo-chatds@0.12.1
  ```

  The profile is initialized on first use; remove it by deleting `$DSH_HOME/profiles/webchat-test`.

> **Version gate**: DSH validates the plugin's peer requirements against its own version at install time. WebChat declares `>=0.2.2-rc.3 <0.2.3-0` for the DSH runtime packages and `>=4.0.5 <5` for cordis. If your DSH is outside these ranges the install is rejected with an explanatory error — upgrade DSH or pick a matching plugin version.

## Linux DSH Web

```bash
# 1. Install into the running profile (official plugin manager):
dsh plugin --profile web add dsh-webdemo-chatds@0.12.1      # from npm
# or, from a downloaded release tarball:
dsh plugin --profile web add ./dsh-webdemo-chatds-0.12.1.tgz

# 2. Restart the DSH web service so the new plugin is loaded.
#    If you run DSH under systemd (user service), the usual way:
systemctl --user restart <your-dsh-service>.service
#    Under a watchdog/supervisor, terminate the web process and let it restart.
#    Verify afterwards:
curl -s http://127.0.0.1:3080/ -o /dev/null -w '%{http_code}\n'   # 401 (token-gated) = alive

# 3. In the web UI: the sidebar now has a "WebChat" entry.
#    Health check (cookie-authenticated): /chat-workspace/api/health
#    → {"ok":true,"plugin":"dsh-webdemo-ChatDS","version":"0.12.1","commit":"..."}
```

Notes for headless servers: the settings page's file-access section always offers a **manual absolute-path grant** (Host-validated) — use it when DSH's directory picker cannot open a GUI dialog.

## Windows Desktop

1. Download the release tarball (or install from npm inside the DSH runtime shell).
2. Open DSH → 插件 (Plugins) → 添加插件 → install the tarball, or use the runtime CLI:

   ```bat
   set "DSH=<path-to-DSH-runtime>\resources\runtime\cli\bin\dsh.cmd"
   "%DSH%" plugin --profile <profile> add dsh-webdemo-chatds@0.12.1
   ```

3. Restart DSH Desktop. The sidebar shows "WebChat".

## Verify the install

1. Sidebar shows the **WebChat** panel and the ⚙ settings launcher.
2. DSH settings → ChatDS settings: eight sub-pages (常规/模型/提示词/用量与费用/插件与工具/文件/数据管理/外观) render.
3. Open the panel; the model picker lists your DSH models.
4. Send one short message; a reply (or an explicit credential/setup error) appears, and a session entry persists in the sidebar after restart.

For device sync passwords and Windows LAN permissions, see the [data sharing guide](sharing-setup.md). Changing LAN permissions while DSH is running updates the ChatDS listener.

## Upgrade

```bash
dsh plugin --profile web add dsh-webdemo-chatds@0.12.1   # same command installs the new version
```

Then restart the DSH web service again. User settings and authorized directories live in DSH's storage (per profile) and survive upgrades.

## Uninstall / rollback

```bash
dsh plugin --profile web remove dsh-webdemo-chatds      # official manager; bundle row removed
```

Restart the DSH web service. Sessions created through WebChat remain in DSH's session storage (they are ordinary DSH sessions with `chatws-` ids) and can be deleted from the DSH UI if desired. To roll back a bad release, `pnpm pack` an older tag and install it the same way — npm versions cannot be overwritten, only superseded.
