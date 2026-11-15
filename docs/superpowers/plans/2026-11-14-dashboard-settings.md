# Settings tab in the dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Settings tab in the dashboard that shows and edits every `playbookRunner.*` setting.

**Architecture:** The decisions live in a new vscode-free `src/settingsEdit.js`, with tests: is this value valid for this key, where may it be saved, and which group does it belong to. `src/model.js` parses the two new messages. `src/dashboard.js` reads `inspect()` for each key, posts the result, and writes through `WorkspaceConfiguration.update`. The page renders a type-specific editor per setting.

**Tech Stack:** as before.

**Spec:** [docs/superpowers/specs/2026-11-14-dashboard-settings-design.md](../specs/2026-11-14-dashboard-settings-design.md)

## Global Constraints

- `MACHINE_SETTINGS` = `["vaultPasswordFilePattern", "vaultPasswordFiles", "ansiblePlaybookCommand", "ansibleVaultCommand"]`, always saved to User. The default target for everything else is `"workspace"`.
- Groups, in this order: *Repository layout* (playbooksDir, rolesDir, inventoriesDir, inventoryFile, groupVarsDir, envFileName, vaultFileName); *Running* (ansiblePlaybookCommand, productionPattern, confirmProduction, setupTags); *Vaults* (ansibleVaultCommand, vaultPasswordFilePattern, vaultPasswordFiles); *Services* (serviceEnvironments).
- No value reaches `update()` without `validateSettingValue` passing in the extension. The page's own checks are for display only.
- `npm run check` passes after every task. Commit on `main` with only the task's files and the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` line.

## Review Focus

1. **A message trying to save a machine setting to the workspace** (`target: "workspace"` for `ansiblePlaybookCommand`). It must be written to User. Test: Task 1, `settingTarget forces user`.
2. **An unknown key, or a key from another extension** (`python.defaultInterpreterPath`). Refused, nothing written. Test: Task 1, `validateSettingValue rejects`.
3. **A productionPattern that doesn't compile** (`"(prod"`). Refused with the regex error, not saved. Saving it would silently turn the production confirmation off. Test: Task 1.
4. **Lists and maps with blank or duplicate entries.** Lists are trimmed, blanks dropped and duplicates removed. Map keys and values must be non-empty. Test: Task 1.
5. **Reset on a key that is only at its default.** A no-op, no error. Checked in the dashboard by hand (F5 checklist).

---

### Task 1: Validation, targets and groups (vscode-free)

**Files:**
- Create: `src/settingsEdit.js` and `test/settingsEdit.test.js`.
- Modify: `src/defaults.js` (export `MACHINE_SETTINGS`), `src/model.js` and `test/model.test.js` (two messages).

**Interfaces — produces:**
- `MACHINE_SETTINGS: string[]` in `defaults.js`. It is attached to the exported object as a non-enumerable property, or exported alongside it; whichever way, `{ ...DEFAULTS }` must stay the plain settings object.
- In `settingsEdit.js`:
  - `SETTING_GROUPS: { title: string, keys: string[] }[]`
  - `validateSettingValue(key: string, value: unknown) → { ok: true, value } | { ok: false, error: string }`
  - `settingTarget(key: string, requested: "workspace" | "user") → "workspace" | "user"`
- `WebviewMessage` gains:
  - `{ type: "setSetting", key, value, target: "workspace" | "user" }`, where `value` is passed through as `unknown` and validated later;
  - `{ type: "resetSetting", key, target }`.

- [ ] **Step 1: Write failing tests** in `test/settingsEdit.test.js`:
  - `MACHINE_SETTINGS matches package.json`: the set of keys whose `scope` is `"machine"` under `contributes.configuration.properties`, without the `playbookRunner.` prefix, equals `MACHINE_SETTINGS`.
  - `SETTING_GROUPS covers every setting exactly once`: the flattened keys, sorted, equal `Object.keys(DEFAULTS)` sorted.
  - `validateSettingValue accepts each type`:
    - `("playbooksDir", " plays ")` → `{ok:true, value:"plays"}`
    - `("confirmProduction", false)` → ok
    - `("setupTags", [" a ", "", "a", "b"])` → `{ok:true, value:["a","b"]}`
    - `("vaultPasswordFiles", {staging: "~/s.pass"})` → ok
    - `("productionPattern", "")` → ok (an empty pattern turns the production treatment off, which is allowed)
  - `validateSettingValue rejects`:
    - an unknown key `"nope"`;
    - `"python.defaultInterpreterPath"`;
    - `("confirmProduction", "yes")`;
    - `("setupTags", "a,b")`;
    - `("setupTags", [1])`;
    - `("vaultPasswordFiles", {staging: ""})`;
    - `("vaultPasswordFiles", {"": "x"})`;
    - `("vaultPasswordFiles", ["x"])`;
    - `("productionPattern", "(prod")`: the error contains the regex message;
    - `("playbooksDir", "")`.

    Each returns `ok:false` with a non-empty error.
  - `settingTarget forces user`: `("ansiblePlaybookCommand", "workspace")` → `"user"`, `("playbooksDir", "workspace")` → `"workspace"`, `("playbooksDir", "user")` → `"user"`.

  In `test/model.test.js`: `parseWebviewMessage` accepts both new messages with `target` `"workspace"`/`"user"`, and rejects any other `target` or a non-string `key`.
- [ ] **Step 2: Run** `node --test test/settingsEdit.test.js test/model.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** String settings are trimmed. Only `productionPattern` may be empty (see the test); every other string setting is refused when empty. Use `paths.compileProductionPattern` for the regex check.
- [ ] **Step 4: Run** `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit**, with the message `Validate dashboard setting edits`.

### Task 2: Read and write settings in the dashboard panel

**Files:** modify `src/dashboard.js`.

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - The model message gains `settings: SettingView[]`, where
    `SettingView = { key, group, type: "string" | "boolean" | "list" | "map", description, machine, value, defaultValue, userValue, workspaceValue }`.
    `description` is the `markdownDescription` or `description` from `context.extension.packageJSON`. The values come from `getConfiguration("playbookRunner").inspect(key)`: `globalValue` / `workspaceValue` / `defaultValue`.
  - After every `setSetting` / `resetSetting`, the page gets `{ type: "settingResult", key, error: string | null }`.

- [ ] **Step 1: Implement.**
  - `setSetting`: run `validateSettingValue`; on failure, post the error and stop. Otherwise call `update(key, value, target === "user" ? ConfigurationTarget.Global : ConfigurationTarget.Workspace)`, with the target taken from `settingTarget`.
  - `resetSetting`: `update(key, undefined, …)` at the same target rule.
  - An `update` that throws (for example, no workspace is open) is posted back as the error.
  - The refresh comes from the existing `onDidChangeConfiguration` handler.
- [ ] **Step 2: Run** `npm run check`. Expected: PASS.
- [ ] **Step 3: Commit**, with the message `Read and write settings from the dashboard`.

### Task 3: The Settings tab, and docs

**Files:**
- Modify: `media/dashboard/main.js` and `style.css`.
- Docs: `README.md` (Dashboard section, Configuration intro), `CHANGELOG.md`, `workflow.md` (step 20), and `SKILL.md` (adding a setting now also means a place in `SETTING_GROUPS`).

- [ ] **Step 1: Build the page.**
  - **Tabs:** a `Runs | Settings` tab control at the left of the top bar, kept in the page state. The Runs view is unchanged; Settings replaces the two panes and the run bar.
  - **Groups:** one section per group. Each row shows the key, the description, a source badge (`default` / `User` / `Workspace`, the most specific that is set), and a `machine · saved to User` badge where it applies.
  - **Editors by type:**
    - string: a text field, saved on Enter or blur when it changed;
    - boolean: a checkbox, saved on change;
    - list: chips with ✕, plus an add field (Enter adds);
    - map: rows of environment → path with ✕, plus an add row.
  - **Actions:** each row has **Reset** (shown when the value is set at its target) and, for non-machine settings, **Save to User instead**, which re-sends the current value with `target: "user"`.
  - **Errors:** a `settingResult` with an error appears under the row and keeps the typed value. A success clears it.
- [ ] **Step 2: Verify.**
  - eslint, and `tsc --strict` with the DOM lib against `main.js`.
  - A headless chromium render of the Settings tab with real values: the source badge reads `User` on `ansiblePlaybookCommand`, which the user has set to `.venv/bin/ansible-playbook`.
- [ ] **Step 3: Docs.**
- [ ] **Step 4: Run** `npm run check && npm run package`. Expected: PASS.
- [ ] **Step 5: Commit**, with the message `Add a Settings tab to the dashboard`.
