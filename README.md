# Playbook Runner

A VS Code dashboard for running the Ansible playbooks in your workspace —
whole, by tag, or a range of their tasks — and editing their vaults.
Environments, playbooks and vaults are **discovered from the filesystem**, so
adding `inventories/lab/hosts.ini` or a new folder under `playbooks/` shows up
without touching any configuration.

## Requirements

* `ansible-playbook` and `ansible-vault` (ansible-core). Running a *range* of
  tasks uses a strategy plugin that runs on ansible-core 2.x (tested with 2.21
  and 2.22) and refuses other major versions; whole-playbook and tag runs do
  not use it.
* A Linux shell with GNU coreutils: playbooks are started through
  `env -C <workspace folder> …`. On another OS, use VS Code's Remote — SSH,
  WSL or Dev Containers to run the extension on a Linux machine.
* Shell integration in that shell, for the run history to tell a passed run
  from a failed one (without it, runs still start but show as *unknown*).

## Repository layout

The extension expects an Ansible repository laid out like this — every name
here is a setting (see [Configuration](#configuration)), so a different layout
needs only settings, not a fork:

```
ansible.cfg
playbooks/
  <service>/                      ← one folder per service, holding its *.yml playbooks
inventories/
  <environment>/                  ← any directory with a hosts.ini is an environment
    hosts.ini
    group_vars/
      <service>/
        env.yml                   ← plain variables
        vault.yml                 ← ansible-vault encrypted variables
roles/
```

A *service* is `playbooks/<name>/` and `group_vars/<name>/` shown as one
thing; either half may be missing. Loose playbooks directly under
`playbooks/` are listed as `(root)`.

### Starting from an empty folder

With no environment in the folder the dashboard offers **Get started…** (or
run *Playbook Runner: Get Started…*). It asks for the first environment's name
and the first service's name, lists the paths that are missing, and after one
confirmation creates the tree above: `ansible.cfg` (`roles_path` set to the
roles directory; an existing one is left alone), `roles/`, a starter playbook
at `playbooks/<service>/<service>.yml`, `inventories/<environment>/hosts.ini`
and an empty `group_vars/<service>/env.yml`. The inventory puts `localhost`
(`ansible_connection=local`) in the service's group, so ▶ on the starter
playbook runs right away; replace `localhost` with your real hosts afterwards.
The starter playbook is one task, *Check the connection*, running
`ansible.builtin.ping`, tagged `hello`. The command is refused when the folder
already has an environment, and the starter playbook opens when it is done.

## Dashboard

The **`$(run-all) Playbook Runner`** item on the left of the status bar opens
the dashboard as an editor tab (so does *Playbook Runner: Open Dashboard* in the
palette). While playbooks run it reads `· N running`; the status bar item next
to it shows the newest run and runs it again on click.

```
┌ Playbook Runner  Runs|Settings|Inventory  ↻ Re-run last  ⊕ New service…  ⚿ Rekey vaults  [● production] [● staging] ┐
│ ⚠ production — runs here ask for confirmation before they start.                                │
├──────────────────┬───────────────────────────────────────────────────────────────────────────────┤
│ Filter services  │ authentik   1 playbook   env.yml   🔒 Edit vault                              │
│ ≡ all       vars │ ▾ authentik.yml                                    ✓ 3 min ago   ▶            │
│ ✓ authentik   3m │   TAGS ▷ podman-user-setup  ▷ deploy-app  ▷ nginx-reverse-proxy …               │
│ ✗ dns_servers 1d │   CREATE USER …  podman_servers  [podman-user-setup] …                        │
│ ○ immich         │   SETUP  podman/user : Ensure podman_user is defined                          │
│ …                │   FROM   podman/deploy-app : Get podman user UID                              │
│                  │   UNTIL  podman/deploy-app : Set podman user UID fact                         │
├──────────────────┴───────────────────────────────────────────────────────────────────────────────┤
│ authentik/authentik.yml  from … until … ✕       tags [   ] limit [   ] verbosity [—] ☑ check      │
│ $ env -C … ANSIBLE_STRATEGY=playbook_runner_range … ansible-playbook -i … --check               │
│                                                                           [ ▶ Run on staging ]  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

* **Environments** are the tabs at the top; production (matching
  `playbookRunner.productionPattern`) is red, with a banner, and every run
  there asks for confirmation first (`playbookRunner.confirmProduction`).
* **Services** are the list on the left. A service is `playbooks/<name>/` and
  `group_vars/<name>/` shown as one thing; one with only variables (`all`)
  is marked *vars*. Each shows its newest run. Because variables are per
  environment and playbooks are not, the same service can look different
  under `production` and `staging`.
* **A service** shows its playbooks, a link to its plain `env.yml`, and
  **Edit vault** (`ansible-vault edit`) — or **Create vault**
  (`ansible-vault create`) while it has no `vault.yml`. Vaults open in a
  terminal of their own.
* **A playbook card**: `▶` runs it now with no options. Expanded, it shows its
  **tags** in run order — `▷` runs only that tag, a click on the tag adds it to
  `--tags` — and its plays and tasks, read the same way (see
  [Where the tag list comes from](#where-the-tag-list-comes-from)). A tag in
  `--tags` is filled and ticked; a yellow tag runs without being selected: a
  `playbookRunner.setupTags` tag before a task range, or ansible's `always`.
* **Click a task** to start a range there, click another to end it; hover a row
  for *only*, *from*, *until* and *open in the editor*. See
  [Running part of a playbook](#running-part-of-a-playbook).
* **The run bar** at the bottom: tags, `--limit`, verbosity, `--check`,
  `--diff`, `--step`, the **exact command line** the run will get (built by the
  same code the runner uses), and *Run*.
* **The top bar**: *Re-run last*, *New service…* (see
  [Adding a service](#adding-a-service)) and *Rekey vaults* for the environment
  shown (one `ansible-vault rekey` over every vault in it — one environment at
  a time, because the passphrase is per environment).
* **Beside the environment tabs**: ✎ renames the environment shown, 🗑 deletes
  it, ＋ lays out a new one — see
  [Adding, renaming and deleting an environment](#adding-renaming-and-deleting-an-environment).
* **The Inventory tab** (*Runs | Settings | Inventory*) edits the environment's
  inventory file — see [Editing the inventory](#editing-the-inventory).
* **The Settings tab** (top left: *Runs | Settings | Inventory*) shows every
  setting below with its description and where its value comes from (default, User or
  Workspace), with an editor that fits it — text, on/off, a list, or
  environment → password file rows — and *Reset*. A change is saved to this
  workspace's `.vscode/settings.json`; *Move to User settings* moves a value to
  your User settings instead. The four settings marked ⁽ᵐ⁾ below always go to
  User settings. A value is checked before it is saved: the wrong type, an
  empty name, or a `productionPattern` that is not a valid regular expression
  is refused with the reason, and nothing is written.
* With no environment found, the dashboard says where it looked and offers
  *Open Settings*, which opens the Settings tab.
* The page is drawn only in VS Code's theme colours, so it follows light, dark
  and high-contrast themes.

Every run goes the same way, whichever button started it: task-range check,
production confirmation, remembered as the last run, recorded in the history.
The palette commands (*Run Playbook*, *Run Playbook with Options…*, *Edit
Vault*, …) still work without the dashboard, walking environment → service →
playbook as QuickPicks.

## Editing the inventory

The **Inventory** tab edits the INI inventory of the environment shown, so a
host, its login or a service's server groups no longer need a text editor. It
has three parts:

* **Server groups** — `[group]` sections with their hosts. A host opens into
  its SSH fields (`ansible_host`, `ansible_user`, `ansible_port`,
  `ansible_ssh_private_key_file`, `ansible_ssh_common_args`) and *Other
  variables*; the group has *Group variables* and a vault button for its
  `group_vars` (playbookRunner.groupVarsDir) vault.
* **Services (access control)** — groups with a `[service:children]` section,
  where you tick which server groups belong to the service.
* **Manual sections** — see below.

```
┌ Inventory · inventories/staging/hosts.ini                              Open in editor ┐
│ SERVICES (access control)                                                             │
│   immich     ☑ podman_servers  ☐ dns_servers                      Vault  …            │
│ SERVER GROUPS                                                                         │
│ ▾ podman_servers                                                      Vault  …        │
│     web1   ansible_host 10.0.0.5  user admin  port 22                                 │
│     GROUP VARIABLES  Variable [   ] = [   ]                                           │
│ MANUAL SECTIONS   [legacy] …                                          Open in editor  │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ ⚠ warnings the save will cause                      ● unsaved changes  Discard  Save staging │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

Nothing is written until *Save*, which first asks for confirmation and lists
what the rewrite changes. *Show diff* there opens a diff and then asks, without
blocking, whether to save or cancel. Edits are kept as a draft per environment
(marked `●` on the tab) until saved or discarded.

**What a save does to the file.** The page writes the whole file from what it
shows, so anything it cannot show is at risk. The confirmation lists it first:
comments outside manual blocks, duplicate sections (merged), duplicate entries
and lines the page cannot read. Quoted values such as `port="22"` keep their
quotes, and `[all]` is written only when `all` has hosts. To keep a hand-written
part as it is, put it between two marker lines:

```
# playbook-runner: manual begin
[legacy]
old-box ansible_host=10.0.0.9
# playbook-runner: manual end
```

Text between the markers is copied verbatim and shown read-only in *Manual
sections*, with *Open in editor*. A block that opens a section must be followed
by a section header, and unbalanced markers are an error; in either case the
file is read-only in the tab until fixed.

* **No passwords.** `ansible_password`, `ansible_ssh_pass`,
  `ansible_become_pass` and `ansible_become_password` are refused; put them in
  the group's vault.
* **A save is refused** while the file has unsaved edits in an editor, while a
  playbook runs against the environment, or when the file changed on disk since
  the page loaded. The draft is then frozen; *Discard* reloads the file.
* **Rename and delete** (the group's `…` menu) work for server groups and
  services, once nothing is unsaved. A rename also renames the group's
  `group_vars/<name>/` in this environment and its entries in services'
  children. A delete removes the group from every service and offers to move its
  `group_vars/<name>/` to the trash. File-form group variables
  (`<name>.yml`, `.yaml`, `.json`) and manual blocks that still name the group
  are listed in the confirmation but not changed.
* **Only INI inventories** are editable; a YAML one shows *Editing is only
  supported for INI inventories.* A folder under `inventories/` with no
  inventory file offers *Create inventory*, which writes a skeleton containing
  the marker lines.

## Running part of a playbook

`ansible-playbook` can start at a task (`--start-at-task`) but not stop at
one, and starting skips every earlier task — including the ones that set the
facts the rest of the play needs. So a range run
uses a strategy plugin that ships with the extension,
`ansible/strategy/playbook_runner_range.py`,
switched on for that one run through `ANSIBLE_STRATEGY` and
`ANSIBLE_STRATEGY_PLUGINS`. It runs `linear` with a filter in front:

* before the start: fact gathering, `include_*` tasks, and tasks tagged with
  one of `playbookRunner.setupTags` (none by default — list the tags of
  tasks that set facts later tasks rely on, e.g. `["user-setup"]`);
* from the start until the end: everything;
* after the end: only handlers already notified, so a changed template still
  restarts its service. Later plays are skipped.

*Only this task* is a range whose start and end are the same task. Task names
match exactly, as written — `podman/deploy-app : Render manifest` inside a
role — and a name that appears twice ends at its first occurrence after the
start.

A range that cannot work is refused before anything runs: a task that is not
in the playbook (also for *Re-run Last* after a rename), an end before the
start, a playbook that sets `strategy:` itself (which would bypass the
plugin), or one with a `serial:` play. If an edge still never matched during a
run, the run counts as failed and says which one.

A range run can only be started from Playbook Runner. Replaying its command
line by hand would skip those checks, so the plugin refuses a replay before any
task runs; use *Playbook Runner: Re-run Last* instead.

The plugin overrides part of ansible-core's `linear` strategy, so an
ansible-core upgrade can break it. It runs on any ansible-core 2.x (tested
with 2.21 and 2.22), refuses another major version or an ansible-core whose
`linear` strategy lacks the method it overrides, and `npm test` runs it
against the installed ansible-core on throwaway `localhost` playbooks.

`--step` is a run option too: ansible asks before each task in the terminal.

## Where the tag list comes from

The *Tags* line of a playbook card, and the checkbox list the *Run Playbook
with Options…* command opens, are the same list, so both show the tags that playbook has rather than an empty
box to type into. They are read out of the YAML: the playbook,
every playbook it `import_playbook`s, and the task files of the roles it pulls
in through `roles:`, `import_role` or `include_role` — `roles/` by default,
`playbookRunner.rolesDir` otherwise, which is `ansible.cfg`'s `roles_path`.

They are listed in the order the run reaches them, with a play's own tags above
the ones that live inside the roles it imports, and each of the latter labelled
with the role it came from. A tag that was ticked last time and is not in the
playbook any more stays in the list, ticked and marked, rather than quietly
disappearing from the next run.

The scan costs about a millisecond per playbook and runs when a playbook card
is expanded.

This is deliberately *not* `ansible-playbook --list-tags`, which is the
authoritative answer but needs the inventory, the vault passphrase and a second
or two of ansible start-up — three reasons for the list not to be there when the
item is ticked. The cost is that `src/tags.js` is a line scanner and not a YAML
parser: a tag built out of a variable is skipped, and an unusual enough layout
would be missed. So the list ends in *Other…*, which hands over to the free-text
box seeded with whatever is ticked, and a playbook with no tags found goes
straight there.

## Rotating vault passphrases

*Rekey vaults* in the dashboard's top bar (or *Playbook Runner: Rekey Vaults…*),
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

*Playbook Runner: Create Service Skeleton…* (*New service…* in the dashboard's top bar)
asks for a name, then *Empty folder* or *With a starter playbook*, and lays
out the directories a service consists of:

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
  environment and its group_vars would never show up in the dashboard.
* **Structure only, unless you pick the starter playbook.** The env files are created empty, and an env file that
  already exists is never touched — it is opened with `wx`, not truncated.
* **Starter playbook** (*With a starter playbook*) also writes
  `playbooks/<name>/<name>.yml`: `hosts: <name>`, one `ansible.builtin.ping`
  task tagged `hello`. An existing playbook of that name is never overwritten.
  The command **never adds hosts** to an existing inventory; when the new
  group has no hosts in an INI inventory of an environment the service is
  created in, the confirmation says so, because the playbook would match
  nothing until you add some.
* **No vault is created.** A `vault.yml` has to be written encrypted, so the
  new service shows **Create vault** in the dashboard, and
  `ansible-vault create` does it from there.
* The plan is shown as a list of paths before anything is written, and the name
  must be a plain directory name (letters, digits, dot, dash, underscore) —
  it is an inventory group name at the same time.

## Adding, renaming and deleting an environment

An environment is a directory under `inventories/` with an inventory file in
it, so all three are operations on that one directory. Each shows what it is
about to do and waits for a confirmation; none of them runs ansible.

* ***Create Environment Skeleton…*** (＋) asks for a name and what to start
  from. *Empty* is `inventories/<name>/hosts.ini` and `group_vars/`. *Groups
  of <environment>* adds that environment's group structure:

  ```
  inventories/<name>/hosts.ini                   ← its [group] headers and [group:children], no hosts
  inventories/<name>/group_vars/<group>/env.yml  ← empty, one per group it has
  ```

  Hosts, `[group:vars]`, env values and vaults are never copied: a copied host
  list would point the new environment at the old one's machines, and each
  environment has a vault passphrase of its own. Groups are only read from an
  INI inventory; with a YAML one the inventory file starts empty.
* ***Rename Environment…*** (✎) moves the directory and lets what knows the
  environment by name follow: its keys in `playbookRunner.vaultPasswordFiles`
  and `playbookRunner.serviceEnvironments` (at every level they are set), the
  run history and *Re-run last*. The confirmation says when the new name gains
  or loses the production confirmation, and when a password file found through
  `vaultPasswordFilePattern` will stop matching. Anything else that spells out
  the old path — scripts, docs — is not touched.
* ***Delete Environment…*** (🗑) moves the directory **to the trash**, vaults
  included, after a dialog that counts what goes and the environment's name
  typed out. If the trash is unavailable nothing is deleted. Settings that
  name the environment are left as they are.

Rename and delete are refused while a playbook is running against the
environment, and delete refuses a symlinked environment directory.

## Without VS Code

Nothing the extension does needs it at run time: it builds ordinary
`ansible-playbook` / `ansible-vault` command lines (the run bar shows the exact
one). Without the editor, run them directly:

```bash
ansible-playbook -i inventories/production/hosts.ini \
  playbooks/<service>/<playbook>.yml --ask-vault-password
ansible-vault edit inventories/production/group_vars/<group>/vault.yml
```

## How things are run

| | Mechanism | Why |
| --- | --- | --- |
| Playbooks | A reused `Playbook Runner` terminal per workspace folder; the command goes in through shell integration | A real tty, so `--ask-vault-password`, `become` and SSH passphrase prompts work; Ctrl+C stops a run; shell integration reports the exit code for the run history. A runner terminal with a command still running is never typed into — a second one opens. |
| Vaults | A terminal per run, named `Ansible Vault: <env>` | `ansible-vault edit` spawns `$EDITOR` (nano, per `ansible.cfg`) and wants a terminal it owns. |

Every one of these terminals is created hidden and shown right after. The
Python Environments extension (`ms-python.vscode-python-envs`) types
`source .venv/bin/activate.fish` into each new terminal in a folder with a
venv, and a hidden-at-creation terminal is the one kind it leaves alone.
Playbooks used to run as VS Code tasks, whose terminals it only sometimes
recognised in time — the activation line then landed in the vault password
prompt. Without shell integration in your shell the command is still sent, but
its result shows as *unknown* in the history.

Both run with the workspace folder as the working directory, because
`ansible.cfg` is only read from the cwd and its `roles_path` is relative.

The line typed into the runner terminal is
` env -C <workspace folder> [range variables] ansible-playbook <args>`: `env -C`
runs it in the workspace folder without moving your shell (GNU coreutils), a
task-range run's `ANSIBLE_STRATEGY*` and `PLAYBOOK_RUNNER_*` variables apply
to that one command only, and the leading space keeps it out of bash and fish
history.

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

So out of the box, an environment with a `~/.ansible-vault/<env>.pass` runs
without asking, and one without is prompted for. To use a file with another
name for one environment:

```jsonc
"playbookRunner.vaultPasswordFiles": {
  "production": "${userHome}/.ansible-vault/prod.pass"
}
```

## Install

Search for *Playbook Runner* in the Extensions view — it is published on the
Visual Studio Marketplace and on Open VSX (VSCodium, Cursor and other
VS Code-compatible editors). Or from a terminal:

```bash
code --install-extension sebgad.playbook-runner
```

Open a workspace whose folder holds the [layout above](#repository-layout) and
click **Playbook Runner** in the status bar.

To run it from source instead, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Configuration

Every setting can be edited in the dashboard's Settings tab, or in VS Code's
own Settings editor.

| Setting | Default | Meaning |
| --- | --- | --- |
| `playbookRunner.playbooksDir` | `playbooks` | Where the playbook folders live. |
| `playbookRunner.rolesDir` | `roles` | `ansible.cfg`'s `roles_path`; read when collecting the tags a playbook offers. |
| `playbookRunner.inventoriesDir` | `inventories` | One subdirectory per environment. |
| `playbookRunner.inventoryFile` | `hosts.ini` | A directory counts as an environment when it contains this. |
| `playbookRunner.groupVarsDir` | `group_vars` | Group variables directory inside an environment. |
| `playbookRunner.envFileName` | `env.yml` | Unencrypted variables filename inside a group; the dashboard's `env.yml` link opens it. |
| `playbookRunner.vaultFileName` | `vault.yml` | Vault filename inside a group. |
| `playbookRunner.vaultPasswordFilePattern` ⁽ᵐ⁾ | `${userHome}/.ansible-vault/${env}.pass` | Supports `${userHome}`, `${workspaceFolder}`, `${env}`. Empty string always prompts. |
| `playbookRunner.vaultPasswordFiles` ⁽ᵐ⁾ | `{}` | Per-environment override of the pattern. |
| `playbookRunner.productionPattern` | `production` | Case-insensitive regex; matching environments are red and confirmed. Empty disables. |
| `playbookRunner.confirmProduction` | `true` | Ask before running against a production environment. |
| `playbookRunner.ansiblePlaybookCommand` ⁽ᵐ⁾ | `ansible-playbook` | Point at a virtualenv if ansible is not on `PATH`; a wrapper such as `uv run ansible-playbook` works too. |
| `playbookRunner.ansibleVaultCommand` ⁽ᵐ⁾ | `ansible-vault` | |
| `playbookRunner.setupTags` | `[]` | Tags whose tasks still run before the start of a task range, because later tasks need the facts they set. Empty makes *From task* behave like `--start-at-task`. |
| `playbookRunner.serviceEnvironments` | `[]` | Environments *Create Service Skeleton…* lays a service out in. Empty means every environment; a name that is not an environment is skipped, never created. |

⁽ᵐ⁾ `machine` scope: user settings only, not settable by a workspace.

## License

[MIT](LICENSE)
