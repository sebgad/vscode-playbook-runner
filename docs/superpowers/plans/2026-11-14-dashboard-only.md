# Dashboard only, no sidebar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the sidebar tree and move every action it had into the dashboard, opened from a status bar item.

**Architecture:** New webview message types are parsed and resolved in `src/model.js` (vscode-free, tested). `src/dashboard.js` turns a resolved message into a node built from discovery's objects and calls the existing command functions (`vaultCommand`, `rekeyVaultsCommand`, `createServiceSkeleton`, `rerunLast`), passed in through `DashboardDeps`. The tree, its view container and its menus are deleted.

**Tech Stack:** as before. Plain CommonJS + JSDoc, `node:test`, webview with VS Code theme variables.

**Spec:** [docs/superpowers/specs/2026-11-14-dashboard-only-design.md](../specs/2026-11-14-dashboard-only-design.md). Also read `.claude/skills/vscode-extension/SKILL.md`.

## Global Constraints

- No build step, no runtime dependency. `npm run check` passes after every task.
- Every webview message is rebuilt field by field and matched against the model by exact string. A node handed to a command is built from discovery objects in the extension, never from message fields.
- The status bar launcher's text is `$(run-all) Playbook Runner`, with ` · N running` appended while N > 0. Clicking it runs `playbookRunner.openDashboard`.
- With no view left to activate on, `activationEvents` gains `onStartupFinished`, so the launcher is there without opening anything first.
- Commit on `main`, staging only the task's files, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A vault message naming a service of another environment, or a made-up `vaultFile`.** It resolves only to the service in the named environment, and the file always comes from the model. Test: Task 1, `resolveVaultRequest rejects`.
2. **`create` on a service that already has a vault, or `edit` on one without.** Refused, rather than overwriting or opening nothing. Test: Task 1, same test.
3. **`createService` / `rekey` naming a folder or environment that isn't open.** Refused. Test: Task 1, `resolveFolderRequest` and `resolveEnvironmentRequest`.
4. **Startup without the view.** The launcher appears after VS Code starts, without the user opening anything. Checked by hand (F5 checklist), because it depends on activation.
5. **Services that only have `group_vars` (`all`).** Listed, with Env and Vault actions and no playbook cards. Test: Task 1, model includes them with `vaultFile`. Rendering checked in the Task 3 headless render.

---

### Task 1: Model and message checks for the new actions

**Files:** modify `src/model.js` and `test/model.test.js`.

**Interfaces — produces:**
- `ModelService` gains `vaultFile: string | null`: the vault path whenever the service has a `group_vars` directory, whether the file exists or not. `hasVault` already exists.
- `WebviewMessage` gains:
  - `{ type: "vault", folder, environment, service, action: "edit" | "create" }`
  - `{ type: "rekey", folder, environment }`
  - `{ type: "createService", folder }`
  - `{ type: "rerunLast" }`
  - `{ type: "openSettings" }`
- `resolveVaultRequest(model, message) → { folder: ModelFolder, environment: ModelEnvironment, service: ModelService } | null`. It requires `service.vaultFile`, `edit` ⇒ `hasVault`, and `create` ⇒ `!hasVault`.
- `resolveEnvironmentRequest(model, folderPath, environmentName) → { folder, environment } | null`
- `resolveFolderRequest(model, folderPath) → ModelFolder | null`

- [ ] **Step 1: Write failing tests.** Use the existing fixture: staging `app` has `env.yml` and `vault.yml`, production `app` has no group_vars. Add `inventories/staging/group_vars/all/env.yml` (a vars-only service).
  - `the model lists a vars-only service with its vault path`: staging services include `all`, with `playbooks: []` and `vaultFile` ending `group_vars/all/vault.yml`. Its `hasVault` is `false`. Production `app.vaultFile === null`.
  - `parseWebviewMessage accepts the new types and rejects a bad action`: each of the five shapes round-trips. `action: "delete"` → `null`. A missing `service` → `null`.
  - `resolveVaultRequest rejects`: these all return `null`:
    - service `app` in `production` (no vars);
    - unknown service;
    - `create` on staging `app` (vault exists);
    - `edit` on staging `all` (no vault);
    - unknown folder.

    `edit` staging `app` → a triple whose `service.vaultFile` is the model's.
  - `resolveEnvironmentRequest` / `resolveFolderRequest`: known → object, unknown → `null`.
- [ ] **Step 2: Run** `node --test test/model.test.js`. Expected: FAIL (missing exports / fields).
- [ ] **Step 3: Implement** in `src/model.js`.
- [ ] **Step 4: Run** `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit**, with the message `Model the dashboard's vault, rekey and service actions`.

### Task 2: Wire the actions and remove the tree

**Files:**
- Modify: `src/dashboard.js`, `extension.js`, `package.json`.
- Delete: `src/tree.js`.

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `DashboardDeps` gains `actions: { vault(node, action), rekey(node), createService(node), rerunLast() }`. `node` is a `CommandNode` built in `dashboard.js` from `workspaceFolderAt(...)`, `findEnvironments(...)` (re-found by name) and the model service's `vaultFile` / `hasVault`.
  - The outline reply gains `tags: PlaybookTag[]` (`findPlaybookTags`).
  - `openSettings` runs `workbench.action.openSettings` with `"playbookRunner"`.

- [ ] **Step 1: Implement the new message handling in `DashboardPanel.receive`.** Each message goes through Task 1's resolver; a `null` means the message is dropped.
- [ ] **Step 2: Remove the tree from `extension.js`:**
  - `createTreeView`, the tree provider and its badge, `updateEnvironmentContext`, and the `refresh` → provider wiring. Watchers now only refresh the dashboard.
  - The registrations of `playbookRunner.runPlaybookTag`, `openPlaybook`, `openEnv` and `refresh`.
- [ ] **Step 3: Add the launcher.** A `DashboardLauncher` status bar item (left, priority 11) whose text follows the constraint. It updates on `tracker.onDidChange` and is disposed with the extension.
- [ ] **Step 4: Edit `package.json`:**
  - remove `viewsContainers`, `views`, `viewsWelcome` and the `view/title` / `view/item/context` menus;
  - remove the four commands' contributions and their `commandPalette` entries;
  - add `onStartupFinished` to `activationEvents`;
  - change the `description` from "sidebar" to "dashboard".
- [ ] **Step 5: Run** `npm run check` and `grep -rn "tree\b\|TreeItem\|playbookRunnerExplorer" extension.js src package.json`. Expected: PASS, and no hits.
- [ ] **Step 6: Commit**, with the message `Drop the sidebar; the dashboard runs every action`.

### Task 3: The dashboard page

**Files:** modify `media/dashboard/main.js` and `media/dashboard/style.css`.

- [ ] **Step 1: Implement:**
  - **Service list:** show services with playbooks *or* `vaultFile`. A vars-only service shows `env / vault` instead of a time.
  - **Service header:** the `env.yml` link, then **Edit vault** (`lock`) or **Create vault** (`add`), sending `vault`.
  - **Top bar:** next to the environment tabs, **Rekey vaults** (`key`, sends `rekey` for the chosen environment), **New service…** (`new-folder`, sends `createService`) and **Re-run last** (`debug-rerun`, sends `rerunLast`).
  - **Card header:** a ▶ button (title "Run now, no options") sending `run` with `options: {}`. The click must not toggle the card.
  - **Expanded card:** a **Tags** line above the plays, from the outline reply's `tags`. Each tag has ▶ (sends `run` with `{ tags: tag }`), and clicking the chip toggles it in `--tags`.
  - **Empty state** (no environments): an explanation naming `playbookRunner.inventoriesDir` / `inventoryFile`, plus **Open Settings** and **New service…** buttons.
- [ ] **Step 2: Verify.**
  - `npx eslint media/dashboard/main.js`, and `tsc --strict` with the DOM lib against `main.js` (as in the earlier plan). Expected: clean.
  - Headless chromium render with the real repo model: dark theme on staging with `all` selected, and the `authentik` card expanded. Check that the Tags line, the vault button and the top bar buttons are visible and nothing overlaps.
- [ ] **Step 3: Commit**, with the message `Bring the sidebar's actions into the dashboard page`.

### Task 4: Docs

**Files:** `README.md`, `CHANGELOG.md`, `workflow.md` (step 19), `.claude/skills/vscode-extension/SKILL.md`.

- [ ] **Step 1: Update the docs.**
  - README: replace the tree sketch and bullets with the dashboard and the launcher.
  - SKILL: replace the *Adding a tree node* recipe and the `contextValue` list with *Adding a dashboard action*: parse and resolve in `model.js` with a test, build the node in `dashboard.js`, call the existing command. Drop `tree.js` from the editor-surface list.
  - workflow step 19: why the tree went, and that step 16's "beside the tree" no longer holds.
  - CHANGELOG entry.
- [ ] **Step 2: Run** `npm run check && npm run package`. Expected: PASS; `unzip -l` shows no `src/tree.js`.
- [ ] **Step 3: Commit**, with the message `Document the dashboard-only extension`.
