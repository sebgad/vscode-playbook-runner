# Homelab

A VS Code sidebar for running this repository's Ansible playbooks and editing
its vaults. Environments, playbooks and vaults are **discovered from the
filesystem** — no path and no environment name is written down in the
extension, so adding `inventories/lab/hosts.ini` or a new folder under
`playbooks/` shows up without touching any code or config.

The tree is **environment → service → Playbooks / Env / Vault**: a service is
`playbooks/<name>/` and `group_vars/<name>/` shown as one thing, so everything
belonging to e.g. `authentik` sits in one place per environment. A service has
one `env.yml` and one `vault.yml`, so those are rows that act on click rather
than folders to open.

```
Homelab (activity bar)
├── production                       ← red: matches homelab.productionPattern
│   ├── authentik               1
│   │   ├── Playbooks           1
│   │   │   └── ▶ authentik.yml     ← click opens it, ▶ / ⚙ run it
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
  against that environment, `⚙` asks for tags, verbosity, `--limit`, `--check`
  and `--diff` first. Tags are a checkbox list of the tags that playbook
  actually has — see [Where the tag list comes from](#where-the-tag-list-comes-from).
* **Click Env** to open the plain, unencrypted `env.yml` in the editor.
* **Click Vault** to `ansible-vault edit` it; without a `vault.yml` the row
  reads `create` and runs `ansible-vault create` instead.
* **Right-click an environment → *Rekey Vaults…*** rotates the passphrase of
  every vault in that environment in one `ansible-vault rekey`. One environment
  at a time, because the passphrase is per environment.
* Production rows are red and ask for confirmation before running
  (`homelab.confirmProduction`).
* The command palette offers the same thing without the tree: *Homelab: Run
  Playbook* walks environment → service → playbook as QuickPicks, which is the
  flow the old `run-ansible-playbooks.sh` had with `read -p`.

## Where the tag list comes from

Ticking *Tags* under `⚙` shows the tags of that playbook to check off, rather
than an empty box to type into. They are read out of the YAML: the playbook,
every playbook it `import_playbook`s, and the task files of the roles it pulls
in through `roles:`, `import_role` or `include_role` — `roles/` by default,
`homelab.rolesDir` otherwise, which is `ansible.cfg`'s `roles_path`.

They are listed in the order the run reaches them, with a play's own tags above
the ones that live inside the roles it imports, and each of the latter labelled
with the role it came from. A tag that was ticked last time and is not in the
playbook any more stays in the list, ticked and marked, rather than quietly
disappearing from the next run.

This is deliberately *not* `ansible-playbook --list-tags`, which is the
authoritative answer but needs the inventory, the vault passphrase and a second
or two of ansible start-up — three reasons for the list not to be there when the
item is ticked. The cost is that `src/tags.js` is a line scanner and not a YAML
parser: a tag built out of a variable is skipped, and an unusual enough layout
would be missed. So the list ends in *Other…*, which hands over to the free-text
box seeded with whatever is ticked, and a playbook with no tags found goes
straight there.

## Rotating vault passphrases

*Homelab: Rekey Vaults…*, or the same command on an environment's context menu,
hands every `vault.yml` in that environment to one `ansible-vault rekey`. It
asks once for the current passphrase and twice for the new one; production asks
to confirm a second time.

The new passphrase is **never** an argument — `--new-vault-password-file` is
deliberately not passed, so ansible prompts instead and the passphrase stays out
of the process table and the shell history. A configured
`homelab.vaultPasswordFiles` entry is passed as the *current* passphrase only.

Two things the confirmation says, because both are easy to get wrong:

* ansible-vault works through the files one at a time, so a failure part-way
  leaves some vaults on the new passphrase and the rest on the old one, with
  nothing in the output marking where it stopped. **Commit the inventory first**
  — the diff is then the record of how far it got.
* Rekeying does not touch the password *file* the old passphrase was read from.
  Update it afterwards, or every later run authenticates with a passphrase the
  vaults no longer use.

## Adding a service

*Homelab: Create Service Skeleton…* (the ＋ folder button in the view title)
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

1. `homelab.vaultPasswordFiles["<env>"]`, if set.
2. `homelab.vaultPasswordFilePattern`, by default
   `${userHome}/.ansible-vault/${env}.pass`.
3. If the resolved file does not exist → `--ask-vault-password`.

Out of the box that reproduces today's behaviour: `staging` picks up
`~/.ansible-vault/staging.pass` silently, `production` prompts. To stop
production prompting, point it at the `prod.pass` you already have:

```jsonc
"homelab.vaultPasswordFiles": {
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
npm run package      # -> dist/homelab-tasks-<version>.vsix
code --install-extension dist/homelab-tasks-0.4.0.vsix
```

**As a symlink**, if you would rather have `git pull` be the update mechanism:

```bash
ln -s ~/Programmierprojekte/homelab-infra/scripts/vscode-extension \
      ~/.vscode/extensions/homelab-tasks-0.4.0
```

An existing symlink from an older version keeps working; VS Code reads
`package.json`, not the directory name. Run *Developer: Reload Window*
afterwards. For VS Code Insiders or the Flatpak build, use
`~/.vscode-insiders/extensions` or
`~/.var/app/com.visualstudio.code/data/vscode/extensions` instead.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `homelab.playbooksDir` | `playbooks` | Where the playbook folders live. |
| `homelab.rolesDir` | `roles` | `ansible.cfg`'s `roles_path`; read when collecting the tags a playbook offers. |
| `homelab.inventoriesDir` | `inventories` | One subdirectory per environment. |
| `homelab.inventoryFile` | `hosts.ini` | A directory counts as an environment when it contains this. |
| `homelab.groupVarsDir` | `group_vars` | Group variables directory inside an environment. |
| `homelab.envFileName` | `env.yml` | Unencrypted variables filename inside a group; the *Env* row opens it. |
| `homelab.vaultFileName` | `vault.yml` | Vault filename inside a group. |
| `homelab.vaultPasswordFilePattern` ⁽ᵐ⁾ | `${userHome}/.ansible-vault/${env}.pass` | Supports `${userHome}`, `${workspaceFolder}`, `${env}`. Empty string always prompts. |
| `homelab.vaultPasswordFiles` ⁽ᵐ⁾ | `{}` | Per-environment override of the pattern. |
| `homelab.productionPattern` | `production` | Case-insensitive regex; matching environments are red and confirmed. Empty disables. |
| `homelab.confirmProduction` | `true` | Ask before running against a production environment. |
| `homelab.ansiblePlaybookCommand` ⁽ᵐ⁾ | `ansible-playbook` | Point at a virtualenv if ansible is not on `PATH`; a wrapper such as `uv run ansible-playbook` works too. |
| `homelab.ansibleVaultCommand` ⁽ᵐ⁾ | `ansible-vault` | |

⁽ᵐ⁾ `machine` scope: user settings only, not settable by a workspace.

`homelabTasks.productionPattern` from 0.1 is still honoured as long as
`homelab.productionPattern` has not been given a value of its own, and the
`homelabTasks.refresh` command id still resolves, so an existing keybinding
keeps working.

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
npm run package   # dist/homelab-tasks-<version>.vsix
```

Types are JSDoc, checked with `tsc --noEmit` under `strict`; there is no
compile step and nothing is generated. `npm install` brings in dev tooling
only — the extension itself has no runtime dependencies, which is why
`npm run package` passes `--no-dependencies`.
