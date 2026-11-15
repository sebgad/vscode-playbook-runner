# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Playbook Runner is a VS Code extension: a dashboard (webview editor tab) that runs Ansible playbooks — whole, by tag, or a range of tasks — and edits vaults, with environments, playbooks and vaults **discovered from the filesystem** of the open workspace. It was split out of the `homelab-infra` repository (workflow.md step 22), where it lived at `scripts/vscode-extension/`.

For any change to the extension, load the project skill `vscode-extension` (`.claude/skills/vscode-extension/SKILL.md`) — it holds the invariants and the recipes for adding a setting, command, dashboard action or run option. For releases, use `vscode-extension-release`.

## Commands

```bash
npm install                                   # dev tooling only; no runtime dependencies
npm run check                                 # lint + typecheck + tests — must pass before finishing
npm run lint                                  # eslint
npm run typecheck                             # tsc --noEmit over JSDoc types
npm test                                      # node --test (all of test/)
node --test test/command.test.js              # one test file
node --test --test-name-pattern="vault" test/ # tests whose name matches
npm run package                               # dist/playbook-runner-<version>.vsix
```

`test/range-plugin.test.js` runs the real `ansible-playbook` (`.venv/bin/` first, then `PATH`) and skips itself when none is found — a skip there is not a pass.

There is no headless way to run the extension host. `F5` (`.vscode/launch.json`) opens an Extension Development Host on `../homelab-infra`. After UI-facing changes, give the user a manual checklist rather than claiming it works; never run against production or decrypt a vault to test.

## Language and build

Plain CommonJS JavaScript, **no build step** — what is committed is what ships (`"main": "./extension.js"`). Types are JSDoc, checked by `tsc` with `strict` and `noUncheckedIndexedAccess` (`array[0]` is `T | undefined`; handle it, don't cast). `media/dashboard/main.js` is browser code for the webview (eslint treats `media/**` as browser scripts with `acquireVsCodeApi`). `ansible/strategy/playbook_runner_range.py` is an Ansible strategy plugin, not run by the extension directly.

## Architecture

**The vscode boundary.** `src/defaults.js`, `discovery.js`, `command.js`, `paths.js`, `tags.js`, `history.js`, `model.js`, `scaffold.js`, `environments.js`, `inventory.js` (and `settingsEdit.js`) never `require("vscode")`, so `node --test` covers them. Anything that shapes a command line, a path or a decision belongs there, with a test. `extension.js`, `settings.js`, `runner.js`, `pickers.js`, `tracker.js`, `dashboard.js` and `media/dashboard/` are editor surface, verified by hand. Need a vscode type in a pure module? Use a JSDoc `import(...)`, not a require.

**Data flow.** `discovery.js` scans each workspace folder using settings from `defaults.js`/`settings.js` → `model.buildDashboardModel` turns that plus run history into what the page renders → `DashboardPanel` (`src/dashboard.js`) posts it to `media/dashboard/main.js`. Messages from the page are untrusted: `model.parseWebviewMessage` rebuilds them field by field and the `resolve*Request` functions match names by exact string against what the model offered; `dashboard.js` then builds the command node from discovery's objects, never from the message, and calls the same command implementation the palette uses (palette commands fall back to the `pickers.js` QuickPick chain).

**One run path.** Every playbook run — dashboard ▶, tags, run bar, *Re-run Last*, palette — goes through `startPlaybookRun` in `extension.js`: task-range check, production confirmation, last-run record, history (`tracker.js`), then the terminal (`runner.js`). Argument vectors come from `command.js` as argv arrays and are shell-quoted, never concatenated; `test/command.test.js` is the spec of what ansible is invoked with.

**Task ranges travel as env, not argv**: `buildPlaybookEnv` enables the range strategy plugin via `ANSIBLE_STRATEGY`/`ANSIBLE_STRATEGY_PLUGINS` for that one run.

**Refresh**: the `Watchers` class in `extension.js` scopes file watchers to each folder's configured `playbooksDir`/`inventoriesDir` and rebuilds them when folders or `playbookRunner.*` settings change.

## Rules that are easy to break

- No environment name or repository path is hardcoded — `production`, `staging`, `hosts.ini`, `group_vars` are setting defaults. A literal environment name in new code is a bug.
- Anything read back from `workspaceState` reaches a command line: rebuild it field by field (`sanitizeRunOptions`, `parseLastRun`), never spread it.
- Settings naming an executable or password file are `"scope": "machine"` (Ansible executes an executable password file); keep `MACHINE_SETTINGS` in `src/settingsEdit.js` in sync — a test enforces it, as it does that every setting is in one `SETTING_GROUPS` group.
- Terminals are created `hideFromUser` then shown (so the Python extension doesn't type into password prompts), with the workspace folder as cwd (`ansible.cfg` is only read from there).
- `workflow.md` is the design record of accepted trade-offs; don't re-litigate them in a change — raise it with the user.
- A behaviour change updates `README.md` (dashboard sketch, settings table) and adds a `CHANGELOG.md` entry; a design change adds a step to `workflow.md`.
