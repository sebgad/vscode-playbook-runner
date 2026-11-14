# Playbook Runner

A VS Code sidebar and dashboard for running this repository's Ansible
playbooks — whole, by tag, or a range of their tasks — and editing its vaults. Environments, playbooks and vaults are **discovered from the
filesystem** — no path and no environment name is written down in the
extension, so adding `inventories/lab/hosts.ini` or a new folder under
`playbooks/` shows up without touching any code or config.

The tree is **environment → service → Playbooks / Env / Vault**, with a
playbook's tags one level below it. A service is `playbooks/<name>/` and
`group_vars/<name>/` shown as one thing, so everything belonging to e.g.
`authentik` sits in one place per environment. A service has
one `env.yml` and one `vault.yml`, so those are rows that act on click rather
than folders to open.

```
Playbook Runner (activity bar)
├── production                       ← red: matches playbookRunner.productionPattern
│   ├── authentik               1
│   │   ├── Playbooks           1
│   │   │   └── ▶ authentik.yml     ← click opens it, ▶ / ⚙ run it
│   │   │       ├── ⌗ deploy-app                       ← ▶ runs only this tag
│   │   │       ├── ⌗ nginx-reverse-proxy
│   │   │       └── ⌗ podman-kube-start  podman/deploy-app  ← where it came from
│   │   ├── ⌥ Env                    ← opens group_vars/authentik/env.yml
│   │   └── 🔒 Vault                 ← ansible-vault edit
│   ├── dns_servers             5 · no vault
│   │   ├── Playbooks           5
│   │   │   ├── ▶ setup-bind9.yml
│   │   │   └── ▶ setup-dns-zones.yml
│   │   ├── ⌥ Env
│   │   └── ＋ Vault            create ← ansible-vault create
│   └── all                             ← group_vars only
│       ├── ⌥ Env
│       └── 🔒 Vault
└── staging
    └── …
```

* A service needs only one of the two halves. `group_vars/all` has no
  playbooks and shows only *Env* / *Vault*; a playbook folder the environment
  has no variables for shows only *Playbooks*. Rows that would lead nowhere
  are left out entirely — no *Env* row without an `env.yml`.
* Because variables are per environment and playbooks are not, the same
  service can look different under `production` and `staging`.
* **Click a playbook** to open the file in the editor. `▶` on the row runs it
  against that environment, `⚙` asks first: tags, a task range (*From task* /
  *Until task*, see [Running part of a playbook](#running-part-of-a-playbook)),
  `--limit`, verbosity, `--check`, `--diff` and `--step`. Tags are a checkbox list of the tags that playbook
  actually has — see [Where the tag list comes from](#where-the-tag-list-comes-from).
* **Expand a playbook** for those same tags as rows, in the order the run
  reaches them, each showing the role it came from. `▶` on a tag row runs the
  playbook with `--tags <that one>` and nothing else — the everyday
  "just redeploy the app" run without going through `⚙` first. Clicking a tag
  opens the playbook, like the row above it. A playbook whose tags were not
  found has no arrow.
* **Click Env** to open the plain, unencrypted `env.yml` in the editor.
* **Click Vault** to `ansible-vault edit` it; without a `vault.yml` the row
  reads `create` and runs `ansible-vault create` instead.
* **Right-click an environment → *Rekey Vaults…*** rotates the passphrase of
  every vault in that environment in one `ansible-vault rekey`. One environment
  at a time, because the passphrase is per environment.
* Production rows are red and ask for confirmation before running
  (`playbookRunner.confirmProduction`).
* A playbook row shows its **last run** in that environment — `✓ 3 min ago`,
  `✗ 1 d ago`, a spinner while it runs — and the activity bar icon counts the
  running ones. The **status bar** shows the newest run; click it to run it
  again.
* The command palette offers the same thing without the tree: *Playbook Runner: Run
  Playbook* walks environment → service → playbook as QuickPicks, which is the
  flow the old `run-ansible-playbooks.sh` had with `read -p`.

## Dashboard

*Playbook Runner: Open Dashboard* (the `$(dashboard)` button on the view's
title bar) opens an editor tab with the same environments and services, laid
out for overview rather than for a narrow side bar:

```
┌ Playbook Runner ───────────────────────────────── [● production] [● staging] ┐
│ ⚠ production — runs here ask for confirmation before they start.            │
├──────────────────┬───────────────────────────────────────────────────────────┤
│ Filter services  │ authentik   1 playbook  env.yml  vault                    │
│ ● authentik  3m  │ ▾ authentik.yml                          ✓ 3 min ago      │
│ ● dns_servers 1d │   CREATE USER …  podman_servers  [podman-user-setup] …    │
│ ○ immich         │   SETUP  podman/user : Ensure podman_user is defined      │
│ …                │   FROM   podman/deploy-app : Get podman user UID          │
│                  │   UNTIL  podman/deploy-app : Set podman user UID fact     │
├──────────────────┴───────────────────────────────────────────────────────────┤
│ authentik/authentik.yml  from … until … ✕   tags [   ] limit [   ] ☑ check   │
│ $ ANSIBLE_STRATEGY=playbook_runner_range … ansible-playbook -i … --check     │
│                                                       [ ▶ Run on staging ]   │
└──────────────────────────────────────────────────────────────────────────────┘
```

* Each service shows its newest run; each playbook expands into its plays and
  tasks, read the same way the tag list is.
* **Click a task** to start the range there, click another to end it; hover a
  row for *only*, *from*, *until* and *open in the editor*. Tags every task of
  a play shares sit on the play's line. Click a tag to add it to `--tags`.
* The bottom bar is the run: options, and the **exact command line** the run
  will get, built by the same code the runner uses. *Run* goes through the
  same path as `▶` in the tree — production confirmation, last run, history.
* The page is drawn only in VS Code's theme colours, so it follows light, dark
  and high-contrast themes.

## Running part of a playbook

`ansible-playbook` can start at a task (`--start-at-task`) but not stop at
one, and starting skips every earlier task — including the ones that set the
facts the rest of the play needs (`podman-user-setup`, here). So a range run
uses a strategy plugin that ships with the extension,
`ansible/strategy/playbook_runner_range.py`,
switched on for that one run through `ANSIBLE_STRATEGY` and
`ANSIBLE_STRATEGY_PLUGINS`. It runs `linear` with a filter in front:

* before the start: fact gathering, `include_*` tasks, and tasks tagged with
  one of `playbookRunner.setupTags` (default `podman-user-setup`);
* from the start until the end: everything;
* after the end: only handlers already notified, so a changed template still
  restarts its service. Later plays are skipped.

*Only this task* is a range whose start and end are the same task. Task names
match exactly, as written — `podman/deploy-app : Render manifest` inside a
role — and a name that appears twice ends at its first occurrence after the
start.

A range that cannot work is refused before anything runs: a task that is not
in the playbook (also for *Re-run Last* after a rename), an end before the
start, or a playbook that sets `strategy:` itself, which would bypass the
plugin. If an edge still never matched during a run, the run counts as failed
and says which one.

The plugin overrides part of ansible-core's `linear` strategy, so an
ansible-core upgrade can break it; `npm test` runs it against the installed
ansible-core on throwaway `localhost` playbooks and fails if it does. It is
known to work with ansible-core 2.22.

`--step` is a run option too: ansible asks before each task in the terminal.

## Where the tag list comes from

The tag rows under a playbook, and the checkbox list *Tags* under `⚙` opens,
are the same list, so both show the tags that playbook has rather than an empty
box to type into. They are read out of the YAML: the playbook,
every playbook it `import_playbook`s, and the task files of the roles it pulls
in through `roles:`, `import_role` or `include_role` — `roles/` by default,
`playbookRunner.rolesDir` otherwise, which is `ansible.cfg`'s `roles_path`.

They are listed in the order the run reaches them, with a play's own tags above
the ones that live inside the roles it imports, and each of the latter labelled
with the role it came from. A tag that was ticked last time and is not in the
playbook any more stays in the list, ticked and marked, rather than quietly
disappearing from the next run.

The scan costs about a millisecond per playbook and runs when a service's
*Playbooks* section is opened — the answer decides whether a playbook row gets
an expand arrow at all, so it cannot wait until the row is expanded.

This is deliberately *not* `ansible-playbook --list-tags`, which is the
authoritative answer but needs the inventory, the vault passphrase and a second
or two of ansible start-up — three reasons for the list not to be there when the
item is ticked. The cost is that `src/tags.js` is a line scanner and not a YAML
parser: a tag built out of a variable is skipped, and an unusual enough layout
would be missed. So the list ends in *Other…*, which hands over to the free-text
box seeded with whatever is ticked, and a playbook with no tags found goes
straight there.

## Rotating vault passphrases

*Playbook Runner: Rekey Vaults…*, or the same command on an environment's context menu,
hands every `vault.yml` in that environment to one `ansible-vault rekey`. It
asks once for the current passphrase and twice for the new one; production asks
to confirm a second time.

The new passphrase is **never** an argument — `--new-vault-password-file` is
deliberately not passed, so ansible prompts instead and the passphrase stays out
of the process table and the shell history. A configured
`playbookRunner.vaultPasswordFiles` entry is passed as the *current* passphrase only.

Two things the confirmation says, because both are easy to get wrong:

* ansible-vault works through the files one at a time, so a failure part-way
  leaves some vaults on the new passphrase and the rest on the old one, with
  nothing in the output marking where it stopped. **Commit the inventory first**
  — the diff is then the record of how far it got.
* Rekeying does not touch the password *file* the old passphrase was read from.
  Update it afterwards, or every later run authenticates with a passphrase the
  vaults no longer use.

## Adding a service

*Playbook Runner: Create Service Skeleton…* (the ＋ folder button in the view title)
asks for a name and lays out the directories a service consists of:

```
playbooks/<name>/                                  ← empty, ready for the playbook
inventories/production/group_vars/<name>/env.yml   ← empty
inventories/staging/group_vars/<name>/env.yml      ← empty
…one per environment that exists
```

* **Every environment, in one go** — the point of the command. A service that
  exists in `production` and is missing from `staging` is the failure mode this
  removes; running it on a name that already exists fills in only the parts
  that are missing.
* **Which environments** is `playbookRunner.serviceEnvironments`: empty (the default)
  is all of them, `["staging"]` lays out only staging. A listed name with no
  `hosts.ini` behind it is skipped and named in the confirmation — the command
  never creates an inventory, because a directory without one is not an
  environment and its group_vars would never show up in the tree.
* **Structure only.** The env files are created empty, and an env file that
  already exists is never touched — it is opened with `wx`, not truncated.
* **No vault is created.** A `vault.yml` has to be written encrypted, so the
  new group_vars directory shows the ＋ *Vault* row and
  `ansible-vault create` does it from there.
* The plan is shown as a list of paths before anything is written, and the name
  must be a plain directory name (letters, digits, dot, dash, underscore) —
  it is an inventory group name at the same time.

## Relation to the shell scripts

`scripts/run-ansible-playbooks.sh`, `scripts/edit-ansible-vaults.sh` and
`scripts/create-ansible-vaults.sh` **have been removed** — the extension is now
the only front end, and `.vscode/tasks.json` (which only wrapped them) is gone
with them. Nothing is duplicated any more: a change to the repository layout
means checking the settings below and nothing else.

Without the editor, run `ansible-playbook` / `ansible-vault` directly:

```bash
ansible-playbook -i inventories/production/hosts.ini \
  playbooks/<service>/<playbook>.yml --ask-vault-password
ansible-vault edit inventories/production/group_vars/<group>/vault.yml
```

## How things are run

| | Mechanism | Why |
| --- | --- | --- |
| Playbooks | `vscode.Task` (`ShellExecution`) | Gives *Terminate Task*, *Re-run Last Task* and the task terminal. Still a real tty, so `--ask-vault-password`, `become` and SSH passphrase prompts work. |
| Vaults | A terminal per run, named `Ansible Vault: <env>` | `ansible-vault edit` spawns `$EDITOR` (nano, per `ansible.cfg`) and wants a terminal it owns. |

Both run with the workspace folder as the working directory, because
`ansible.cfg` is only read from the cwd and its `roles_path` is relative.

A task-range run adds environment variables to its task — the range plugin's
`ANSIBLE_STRATEGY*` and `PLAYBOOK_RUNNER_*` — never anything to the command
string. Every other run is unchanged.

Arguments are handed to the shell strongly quoted, so a path is a path and
never syntax. The vault terminal runs `$shell -c <command>` as its process
rather than being an interactive shell that gets typed into: it ends when the
command does, so opening a second vault cannot send text into the `nano` the
first one still has open.

### Trust

The extension is declared unsupported in untrusted and in virtual workspaces —
it runs shell commands and needs real files. The four settings that name an
executable or a vault password file are `machine` scope, so they can only be
set at user level and a repository's `.vscode/settings.json` cannot decide what
gets run. That matters for the password file too: ansible *executes* a
`--vault-password-file` that happens to be executable.

## Vault passwords

Per environment, in this order:

1. `playbookRunner.vaultPasswordFiles["<env>"]`, if set.
2. `playbookRunner.vaultPasswordFilePattern`, by default
   `${userHome}/.ansible-vault/${env}.pass`.
3. If the resolved file does not exist → `--ask-vault-password`.

Out of the box that reproduces today's behaviour: `staging` picks up
`~/.ansible-vault/staging.pass` silently, `production` prompts. To stop
production prompting, point it at the `prod.pass` you already have:

```jsonc
"playbookRunner.vaultPasswordFiles": {
  "production": "${userHome}/.ansible-vault/prod.pass"
}
```

## Install

There is no build step — the extension ships the JavaScript it is written in.
Two ways to install it:

**As a package.** Build a `.vsix` and hand it to VS Code:

```bash
cd scripts/vscode-extension
npm install          # dev tooling only; the extension itself has no dependencies
npm run package      # -> dist/playbook-runner-<version>.vsix
code --install-extension dist/playbook-runner-0.4.0.vsix
```

**As a symlink**, if you would rather have `git pull` be the update mechanism:

```bash
ln -s ~/Programmierprojekte/homelab-infra/scripts/vscode-extension \
      ~/.vscode/extensions/playbook-runner-0.4.0
```

An existing symlink from an older version keeps working; VS Code reads
`package.json`, not the directory name. Run *Developer: Reload Window*
afterwards. For VS Code Insiders or the Flatpak build, use
`~/.vscode-insiders/extensions` or
`~/.var/app/com.visualstudio.code/data/vscode/extensions` instead.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `playbookRunner.playbooksDir` | `playbooks` | Where the playbook folders live. |
| `playbookRunner.rolesDir` | `roles` | `ansible.cfg`'s `roles_path`; read when collecting the tags a playbook offers. |
| `playbookRunner.inventoriesDir` | `inventories` | One subdirectory per environment. |
| `playbookRunner.inventoryFile` | `hosts.ini` | A directory counts as an environment when it contains this. |
| `playbookRunner.groupVarsDir` | `group_vars` | Group variables directory inside an environment. |
| `playbookRunner.envFileName` | `env.yml` | Unencrypted variables filename inside a group; the *Env* row opens it. |
| `playbookRunner.vaultFileName` | `vault.yml` | Vault filename inside a group. |
| `playbookRunner.vaultPasswordFilePattern` ⁽ᵐ⁾ | `${userHome}/.ansible-vault/${env}.pass` | Supports `${userHome}`, `${workspaceFolder}`, `${env}`. Empty string always prompts. |
| `playbookRunner.vaultPasswordFiles` ⁽ᵐ⁾ | `{}` | Per-environment override of the pattern. |
| `playbookRunner.productionPattern` | `production` | Case-insensitive regex; matching environments are red and confirmed. Empty disables. |
| `playbookRunner.confirmProduction` | `true` | Ask before running against a production environment. |
| `playbookRunner.ansiblePlaybookCommand` ⁽ᵐ⁾ | `ansible-playbook` | Point at a virtualenv if ansible is not on `PATH`; a wrapper such as `uv run ansible-playbook` works too. |
| `playbookRunner.ansibleVaultCommand` ⁽ᵐ⁾ | `ansible-vault` | |
| `playbookRunner.setupTags` | `["podman-user-setup"]` | Tags whose tasks still run before the start of a task range, because later tasks need the facts they set. Empty makes *From task* behave like `--start-at-task`. |
| `playbookRunner.serviceEnvironments` | `[]` | Environments *Create Service Skeleton…* lays a service out in. Empty means every environment; a name that is not an environment is skipped, never created. |

⁽ᵐ⁾ `machine` scope: user settings only, not settable by a workspace.

The `homelab.*` and `homelabTasks.*` keys and command IDs of earlier versions
are no longer read. Settings, keybindings and `tasks.json` entries
(`"type": "homelab"`) written for them have to be renamed to
`playbookRunner.*` (task type `playbook-runner`).

## Development

```
extension.js        activation, commands, watchers
src/discovery.js    filesystem scanning        ⟵ no `vscode` import, hence testable
src/command.js      ansible argument vectors   ⟵ likewise
src/defaults.js     the default of every setting, and their types
src/paths.js        ${...} expansion, vault password and production rules  ⟵ likewise
src/tags.js         the tags a playbook offers, read out of the YAML  ⟵ likewise
src/scaffold.js     the paths a new service is laid out at  ⟵ likewise
src/settings.js     reading the settings out of vscode
src/runner.js       task and terminal execution
src/tree.js         the tree provider and its nodes
src/pickers.js      the QuickPick chain used by the palette commands
```

The modules marked above import nothing from `vscode`, which is what lets
`node --test` cover the parts that decide what ends up on an ansible command
line. The rest is the editor surface.

`F5` opens an Extension Development Host with the repository loaded. Logs land
in *Help → Toggle Developer Tools → Console*.

```bash
npm install       # dev tooling: eslint, typescript, vsce
npm run check     # lint + typecheck + tests, the one to run before committing
npm run lint      # eslint
npm run typecheck # tsc over the JSDoc types; nothing is emitted
npm test          # node --test
npm run package   # dist/playbook-runner-<version>.vsix
```

Types are JSDoc, checked with `tsc --noEmit` under `strict`; there is no
compile step and nothing is generated. `npm install` brings in dev tooling
only — the extension itself has no runtime dependencies, which is why
`npm run package` passes `--no-dependencies`.
