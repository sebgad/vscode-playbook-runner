# Playbook Runner — Settings tab in the dashboard

Status: design, awaiting approval (2026-11-14)

## Why

The dashboard is the whole UI now. Changing a `playbookRunner.*` setting still
means VS Code's Settings editor or hand-editing JSON. A Settings tab puts all
15 settings next to the thing they change.

## Decided

- **Saving:**
  - The 11 settings that can live in a workspace are saved to this
    repository's `.vscode/settings.json` (ConfigurationTarget.Workspace) by
    default. Each row has a **Save to User instead** action.
  - The 4 `machine`-scoped settings (`ansiblePlaybookCommand`,
    `ansibleVaultCommand`, `vaultPasswordFilePattern`, `vaultPasswordFiles`)
    always go to User settings, and the row says so. That is the existing
    invariant: a repository must never be able to point them at something to
    execute.
- **What each row shows:** the setting's description (from `package.json`),
  its effective value, and **where that value comes from** (default / User /
  Workspace, via `inspect()`). **Reset** removes the value where it is set.

## Design

- **Tabs.** The top bar gets **Runs | Settings**. The tab choice is kept in the
  page state.
- **Groups:**
  - *Repository layout*: playbooksDir, rolesDir, inventoriesDir,
    inventoryFile, groupVarsDir, envFileName, vaultFileName.
  - *Running*: ansiblePlaybookCommand, productionPattern, confirmProduction,
    setupTags.
  - *Vaults*: ansibleVaultCommand, vaultPasswordFilePattern,
    vaultPasswordFiles.
  - *Services*: serviceEnvironments.
- **Editors by type:**
  - string: a text field, saved on Enter or blur;
  - boolean: a checkbox;
  - string list: chips with ✕ plus an add field;
  - `vaultPasswordFiles`: rows of environment → path, with add and remove.

  An invalid value shows its error inline and is not saved.
- **Checks: a new vscode-free `src/settingsEdit.js`, with tests.**
  - `validateSettingValue(key, value)`: the key must be a known setting. The
    runtime type must match the default, as `settings.js` already requires.
    List items must be non-empty strings, trimmed and de-duplicated. Map keys
    and values must be non-empty strings. `productionPattern` must compile as
    the extension compiles it.
  - `settingTarget(key, requested)`: a `machine` setting is always `"user"`.
  - `MACHINE_SETTINGS` lives in `defaults.js`. A test asserts it matches the
    `"scope": "machine"` entries in `package.json`, so the two can't drift.
- **Messages:** `setSetting {key, value, target}` and
  `resetSetting {key, target}`. They are parsed in `model.js`, then validated,
  then written by `dashboard.js` with
  `getConfiguration("playbookRunner").update(...)`. The model posted to the
  page gains a `settings` list (key, group, type, description, machine,
  effective / default / user / workspace values). A save fires
  `onDidChangeConfiguration`, which already rebuilds the watchers and
  refreshes the dashboard.

## Non-goals

- Folder-level settings in a multi-root workspace. None of these settings is
  `resource`-scoped, so VS Code wouldn't accept them there.
- Settings of other extensions, such as the Python Environments one.
