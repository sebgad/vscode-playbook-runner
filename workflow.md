# Workflow — folding the shell scripts into the extension

> **Status: done.** This is the historical plan. The migration is complete: the
> three shell scripts and `.vscode/tasks.json` have since been deleted, so the
> "today" column below describes how things were before the extension, not now.

Plan for turning `scripts/vscode-extension` from a *tasks.json viewer* into a
self-contained Ansible front end that discovers everything from the filesystem.

## 1. Where we are

| Piece | What it does today | Hardcoded |
| --- | --- | --- |
| `extension.js` | Reads `.vscode/tasks.json`, renders a flat tree, hands every click back to VS Code's task runner. | — (it owns no logic) |
| `.vscode/tasks.json` | 9 task entries, one per environment × operation combination. | `staging`/`production`, `~/.ansible-vault/staging.pass`, the three script paths |
| `run-ansible-playbooks.sh` | `read -p` prompts: environment → playbook folder → playbook file, then builds the `ansible-playbook` command. | `staging`/`production` menu, `inventories/$ENV/hosts.ini` |
| `edit-ansible-vaults.sh` | Prompts environment → vault, runs `ansible-vault edit`. | same two env names, `group_vars`, `vault.yml` |
| `create-ansible-vaults.sh` | Prompts environment → group, runs `ansible-vault create`. | same |

The scripts already iterate `playbooks/` and `group_vars/` — that part is fine.
What is fixed is the **environment list** (`1) staging  2) production` in three
places), the **inventory filename**, and the **vault password file** baked into
`tasks.json`. The extension itself knows none of this; it only forwards labels.

Repo reality the discovery has to cope with: 2 environments, 21 playbook
folders holding 1–7 `.yml` files each, and `group_vars` sets that differ between
environments (`staging` has `authentik_servers`, production does not; several
groups have `env.yml` but no `vault.yml` yet).

## 2. Target

Everything the three scripts do becomes extension code. The `.sh` files stay as
the outside-of-VS-Code path. The extension no longer reads `.vscode/tasks.json`
at all — the sidebar shows only what it discovers itself.

```
Playbook Runner (activity bar)
├── production                                    ← discovered, red
│   ├── authentik                  1
│   │   ├── Playbooks              1
│   │   │   └── ▶ authentik.yml
│   │   ├── ⌥ Env                  (opens env.yml in the editor)
│   │   └── ✎ Vault
│   ├── dns_servers                5 · no vault
│   │   ├── Playbooks              5
│   │   │   ├── ▶ setup-bind9.yml
│   │   │   └── ▶ setup-dns-zones.yml
│   │   ├── ⌥ Env
│   │   └── + Vault         create (no vault.yml — click creates one)
│   └── all                                       ← group_vars only
│       ├── ⌥ Env
│       └── ✎ Vault
└── staging                                       ← discovered, blue
    └── …
```

The middle level is the **service**: `playbooks/<name>/` and
`group_vars/<name>/` are the same thing under two directories, so the tree
joins them on their name instead of splitting the environment into one big
Playbooks and one big Vaults list. Rows a service has no content for are not
rendered.

A service has exactly one `env.yml` and one `vault.yml` — fixed filenames, not
a scan — so *Env* and *Vault* are leaves that act on click. Wrapping a single
file in a section would be a level that never branches.

Click a playbook → the file opens in the editor. `▶` on the row → runs it with
that environment's defaults, `⚙` → QuickPick for tags / verbosity / `--check` /
`--diff` / `--limit`. Click *Vault* → `ansible-vault edit`; click one without a
`vault.yml` → `ansible-vault create`. Click *Env* → the file opens in the
editor, since it is not encrypted and there is nothing for ansible to do with
it.

## 3. Structure

Plain JavaScript, no build step and no dependencies — the symlink install in the
README keeps working.

```
scripts/vscode-extension/
├── extension.js        activate(): wire providers, commands, watchers
├── src/
│   ├── defaults.js     setting defaults, shared by settings.js and discovery.js
│   ├── discovery.js    pure fs scanning — no `require("vscode")`, unit-testable
│   ├── command.js      ansible argument vectors — likewise vscode-free
│   ├── settings.js     setting reads + ${workspaceFolder}/${userHome}/${env} expansion
│   ├── runner.js       executes those commands as a task / in a terminal
│   ├── tree.js         TreeDataProvider, environment/playbook/vault nodes
│   └── pickers.js      the QuickPick chain shared by the palette commands
└── test/
    ├── discovery.test.js
    └── command.test.js
```

Two deviations from the sketch, decided while building: `command.js` was split
off from `runner.js` so the argument vectors — the part that has to keep
matching the shell scripts — can be tested without `vscode`; and the fixture
tree is built in a temp directory by the test rather than committed, which
keeps it readable in one place instead of spread over a dozen empty files.

## 4. Discovery — the part that removes the fixed paths

`src/discovery.js` exports four functions, all taking a workspace root and the
resolved settings, none importing `vscode`:

- **`findEnvironments(root)`** — every directory under `inventories/` that
  contains the inventory file. Returns `{ name, dir, inventory, groupVarsDir }`.
  Today that yields `production` and `staging`; adding `inventories/lab/` makes
  a third node appear with no code change. If none qualify the tree shows a
  single "no environments found under `inventories/`" placeholder rather than
  failing silently.
- **`findPlaybooks(root)`** — one entry per subdirectory of `playbooks/`, each
  with its `*.yml`/`*.yaml` files, sorted; loose top-level playbooks are
  collected under an implicit "(root)" group. Independent of environment, so it
  is scanned once and shared by every environment node.
- **`findVaultGroups(env)`** — directories under
  `inventories/<env>/group_vars`, each with its `env.yml` and `vault.yml`
  flagged `hasEnv` / `hasVault`. One list drives edit (`hasVault`), create
  (`!hasVault`) — replacing the two near-identical scripts — and the Env row.
- **`findServices(root, env)`** — the two above joined on directory name into
  `{ name, playbooks, playbooksDir, vars }`, which is what the tree's middle
  level renders. A *union*, not an intersection: `group_vars/all` has no
  playbooks and a playbook folder may exist before an environment has any
  variables for it, and both still deserve a row.

## 5. Running things

`src/runner.js` builds the same argument vectors the scripts do:

```
ansible-playbook -i <inventory> <playbook>
                 (--vault-password-file <p> | --ask-vault-password)
                 [--tags a,b] [-vvv] [--check] [--diff] [--limit h]
ansible-vault (edit|create) <group_vars/<group>/vault.yml>
                 (--vault-password-file <p> | --ask-vault-password)
```

Two execution paths, deliberately:

- **Playbooks → `vscode.tasks.executeTask`** with a `ShellExecution`. Gives the
  task terminal, *Terminate Task*, *Re-run Last Task* and `presentation`
  handling for free, and still has a real TTY so `--ask-vault-password`,
  `become` prompts and SSH key passphrases work.
- **Vaults → `vscode.window.createTerminal`** (one reused terminal,
  `Homelab Ansible`). `ansible-vault edit` spawns `$EDITOR` — currently `nano`
  per `ansible.cfg` — which wants an interactive terminal it fully owns, not a
  task wrapper.

Arguments are passed as an argv array, so paths with spaces need no manual
quoting.

**Vault password resolution**, replacing the `staging.pass` literal in
`tasks.json`: look up `playbookRunner.vaultPasswordFiles[<env>]`, else expand
`playbookRunner.vaultPasswordFilePattern` (default
`${userHome}/.ansible-vault/${env}.pass`). If the resolved file exists use
`--vault-password-file`, otherwise fall back to `--ask-vault-password`. On this
machine that keeps staging silent and — once `prod.pass` is pointed at — makes
production silent too, without either name appearing in code.

## 6. Settings

| Setting | Default | Replaces |
| --- | --- | --- |
| `playbookRunner.playbooksDir` | `playbooks` | `$SCRIPT_DIR/playbooks` |
| `playbookRunner.rolesDir` | `roles` | — (new; `ansible.cfg`'s `roles_path`, followed by the tag scan, see step 12) |
| `playbookRunner.inventoriesDir` | `inventories` | `$SCRIPT_DIR/inventories` |
| `playbookRunner.inventoryFile` | `hosts.ini` | `inventories/$ENV/hosts.ini` |
| `playbookRunner.groupVarsDir` | `group_vars` | `$VAULTS_DIR` |
| `playbookRunner.envFileName` | `env.yml` | — (new; the service's Env row) |
| `playbookRunner.vaultFileName` | `vault.yml` | `find -name vault.yml` |
| `playbookRunner.vaultPasswordFilePattern` | `${userHome}/.ansible-vault/${env}.pass` | the `tasks.json` literal |
| `playbookRunner.vaultPasswordFiles` | `{}` | per-environment override of the pattern |
| `playbookRunner.productionPattern` | `production` | *(existing)* red styling + confirm |
| `playbookRunner.confirmProduction` | `true` | — (new safety net; a click on a prod row no longer runs anything, see step 10) |
| `playbookRunner.ansiblePlaybookCommand` | `ansible-playbook` | — |
| `playbookRunner.ansibleVaultCommand` | `ansible-vault` | — |

The prefix was `homelab.*` (and `homelabTasks.*` before that) until step 15;
neither is read any more.

## 7. Commands

| Command | Where |
| --- | --- |
| `playbookRunner.runPlaybook` | inline ▶ / palette (QuickPick chain: env → folder → file) |
| `playbookRunner.runPlaybookWithOptions` | inline ⚙ — tags, verbosity, check, diff, limit |
| `playbookRunner.rerunLast` | palette; last invocation kept in `workspaceState` |
| `playbookRunner.editVault` / `playbookRunner.createVault` | the Vault row + palette |
| `playbookRunner.openEnv` | the Env row — opens `env.yml` in the editor |
| `playbookRunner.openPlaybook` | click on the row / context menu — open the `.yml` in the editor |
| `playbookRunner.refresh` | view title |

Palette entries run the same QuickPick chain the tree bypasses, so both the
browsable and the type-to-run habits are covered by one code path.

## 8. Refresh

`FileSystemWatcher` on `playbooks/**` and `inventories/**`, plus
`onDidChangeConfiguration` for `playbookRunner.*`. Adding a playbook file updates the
tree without a reload.

## 9. Sequence — done

1. ✅ tasks.json reader moved to `src/tasksJson.js`, behaviour unchanged.
   Commands renamed `homelabTasks.*` → `homelab.*`, old ids kept as aliases.
2. ✅ `src/defaults.js`, `src/discovery.js`, `src/settings.js` + tests.
3. ✅ `src/command.js` + `src/runner.js`, vault password resolution.
4. ✅ `src/tree.js`: environment roots, Playbooks/Vaults sections.
5. ✅ `src/pickers.js`, commands, menus, `package.json`, production
   confirmation.
6. ✅ README rewritten.
7. ✅ tasks.json support dropped again: `src/tasksJson.js`, the Tasks section,
   `homelab.runTask` / `homelab.openTasksJson` (and their `homelabTasks.*`
   aliases) and `homelab.showTasksSection` removed. Discovery covers everything
   the section used to show, so it was only a second way to run the same
   playbooks. `.vscode/tasks.json` itself is untouched and still works from
   VS Code's own *Run Task*.
8. ✅ tree regrouped to environment → service → Playbooks/Vaults:
   `findServices()` added to discovery, `PlaybookGroupNode` replaced by
   `ServiceNode`, the two environment-wide sections moved below the service.
9. ✅ `env.yml` surfaced: `playbookRunner.envFileName` + `hasEnv`/`envFile` on the
   group_vars group, an *Env* row per service and `playbookRunner.openEnv`. The
   *Vaults* section became a single *Vault* row that runs edit/create on
   click — one env and one vault per service means neither needs a level of
   its own.
   **Steps 8–9 not run here** — this machine has no `node`, so the new
   discovery tests are unexecuted.
10. ✅ a playbook row's click opens the file (`playbookRunner.openPlaybook`) instead of
    running it. Running is the inline ▶/⚙, which is a deliberate move rather
    than the one every click makes — the *Env* and *Vault* rows keep acting on
    click because there is nothing else those rows could mean, while a playbook
    row is a file first and an action second.
11. ✅ service skeletons: `src/scaffold.js` + `playbookRunner.createService`. The
    module is the fifth one that never imports `vscode`, for the same reason as
    the other four — it decides which paths get written, so `plan` and `create`
    are separate calls and `test/scaffold.test.js` exercises both. The plan is
    what the confirmation shows, files are opened `wx` so an existing `env.yml`
    survives, and no `vault.yml` is planned: an encrypted file is
    `ansible-vault create`'s job, and the ＋ *Vault* row already offers it once
    the group_vars directory exists. Creating in **all** environments at once is
    the point — a service present in `production` and missing from `staging` is
    the drift this removes — so the command deliberately takes no environment
    and is not offered on an environment row.
12. ✅ tags picked from a list instead of typed: `src/tags.js` +
    `playbookRunner.rolesDir`, the sixth module that never imports `vscode`.

    The alternative was `ansible-playbook --list-tags`, which is the
    authoritative answer — it is ansible's own view of the same question, and
    it sees a templated tag we cannot. It was **not** taken: it needs the
    inventory, needs the vault passphrase (every `group_vars/*/vault.yml` here
    is encrypted, so it fails outright without one), needs ansible on `PATH`,
    and costs a second or two of start-up. Each of those is a way for the
    checkbox list not to appear at the moment the item is ticked, and a picker
    that sometimes cannot open is worse than a list that is very good.

    So the files are read instead: the playbook, its `import_playbook` chain,
    and the task files of the roles it reaches, following `roles:`,
    `- role:`, `import_role`/`include_role` (with `tasks_from`) and
    `import_tasks`/`include_tasks`. Roles resolve beside the playbook first and
    then against `playbookRunner.rolesDir`, mirroring how ansible looks and what
    `ansible.cfg`'s relative `roles_path` means from the cwd every run uses.

    **The accepted cost:** it is a line scanner, not a YAML parser. The
    extension has no runtime dependencies and gaining a YAML library for a
    picker would be a poor trade, so the shapes it knows are the shapes this
    repository writes. A tag built out of a variable is skipped deliberately —
    showing `{{ thing }}` as something to tick would be a lie — and an unusual
    enough layout would simply be missed. Two things keep that from being a
    dead end: the list ends in *Other…*, which opens the old free-text box
    seeded with whatever is ticked, and a playbook where nothing was found goes
    straight to that box, which is exactly what this asked before.

    Ordering is part of the design, not an accident. A file's own tags are
    recorded before anything it pulls in — the descent is deferred until the
    file has been read, because a role reference sits *above* the `tags:` of
    the task carrying it, and descending in place buried `deploy-app` under
    `podman/deploy-app`'s innards. What comes out reads like the run does:
    `podman-user-setup, create-zfs-datasets, create-nfs-mounts, deploy-app,
    nginx-reverse-proxy` first, the role's own tags below, each labelled with
    the role it came from.

    A tag that was ticked last time and is no longer found stays in the list,
    ticked and marked. Dropping it silently would change what the next run does
    without saying so, and the remembered options already come back through
    `sanitizeRunOptions` — the list is the last place a tag can still be seen
    before it reaches a command line.

13. ✅ the tags are a level of the tree, not only a picker: a playbook row
    expands into one row per tag, `TagNode` in `src/tree.js`, with
    `playbookRunner.runPlaybookTag` on its inline ▶.

    Nothing new decides anything here. The rows come from the same
    `findPlaybookTags` the checkbox list uses, and the tag reaches `--tags`
    through the same `parseTagList`/`formatTagList` the picker's result does --
    the tree is a second way to *see* the list, not a second way to build a
    command line. `runPlaybookCommand` grew one branch for it rather than a
    command of its own, so a tagged run is confirmed, remembered and re-run
    exactly like any other; the production modal names the tag, because
    `--tags deploy-app` and a bare run are very different things to say yes to.

    Two decisions worth keeping:

    * **A click still opens the playbook, and ▶ still runs.** Step 10 moved
      running off the click for playbook rows; a tag row is the same row one
      level down and would be the easiest accidental production run in the
      tree if it ran on click.
    * **The scan happens when the *Playbooks* section is opened**, not when a
      playbook is expanded, because whether the row gets an arrow at all
      depends on the answer -- and an arrow that opens onto nothing is worse
      than no arrow. That is ~1 ms of file reading per playbook (50 playbooks
      in 43 ms across this repository), so it is not worth a cache; the tags
      are then re-read on every refresh, which is what keeps them true after
      an edit.
14. ✅ `playbookRunner.serviceEnvironments` limits which environments a skeleton is
    laid out in. This relaxes step 11's "every environment, always" on
    request: the default (`[]`) is still every environment, so the drift
    protection holds unless someone opts out of it in settings, and the
    command itself still takes no environment and is still not offered on an
    environment row. The choice lives in a setting rather than a picker so it
    is made once per workspace, not per service.

    The filtering is `selectEnvironments` in `src/scaffold.js`, so it is
    tested like the rest of the plan. A listed name is matched against the
    *discovered* environments only: one with no inventory file is reported
    (`unknownEnvironments`, shown in the confirmation) and never created,
    because a `group_vars/` under a directory discovery does not count as an
    environment is a folder the tree would never show.
15. ✅ renamed to *Playbook Runner* (`sebgad.playbook-runner`), and the
    identifier prefix with it: settings, commands and `contextValue`s are
    `playbookRunner.*`, the view `playbookRunnerExplorer`, the task type
    `playbook-runner`. *Ansible Runner* was dropped before it was released:
    it is the name of Ansible's own `ansible-runner` project, so it read as a
    Red Hat tool rather than one that works with Ansible. "Playbook" and
    "runner" are both generic words, and the description is where Ansible is
    named.

    The prefix was a **clean break**, by choice: no `homelab.*` or
    `homelabTasks.*` key is read and no old command id is kept as an alias,
    which also removed the 0.1 `homelabTasks.productionPattern` fallback from
    `src/settings.js`. There is a single user of this extension, so the
    fallbacks would have been code kept forever for one settings.json edit.

16. ✅ a dashboard in the editor area, beside the tree rather than instead of
    it: `src/dashboard.js`, the page in `media/dashboard/`, and
    `src/model.js`, which never imports `vscode`.

    The tree stays because it is the quick way in and costs nothing to keep;
    a webview replacing it would have had to rebuild context menus, keyboard
    navigation and accessibility by hand. What the tab adds is room: a
    services × last-run overview, a playbook's tasks, and a run bar.

    The page is a renderer. Everything it posts is parsed field by field by
    `parseWebviewMessage` (which also drops `extraArgs` -- the page has no way
    to type raw arguments) and matched by exact path against what the model
    offered, so a `../` spelling of a real playbook is refused along with a
    made-up one. A run goes into the same `startPlaybookRun` as every other
    run. The command line it previews is built by `model.playbookArgv`, the
    function `runner.runPlaybook` itself calls, so the preview cannot drift
    from what runs. Colours are theme variables only, and codicons are
    vendored into `media/codicons/` from `@vscode/codicons`, a dev dependency
    only so the files can be copied.

17. ✅ task ranges: *from*, *until* and *only* a task, through a strategy
    plugin shipped in `ansible/strategy/playbook_runner_range.py`.

    `--start-at-task` was the obvious tool and was **not** taken: it skips
    every task before the match whatever its tags, and adding
    `--tags podman-user-setup` to keep the setup tasks filters the start task
    out so it never matches. There is no stop flag at all. A strategy plugin
    is the one place that sees every task before it runs, so the range is
    decided there: setup-tagged tasks, fact gathering and includes before the
    start, everything in the range, only handlers after it.

    The outline the dashboard and pickers show comes from the same line
    scanner as the tags (step 12), now also walking tasks in run order. It
    was checked against `ansible-playbook --list-tasks` for every playbook in
    the repository: nothing it lists is missing. It lists more in one case on
    purpose -- the tasks of an `include_role`, which run under exactly those
    names -- and leaves out `rescue:`/`always:` tasks, as `--list-tasks` does.
    A templated task name is kept as written: ansible matches on the name
    before templating.

    **The accepted cost:** the plugin overrides a private method of
    ansible-core's `linear` strategy. An ansible-core upgrade can break it,
    and the only signal is `test/range-plugin.test.js`, which runs the real
    ansible-playbook against `localhost,` playbooks of `debug` tasks.
    Several things keep a broken or bypassed plugin from becoming a whole run
    nobody asked for: the plugin refuses an ansible-core it was not tested
    with, a `serial:` play, and a run without the one-shot token the extension
    writes into its status file (so VS Code's *Rerun Last Task* cannot replay a
    range unchecked); task names match on `get_name()` only, so a play task
    never matches a role task of the same bare name; a range is checked
    against a fresh outline before the run (unknown task, end before start,
    `strategy:` or `serial:`);
    the plugin prints a banner naming the range; and it writes whether each
    edge matched to a status file the extension reads when the task ends, so
    an edge that never matched marks the run failed. ansible-core takes its
    exit code from the last play and gives a strategy no hook after it, which
    is why the verdict travels by file rather than by exit code.

18. ✅ playbooks run in a reused terminal, not as a `vscode.Task` -- a
    reversal of the "Two execution paths" choice in step 5, for one reason.

    The Python Environments extension (`ms-python.vscode-python-envs`, default
    `autoActivationType: "command"`) types `source .venv/bin/activate.fish`
    into every new terminal of a folder with a venv. It means to skip task
    terminals, but recognises one by looking it up in
    `tasks.taskExecutions[].terminal`, which is not set yet when the terminal
    opens -- so sometimes it typed into the task, and `--ask-vault-password`
    read the activate line as the passphrase. Its log showed the sends as
    "(unverified)". The vault terminal was never recognised at all.

    The one terminal that extension always leaves alone is one created with
    `hideFromUser` (its `shouldSkipTerminalActivation`). A task cannot be
    created that way; a terminal can, and `show()` right after makes it an
    ordinary visible terminal. So playbooks now run in a "Playbook Runner"
    terminal per folder, reused while idle, and the vault terminal is created
    the same way.

    What was given up: *Terminate Task* (Ctrl+C does it) and VS Code's
    *Rerun Last Task* (*Playbook Runner: Re-run Last* remains, and goes
    through the checks). What was kept: the exit code, through shell
    integration's `executeCommand` and `onDidEndTerminalShellExecution`; a
    shell without shell integration still runs the command, and the run shows
    as *unknown*. A runner terminal with anything running in it is never typed
    into -- that would be the same bug -- so a second one opens. The command
    line is ` env -C <folder> [range env] <command> <args>`: the folder
    without moving the shell, the range variables for one command only, and a
    leading space to keep it out of history so ↑ cannot replay a range run.

19. ✅ the sidebar is gone; the dashboard is the whole UI. Step 16 kept the tree
    beside the dashboard "because it is the quick way in"; in use the dashboard
    was where the work happened, and the tree became a second, narrower copy
    of it. Everything the tree did moved over -- ▶ per playbook, a tag's ▷,
    Edit/Create vault per service, Rekey vaults per environment, New service,
    Re-run last, services with only group_vars -- and `src/tree.js`, the view
    container, its welcome view and its menus were removed, with the four
    commands only the tree used.

    The way in is a status bar item (`$(run-all) Playbook Runner`, `· N
    running` while playbooks run), so the extension now activates on
    `onStartupFinished`: with no view there is nothing else to activate it.
    VS Code cannot open an editor tab straight from an activity bar icon, and
    a launcher-only side panel would have been a sidebar again.

    The new actions follow the dashboard's rule from step 16: the message
    names things, `src/model.js` resolves the names against the model, and
    `src/dashboard.js` builds the command node from discovery's objects and
    calls the same command the palette runs.

20. ✅ a Settings tab in the dashboard: `src/settingsEdit.js`, which never
    imports `vscode`, decides whether a value may be saved
    (`validateSettingValue`, the same type rule `settings.js` reads by) and
    where (`settingTarget`). A `machine` setting goes to User settings
    whatever the page asks, which keeps the step-6 rule that a repository
    cannot name what gets executed; `MACHINE_SETTINGS` is pinned to
    package.json's `"scope": "machine"` entries by a test. Everything else is
    saved to the workspace by default, because the layout belongs to the
    repository. A `productionPattern` that does not compile is refused rather
    than saved: compiled, it would mean "no environment is production" and
    turn the confirmation off without a word.
21. ✅ environments can be created, renamed and deleted:
    `src/environments.js` + `playbookRunner.createEnvironment`,
    `renameEnvironment`, `deleteEnvironment`. Step 11's "the command never
    creates an inventory" still holds for the *service* skeleton; creating
    one is now a command of its own. Each is a plan first
    (`planEnvironment`, `planRename`, `planDelete`) and the confirmation
    shows the plan. A new environment modelled on another gets its group
    names (`inventoryGroupSkeleton`) and empty env files -- never hosts,
    because a copied host list deploys to the other environment's machines,
    and never vaults, because the passphrase is per environment. A rename
    is one `fs.renameSync`; the names that would dangle afterwards follow
    it (`renameInSetting` for `vaultPasswordFiles` and
    `serviceEnvironments`, `history.renameEnvironment`, the last run), and
    the two things that silently change with a name -- the production
    confirmation and a pattern-resolved password file -- are spelled out
    in the dialog. A delete is the one step not in a `vscode`-free module:
    `vscode.workspace.fs.delete(..., { useTrash: true })`, because only the
    editor can reach the trash, and there is deliberately no fallback to a
    permanent delete. The webview only says *which* environment; a new
    name is always asked for by the extension.
22. ✅ moved out of `homelab-infra/scripts/vscode-extension` into its own
    repository, `vscode-playbook-runner`, with its history (`git subtree
    split`). Nothing in the extension depended on where it sat -- the
    range plugin is found through `context.extensionPath` -- so only the
    development setup moved: `F5` opens `../homelab-infra`, and the
    range-plugin tests look for this repository's `.venv` before `PATH`.
    The design documents under `docs/superpowers/` and the Claude skills
    and agent came along as plain copies; their history stays in
    homelab-infra. Earlier steps keep the old path where they name it.

## 10. Verification

Automated (`npm test`, node --test):

- `test/discovery.test.js` — environment detection incl. a directory without an
  inventory file, playbook grouping, `(root)` group, recursion, `.yaml`, empty
  folders, the `hasVault` / `hasEnv` flags incl. a custom env filename, missing
  directories, and the service union (both halves, playbooks-only,
  vars-only, a vault without an env, per-environment differences).
- `test/command.test.js` — argument vectors against what the shell scripts
  produced, verbosity mapping, `--ask-vault-password` fallback, shell quoting.
- `test/tags.test.js` — the tags of a playbook and of every role it reaches,
  the three spellings of `tags:` (flow sequence, comma-separated scalar, block
  sequence, including one flush against its key), bare and `- role:` entries in
  a `roles:` block, `tasks_from`, `include_tasks`, an `import_playbook` chain
  and the file each tag is attributed to, a templated tag being skipped, a role
  nothing references staying out, a configured `rolesDir`, and the carried-over
  tag the scan no longer finds.
- `test/scaffold.test.js` — name validation (separators, leading dot, spaces),
  the planned entries and their order, a half-existing service, a custom
  layout, no environments at all, and that carrying out a plan neither
  truncates an existing `env.yml` nor touches the vault beside it.

Against the real repository, discovery reports what is actually there: 2
environments, 20 playbook groups / 46 playbooks, 19 existing + 2 creatable
vaults in production, 13 + 2 in staging, `staging.pass` picked up and
production falling back to a prompt — i.e. today's behaviour exactly.

Still to do by hand (needs a running editor, and hosts):

- F5 Extension Development Host: the tree renders; a `dns_servers` playbook runs
  against the right inventory; `ansible-vault edit` opens nano and saves;
  `create` on a `＋` row writes a new vault; adding a `.yml` refreshes the tree.
- Dry run without touching hosts: `⚙ → Check` on
  `playbooks/monitoring/setup-telegraf.yml`.
- Expanding `playbooks/authentik/authentik.yml` in the tree: 13 tag rows,
  `podman-user-setup` first and the `podman/deploy-app` ones labelled with the
  role; ▶ on `podman-kube-start` against `staging` runs it with exactly
  `--tags podman-kube-start`; `playbooks/nfs_servers/setup-network.yml` has no
  arrow at all.
- `⚙ → Tags` on `playbooks/authentik/authentik.yml` against `staging`: the
  checkbox list opens with the tags above, role tags labelled; ticking two and
  confirming puts exactly those on `--tags`; *Other…* opens the input box
  seeded with them. `⚙ → Tags` on `playbooks/nfs_servers/setup-network.yml`,
  which has no tags at all, goes straight to the input box.
- *Create Service Skeleton…* on a throwaway name: the path list matches what
  appears on disk, the service shows up under both environments with an *Env*
  and a ＋ *Vault* row, and a second run reports nothing to create.

## 11. Known trade-offs

- **Duplication is now permanent.** The `.sh` scripts and the extension
  implement the same flow in two languages; a change to the layout means
  touching both. That is the accepted cost of keeping the scripts usable over
  SSH.
- `tasks.json` keeps its hardcoded `staging.pass` and script paths. The
  extension no longer reads it, so those entries are reachable only through
  VS Code's own *Run Task* — and drift there will not show up in the sidebar.
- The extension shells out to `ansible-playbook` on `PATH`; no virtualenv
  detection. `playbookRunner.ansiblePlaybookCommand` is the escape hatch.
- The tag list is read by a line scanner, so it is a very good list rather than
  a guaranteed one — see step 12 for why `--list-tags` was not used and what
  *Other…* is there for. If a playbook ever stops being written the way this
  repository writes them, the symptom is a tag missing from the checkbox list,
  not a wrong command line.
