# Changelog

## 0.5.0

The first release published on the Visual Studio Marketplace and Open VSX
(as a preview). It replaces the sidebar with a dashboard and drops what only
made sense inside the repository it was written for.

### Breaking

* **Renamed from *Homelab* to *Playbook Runner*.** The extension ID is now
  `sebgad.playbook-runner`, so a `.vsix` of the old one has to be uninstalled
  by hand, and the last run and remembered run options — kept per extension
  ID — start empty once. Settings are `playbookRunner.*` and commands
  `playbookRunner.<command>`, with no fallback: `homelab.*` settings and
  keybindings, and the 0.1 names (`homelabTasks.*`), are ignored until
  renamed.
* **The sidebar is gone; the dashboard is the whole UI.** The commands only
  the tree used (*Run Playbook with This Tag*, *Open Playbook*, *Open Env
  File*, *Refresh*) are removed, and playbooks no longer run as VS Code tasks.
  The extension activates on startup, for its status bar item.
* `playbookRunner.setupTags` defaults to `[]` instead of
  `["podman-user-setup"]`, a tag only one repository had. If your task ranges
  relied on it, set it in the workspace's `.vscode/settings.json`:
  `"playbookRunner.setupTags": ["podman-user-setup"]`.

### Dashboard

* *Open Dashboard*, or the `$(run-all) Playbook Runner` status bar item
  (`· N running` while playbooks run), opens an editor tab: environments as
  tabs, services with their last run, playbooks that expand into their tags,
  plays and tasks, and a run bar that shows the exact command line before
  *Run*. A second status bar item shows the newest run and re-runs it on
  click.
* The service list leads each service with what happened to it — ✓ passed,
  ✗ failed, a spinner while running, ⊘ cancelled, ○ never run, and a
  variables icon for services without playbooks — and marks the selected one
  with an accent bar. The runner figure follows the theme, in the page and on
  the editor tab.
* Tag chips say more at a glance: a tag in `--tags` is filled, bold and
  ticked, and a tag whose tasks run without being selected — a
  `playbookRunner.setupTags` tag before a task range, or ansible's `always` —
  is yellow, with the reason in its tooltip. Choosing another service clears
  `--tags`, so tags picked for one service no longer carry over to the next.
* **Settings tab**: every `playbookRunner.*` setting with its description,
  where its value comes from, an editor that fits its type, and *Reset*.
  Saves to the workspace's `.vscode/settings.json` (or *Move to User
  settings*); the four machine settings — the ansible commands and the vault
  password files — always go to User settings. Values are checked before they
  are saved; a `productionPattern` that is not a valid regular expression is
  refused instead of silently switching the production confirmation off.

### Running playbooks

* **Task ranges**: run a playbook *from* a task, *until* a task, or *only*
  one task — from the dashboard or from *Run Playbook with Options…*. A
  strategy plugin shipped with the extension does it; tasks tagged with one
  of `playbookRunner.setupTags` still run before the start. A range whose
  task is not in the playbook, or whose end comes before its start, is
  refused before anything runs, as is one on a playbook with `serial:`. The
  plugin runs on any ansible-core 2.x (tested with 2.21 and 2.22) and refuses
  another major version, or one whose `linear` strategy no longer has the
  method it overrides.
* `--step` is a run option, and *Run Playbook with Options…* is grouped into
  *Scope* and *Output* and stays open when focus moves elsewhere.
* **Playbooks run in a reused *Playbook Runner* terminal.** The Python
  Environments extension typed `source .venv/bin/activate.fish` into new
  task terminals — into the vault password prompt, crashing the run —
  whenever it failed to recognise them in time. Every terminal the extension
  opens is now created hidden and then shown, which that extension leaves
  alone. Exit codes reach the run history through shell integration; Ctrl+C
  stops a run. Requires VS Code 1.93.
* Roles referenced by a path relative to the playbook
  (`../../roles/unattended-upgrades`) are followed, so their tags appear in
  the tag list.

### Services and environments

* **Get started from an empty folder**: the dashboard's "No Ansible
  environments found" page has a *Get started…* button (also *Playbook
  Runner: Get Started…*). It asks for a first environment and service and,
  after one confirmation listing only what is missing, creates `ansible.cfg`
  (left alone if present), `roles/`, a starter playbook, an inventory and an
  empty `group_vars/<service>/env.yml`. The inventory puts `localhost`
  (`ansible_connection=local`) in the service's group, so the starter
  playbook runs straight away instead of matching no hosts. Refused once an
  environment exists.
* **New service… offers a starter playbook**: after the name it asks *Empty
  folder* or *With a starter playbook* (`hosts: <service>`, one `ping` task
  tagged `hello`). It still never adds hosts; if the group has none in an INI
  inventory, the confirmation says so. An existing playbook is never
  overwritten.
* **Environments can be created, renamed and deleted** from the dashboard
  (＋, ✎ and 🗑 beside the environment tabs) and the palette. A new one is
  empty or takes the group structure of an existing one — group names and
  empty env files, never hosts, values or vaults. A rename carries
  `vaultPasswordFiles`, `serviceEnvironments`, the run history and the last
  run along, and says what the new name changes about the production
  confirmation and the vault password file. A delete moves the directory to
  the trash after its name has been typed.
* New setting `playbookRunner.serviceEnvironments`: the environments *Create
  Service Skeleton…* creates `group_vars/<name>/` in. Empty (the default)
  means every environment; a listed name that is not an environment is
  skipped and named in the confirmation, never created.

### Publishing

* MIT licensed. The README now starts with the requirements and the
  repository layout the extension expects; building from source moved to
  `CONTRIBUTING.md`.
* New icon: the running figure from [Tabler Icons](https://tabler.io/icons)
  (MIT), replacing the Ansible logo, which is a Red Hat trademark.

## 0.4.0

* Playbook rows expand into their tags — the same list `⚙ → Tags` offers,
  visible without opening a picker. Each row shows the role the tag came from,
  and `▶` on it runs the playbook with `--tags <that one>` and nothing else,
  which is the everyday single-tag run without three dialogs in front of it.
  Clicking a tag opens the playbook, like the row above it; a playbook whose
  tags were not found stays a leaf rather than opening onto nothing.
* A tagged run is confirmed and remembered like any other: the production
  modal names the tag it is about to run, and *Re-run Last Playbook* repeats
  the run with that tag.
* The *Tags* option under `⚙` is now a checkbox list of the tags that playbook
  actually has, instead of an empty box to type a comma-separated string into.
  They are read out of the YAML — the playbook, everything it
  `import_playbook`s, and the task files of the roles it reaches through
  `roles:`, `import_role` or `include_role` — and listed in the order the run
  reaches them, a play's own tags above the ones inside the roles it imports,
  each of the latter labelled with the role it came from.
* Not `ansible-playbook --list-tags`, which is the authoritative answer but
  needs the inventory, the vault passphrase and a second or two of ansible
  start-up: three reasons for the list not to be there the moment the item is
  ticked. `src/tags.js` is therefore a line scanner rather than a YAML parser —
  the extension still has no runtime dependencies — which skips a tag built out
  of a variable and could miss an unusual layout. So the list ends in *Other…*,
  which hands over to the free-text box seeded with whatever is ticked, and a
  playbook with no tags found goes straight to that box, exactly as before.
* A tag that was ticked last time and is no longer in the playbook stays in the
  list, ticked and marked, rather than dropping out of the next run unnoticed.
* New setting `homelab.rolesDir` (default `roles`) — `ansible.cfg`'s
  `roles_path`, which is what the tag scan follows role references into. The
  roles directory was the last piece of this repository's layout the extension
  did not have a setting for.

* *Homelab: Rekey Vaults…* (`homelab.rekeyVaults`, and the context menu of an
  environment row) rotates the passphrase of every vault in one environment
  through a single `ansible-vault rekey`. One environment per invocation: the
  passphrase is per environment, so rekeying across all of them at once could
  only mean typing the wrong one into the wrong files.
* The new passphrase is never passed as an argument —
  `--new-vault-password-file` is deliberately omitted so ansible prompts for it,
  keeping it out of the process table and the shell history. A resolved
  `vaultPasswordFiles` entry is passed as the *current* passphrase only, and the
  confirmation points out that the file still holds the old one afterwards.
* The confirmation is shown in every environment, not just production, and warns
  that a run failing part-way leaves the vaults split between the two
  passphrases. Production still asks a second time.
* *Homelab: Create Service Skeleton…* (`homelab.createService`, the ＋ folder
  button in the view title) lays out a new service in one go: `playbooks/<name>/`
  and a `group_vars/<name>/` holding an empty env file in **every** environment.
  A service that exists in one environment and is missing from another is the
  drift this removes, so the command takes no environment and is not offered on
  an environment row.
* The paths are listed for confirmation before anything is written, and only
  what is missing gets created: files are opened `wx`, so an `env.yml` that is
  already there is never overwritten and running the command again on the same
  name simply fills the gaps.
* No `vault.yml` is created — an encrypted file is `ansible-vault create`'s job,
  which the new group_vars directory offers on its ＋ *Vault* row.
* The path and name rules live in `src/scaffold.js`, which imports no `vscode`
  for the same reason the other four such modules do not: `test/scaffold.test.js`
  covers what ends up on disk.

## 0.3.0

* Clicking a playbook row opens the file in the editor instead of running
  it; running moved to the row's inline `▶` and `⚙` buttons.
* Activity bar icon is the Ansible mark.
* npm environment: `npm run lint` (ESLint 9), `npm run typecheck` (tsc over the
  JSDoc types), `npm test` (node:test), `npm run package` (`.vsix` into `dist/`).
* The extension declares itself unsupported in untrusted and virtual
  workspaces, and the settings naming an executable or a vault password file
  (`ansiblePlaybookCommand`, `ansibleVaultCommand`, `vaultPasswordFilePattern`,
  `vaultPasswordFiles`) are now `machine` scope, so a repository's
  `.vscode/settings.json` can no longer decide what gets run.
* Playbook task arguments are passed to the shell with explicit strong
  quoting instead of relying on VS Code's default.
* Vault commands get their own terminal per run, so a second vault action can
  no longer type into the `nano` a previous one left open. The terminal takes
  focus now, since the command starts by asking for the password, and finished
  ones are closed when the next vault command runs.
* File watchers are rebuilt when `homelab.playbooksDir` or
  `homelab.inventoriesDir` changes.
* Playbook discovery no longer follows symlink cycles.
* The pure path helpers moved out of `src/settings.js` into `src/paths.js`, so
  they are covered by the plain-node tests.

## 0.2.0

* Environments, playbooks and vaults are discovered from the filesystem; the
  tree became environment → service → Playbooks / Env / Vault.
* Playbooks run as a `vscode.Task`, vaults in a terminal.

## 0.1.0

* First version: a flat tree over the entries in `.vscode/tasks.json`.
