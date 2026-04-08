# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start              # Run the CLI (same as: easy-devops / ezz)
npm run dashboard      # Run the dashboard server directly (port 6443)
npm run system-info    # Print detected system info and exit
```

No build step, no transpilation, no test suite. This is pure ESM Node.js — files run directly.

## Architecture

### Two entry points, one shared core

```
src/
  cli/           ← interactive terminal app (inquirer menus)
  dashboard/     ← Express + Socket.io web app (EJS + Vue 3 CDN)
  core/          ← shared logic used by both
```

**`src/core/`** is the source of truth for everything:
- `db.js` — SQLite via `good.db`. DB lives at `~/.config/easy-devops/easy-devops.sqlite` (Linux) or `%APPDATA%\easy-devops\easy-devops.sqlite` (Windows), never inside the package folder.
- `config.js` — loads/saves the `'config'` key from SQLite. Always merge with defaults so new fields survive old databases.
- `shell.js` — **all subprocess execution goes through here**. Three functions: `run()` (captures output), `runLive()` (streams to terminal), `runInteractive()` (full stdio inherit, Linux sudo only). Never call `child_process` directly elsewhere.
- `platform.js` — `isWindows`, `getNginxExe()`, `nginxTestCmd()`, `nginxReloadCmd()`, `combineOutput()`, `isNginxTestOk()`. All platform branching for nginx commands lives here.
- `permissions.js` — Linux-only: `findNginxPath()` (via `which nginx`), `checkPermissionsConfigured()`, `setupLinuxPermissions()` (writes `/etc/sudoers.d/easy-devops`).
- `validators.js` — shared input validation (`validateDomainName`, `validatePort`, `validateEmail`, etc.).
- `nginx-conf-generator.js` — builds nginx `.conf` file content from a domain object. Shared between CLI and dashboard.

### CLI (`src/cli/`)

`index.js` is the entry point. It runs `runDetection()` on every loop iteration, renders the banner with `chalk`, then shows a `while(true)` `inquirer` menu.

- `menus/` — thin dispatchers that import managers and call their functions.
- `managers/` — the actual logic: `nginx-manager.js`, `ssl-manager.js`, `domain-manager.js`, `node-manager.js`. These use `run()`/`runLive()`/`runInteractive()` from `core/shell.js`.

### Dashboard (`src/dashboard/`)

`server.js` creates an Express app with EJS templating, `express-session` auth, and a Socket.io server. The socket broadcasts nginx status every 5 seconds to all connected clients.

- `routes/` — REST API handlers: `auth.js`, `domains.js`, `ssl.js`, `nginx.js`, `settings.js`.
- `lib/nginx-service.js` — **all nginx service operations for the dashboard** (start, stop, reload, restart, test, saveConfig). Uses `run()` only (never `runInteractive` — no TTY in dashboard). Uses `sudo -n` for all `systemctl` calls.
- `lib/cert-reader.js` — reads cert files from the filesystem to populate the SSL page.
- `lib/domains-db.js` — reads/writes the `'domains'` key in SQLite.
- `views/` — EJS templates. `index.ejs` is the single-page shell; `partials/` contains page panels.
- `public/js/app.js` — Vue 3 (CDN, no build step) single-file app. All dashboard UI state lives here.

### Critical Linux behaviour

- **`nginx -t` never uses sudo** — it's read-only. But on Linux it exits code 1 after printing "syntax is ok" because it can't write `/run/nginx.pid`. Always check with `isNginxTestOk(result)` from `core/platform.js`, not `result.success`.
- **`systemctl` always uses `sudo -n`** in dashboard code. Requires NOPASSWD sudoers — configured once via `Settings → Linux Permissions`.
- **`runInteractive`** is for CLI only (has a TTY). Dashboard API routes must always use `run()`.

### Data storage

| SQLite key | Contents |
|---|---|
| `config` | dashboardPort, dashboardPassword, nginxDir, sslDir, acmeEmail |
| `system-detection` | cached OS/nginx/node detection results |
| `domains` | JSON array of domain config objects |

SSL certs are on the filesystem under `sslDir` — not in SQLite.
