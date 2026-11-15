---
name: vscode-extension
description: Working on the Playbook Runner VS Code extension — the Ansible dashboard that discovers environments, playbooks and vaults from the filesystem. Use when changing extension.js, src/*.js or media/dashboard/, adding a setting, command, dashboard action or picker, writing its tests, or debugging why the dashboard shows the wrong thing. Examples - "add a --step option to the run picker", "the dashboard doesn't refresh when I add a playbook", "make the vault button show who last edited it".
---

# The Playbook Runner VS Code extension

This repository is a VS Code extension written in plain CommonJS
JavaScript with **no build step** — what is committed is what ships. Types are
JSDoc, checked by `tsc --noEmit` under `strict`.

Read [README.md](../../../README.md) for what it does
and [workflow.md](../../../workflow.md) for why it is
built this way; workflow.md is the design record, including the trade-offs that
were accepted deliberately. Do not re-litigate those in a change — if you think
one is wrong, say so and let the user decide.

## The one boundary that matters

These modules **never `require("vscode")`**:

| Module | Owns |
| --- | --- |
| `src/defaults.js` | the default and the runtime type of every setting |
| `src/discovery.js` | filesystem scanning: environments, playbooks, group_vars |
| `src/command.js` | the ansible argument vectors, task-range env and checks, shell quoting |
| `src/paths.js` | `${...}` expansion, vault password resolution, production pattern |
| `src/tags.js` | the tag list and the task outline, read out of the YAML |
| `src/history.js` | the run history: parsing, pass/fail, range verdicts |
| `src/model.js` | the dashboard model and the checks on every webview message |
| `src/scaffold.js` | the files *Create Service Skeleton* writes |
| `src/environments.js` | creating, renaming and deleting an environment: the plans, the inventory group skeleton |

That is what lets `node --test` cover everything that decides what ends up on an
`ansible-playbook` command line. **Any logic that shapes a command line, a path
or a decision goes in one of these, with a test.** The rest —
`extension.js`, `src/settings.js`, `src/runner.js`,
`src/pickers.js`, `src/tracker.js`, `src/dashboard.js` and the page in
`media/dashboard/` — is editor surface: it reads config, renders nodes and asks
questions, and is verified by hand.

If a helper you are writing needs `vscode` only for a type, use a JSDoc import
(`@param {import("./discovery").Environment}`) rather than a require.

## Invariants

- **No environment name and no repository path is written down anywhere.**
  `production`, `staging`, `hosts.ini`, `group_vars` are settings with defaults
  in `defaults.js`, resolved against the filesystem. Dropping in
  `inventories/lab/hosts.ini` must produce a third environment with no code
  change. A literal environment name in a new line of code is a bug.
- **Arguments are argv arrays, never concatenated strings.** The runner
  terminal's line is built by `command.buildTerminalCommand`, the vault
  terminal's by `command.shellQuote`; both quote every argument. A playbook called `it's a test.yml` must stay a
  filename.
- **Anything read back from `workspaceState` is untrusted.** It is JSON that
  survived a restart and every field of it reaches a command line — rebuild it
  field by field (`sanitizeRunOptions`, `parseLastRun`), never spread it.
- **Every playbook run goes through `startPlaybookRun`** in `extension.js` —
  the dashboard's ▶, tag ▷ and run bar, *Re-run Last* and the palette alike: task-range check,
  production confirmation, last run, history, then the task. The dashboard
  page decides nothing that reaches ansible; its messages are rebuilt by
  `src/model.js` and matched against what the model offered.
- **Task ranges are env, not argv.** `buildPlaybookEnv` switches on the
  strategy plugin in `ansible/strategy/` for that one run.
  `test/range-plugin.test.js` runs it with the real ansible-playbook on
  `localhost,` debug-only playbooks — the one place a test runs ansible, and
  the signal when an ansible-core upgrade breaks the plugin.
- **Two execution paths, on purpose.** Playbooks run in a reused
  `Playbook Runner` terminal through shell integration (real tty for
  `--ask-vault-password` and `become`, exit code for the history). Vaults run
  in a terminal of their own, because `ansible-vault edit` spawns `$EDITOR`
  (nano, per `ansible.cfg`) and wants a terminal it owns. Both use the
  workspace folder as cwd: `ansible.cfg` is only read from the working
  directory and its `roles_path` is relative.
- **Every terminal the extension opens is created `hideFromUser` and then
  shown.** The Python Environments extension types an activate command into
  any other new terminal, straight into a password prompt or nano. Not
  `vscode.Task`: its terminals are only sometimes recognised in time.
- **The argument vectors are asserted in `test/command.test.js`.** The shell
  scripts they were once derived from (`run-ansible-playbooks.sh`,
  `edit-ansible-vaults.sh`, `create-ansible-vaults.sh`) have been removed — the
  extension is the only front end, so those tests are the sole spec of what
  ansible gets invoked with. Changing a flag means updating them.
- **Settings that name an executable or a password file are `machine` scope**
  (`ansiblePlaybookCommand`, `ansibleVaultCommand`, `vaultPasswordFilePattern`,
  `vaultPasswordFiles`). Ansible *executes* a password file that happens to be
  executable, so a repository's `.vscode/settings.json` must not be able to
  point it anywhere. Any new setting naming something that gets run inherits
  this.

## Recipes

**Adding a setting** — three places, in this order:

1. `src/defaults.js`: key + default. The default's runtime type *is* the
   validation — `settings.js` rejects a configured value whose `typeof` differs.
   Add the property to the `Settings` typedef.
2. `package.json` → `contributes.configuration.properties`, with a
   `description` (or `markdownDescription`), and `"scope": "machine"` if it
   names something executable.
3. Its place in `SETTING_GROUPS` (`src/settingsEdit.js`), which orders the
   dashboard's Settings tab — a test fails until every setting is in exactly
   one group. A `"scope": "machine"` setting also goes into
   `MACHINE_SETTINGS` there; another test keeps the two lists equal.
4. The table in `README.md`.

**Adding a command** — likewise:

1. `contributes.commands` in `package.json` (`category: "Playbook Runner"`, a codicon).
2. Add `contributes.menus.commandPalette: { when: false }` for a command that
   only makes sense with a node argument. There is no view, so there are no
   `view/*` menus; the dashboard reaches commands through a message (below).
3. `register(...)` in `activate()` in `extension.js`, inside the single
   `context.subscriptions.push(...)`.
4. Commands take an optional node argument and fall back to the picker chain
   when invoked from the palette — run through `asCommandNode` and
   `resolveContext`, never trust the argument's shape.
5. Renaming a command id keeps the old one registered as an alias by default.
   The `homelab.*` → `playbookRunner.*` rename was a deliberate clean break
   (workflow.md step 15), so no alias exists to copy from.

**Adding a dashboard action**:

1. A message type in `parseWebviewMessage` (`src/model.js`), rebuilt field by
   field, and a resolver that matches its names against the model by exact
   string. Both get a test in `test/model.test.js`, including the messages it
   must refuse.
2. In `DashboardPanel.receive` (`src/dashboard.js`), build the command node
   from discovery's objects (`discovered()`), never from the message, and call
   the existing command through `DashboardDeps.actions`. One implementation per
   action, shared with the palette.
3. The button in `media/dashboard/main.js`. Use only `--vscode-*` colours;
   anything that would lead nowhere is not rendered (no vault button without a
   `group_vars` directory).

**Adding a run option**: `RunOptions` typedef and `sanitizeRunOptions` in
`command.js`, the flag in `buildPlaybookArgs`, an item in `pickRunOptions`
(`src/pickers.js`), a test in `test/command.test.js`. The picker pre-fills from
the last run of the *same* playbook.

**Refresh**: the `Watchers` class in `extension.js` scopes `FileSystemWatcher`s
to each folder's configured `playbooksDir` and `inventoriesDir` and rebuilds
them when the folder list or a `playbookRunner.*` setting changes —
a watcher left on last session's directory silently stops refreshing.

## Tests

`node --test`, `describe`/`it` from `node:test`, `node:assert/strict`. Fixtures
are built in a temp directory by `makeFixture` in `test/helpers.js` from a list
of relative paths (a trailing `/` makes an empty directory) and removed in
`after` — nothing is committed. Use `required()` from the helpers instead of
letting a failed `find` throw on the next line.

Cover the awkward cases, as the existing tests do: a directory without an
inventory file, `.yaml` as well as `.yml`, loose playbooks in the `(root)`
group, symlink cycles, missing directories, a vault without an env file, and
per-environment differences.

## Before you finish

```bash
npm run check     # eslint + tsc --noEmit + node --test
```

All three must pass. `npm install` first if `node_modules/` is absent; it brings
in dev tooling only — the extension itself has no runtime dependencies, which is
why `npm run package` passes `--no-dependencies`.

Typecheck runs with `strict` and `noUncheckedIndexedAccess`, so `array[0]` is
`T | undefined` — handle it, do not cast it away.

## What you cannot verify

There is no headless way to run the extension host. After a UI-facing change,
hand the user the F5 checklist rather than claiming it works: what the
dashboard should show, which command to invoke, and — for anything touching the run
path — a dry run that does not touch a host, e.g. `⚙ → Check` on a playbook
against `staging`.

Never run a playbook against production to test a change, and never decrypt or
print a vault.

## Keeping the docs true

A behaviour change touches `README.md` (the dashboard sketch, the settings table) and
adds a `CHANGELOG.md` entry under the current version. A change to the
*design* — a module boundary, an execution path, an accepted trade-off — belongs
in `workflow.md`, whose numbered sequence is a record of what was done and why,
not a plan to tick off.
