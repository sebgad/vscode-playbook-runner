# Playbook Runner — dashboard tab and task-scoped runs

Status: design, awaiting approval (2026-11-14)

## Why

The Playbook Runner works, but it is a narrow tree in the side bar. Sebastian
wants two things from this change:

1. **A nicer overview and design.** A dashboard in the editor area that shows
   the whole homelab at a glance, and a more polished feel overall.
2. **Running parts of a playbook by task**, not only by tag: *only this task*,
   *from this task*, *until this task*. Today you can only scope a run by tag.
   The dashboard should show each playbook's tasks so you can pick them there.

## Goals

- An **Open Dashboard** command opens a webview editor tab. The side bar tree
  stays.
- The dashboard shows services × environments, with the last run of each
  playbook. It expands a playbook into its plays and tasks, lets you pick a
  task range and run it.
- Task-scoped runs: from X, until X, only X (= from X until X). Available from
  the dashboard and from the ⚙ run-options picker.
- `--step` as a run option.
- Native polish: last-run status in the tree, a status bar item, a welcome
  view, tidier pickers.

## Non-goals

- Replacing the tree with the webview.
- Editing YAML or vaults inside the dashboard. Vaults still open in their own
  terminal, as they do now.
- Showing tasks that only exist at runtime (contents of a dynamic
  `include_tasks` with a templated file, loops that generate tasks).

## Anti-goals: it has failed even if it works when…

- A task-scoped run **silently runs the whole playbook**. Examples: the stop
  plugin was not loaded, or the task name never matched. This is the one
  failure that touches a host in a way you did not ask for.
- The dashboard becomes a **second way to build a command line** that skips
  `sanitizeRunOptions`, the production confirm modal or the remembered last
  run.
- The dashboard looks foreign in VS Code: hard-coded colours, broken in light
  or high-contrast themes.
- The extension gains a build step or a runtime npm dependency.

## Constraints from the existing design

These come from `.claude/skills/vscode-extension/SKILL.md` and `workflow.md`:

- No build step. Plain CommonJS and plain browser JS, typed with JSDoc and
  checked by `tsc --noEmit` under `strict`.
- Logic that shapes a command line, path or decision lives in a module that
  never imports `vscode`, and gets a `node --test` test.
- Argument vectors, never strings. Anything from `workspaceState` is untrusted.
  Every message from the webview is untrusted too, and is rebuilt field by
  field.
- No environment name or repo path is written in code. Defaults live in
  `defaults.js`.
- Tasks are read with the existing line scanner in `src/tags.js`, not with
  `ansible-playbook --list-tasks`. Step 12 explains why: that needs the
  inventory, the vault passphrase and ansible on `PATH`.

## Approaches considered

**Where the UI lives**

| Option | Trade-off |
| --- | --- |
| **Dashboard tab + tree** *(chosen)* | The tree stays for quick access. The tab is where a grid, run history and the task list have room. Costs a webview and its message passing. |
| Replace the tree with the webview | Context menus, keyboard navigation, accessibility and refresh would all have to be rebuilt by hand. |
| Move the tree to the bottom panel | Almost free, but no new overview. You can already drag the view there yourself. |

**Until-task and only-task.** Ansible has `--start-at-task` but no stop flag.

| Option | Trade-off |
| --- | --- |
| **Strategy plugin shipped with the extension** *(chosen)* | Real from/until/only runs that are remembered and can be re-run. It hooks into ansible-core internals (`linear` strategy), so an ansible upgrade can break it. That is guarded below. |
| `--step` and Ctrl-C | Built into Ansible, nothing to maintain. But stopping is manual and can't be repeated. *Also included as a plain run option.* |
| From-task only | The simplest, but drops half of the request. |

### A change from what was discussed: "from" also uses the plugin

In the conversation, *from* was going to be plain `--start-at-task`, with a
ticked-by-default "also run `podman-user-setup`" option. Checking ansible-core
2.22 showed that combination can't be done with flags:

- `--start-at-task` skips **every** task before the match, whatever its tags.
- Adding `--tags podman-user-setup` filters the play down to those tasks, so
  the start task is filtered out and never found.

So every task-scoped run goes through the plugin. The plugin runs:

- the selected range,
- plus any task carrying a **setup tag**, from the new setting
  `playbookRunner.setupTags` (default `["podman-user-setup"]`),
- plus fact gathering, `include_*`/`import_*` loader tasks and
  `meta: flush_handlers`.

That gives one mechanism with one set of tests, and *from X* no longer fails on
undefined facts. When the setup-tag list is empty, the plugin's *from* behaves
exactly like `--start-at-task`.

## Design

### 1. Task outline — `src/tags.js` (no `vscode`)

Extend the scanner so the same walk that collects tags also collects tasks.
It gets a new export, `findPlaybookOutline(root, playbookFile, settings)`:

```js
/** @typedef {{ name: string, tags: string[], file: string, line: number }} OutlineTask
 *  name is ansible's get_name(): "podman/deploy-app : Render manifest" inside a
 *  role, the bare name otherwise — verified against `--list-tasks` on 2.22.
 *  tags are the task's own tags plus inherited ones (play, role, block).
 *  line is 1-based, so the dashboard can open the task in the editor. */
/** @typedef {{ name: string, hosts: string, tasks: OutlineTask[] }} OutlinePlay */
/** @returns {{ plays: OutlinePlay[], strategy: string | null }} */
```

- Order is **run order**. That is the opposite of the tag list's deferred
  descent: a role's tasks appear where the role is referenced. The two
  orderings are kept apart, so the existing tag order and its tests do not
  change.
- Tasks with a `{{ }}` in their name and tasks without a name are left out of
  the list, but still counted, so the dashboard can say "+2 unnamed".
- `strategy` records any `strategy:` the playbook sets. A play-level
  `strategy:` overrides `ANSIBLE_STRATEGY`, which would bypass the plugin.
  `command.js` therefore refuses a task-scoped run on such a playbook, and the
  dashboard shows why. No playbook in the repo sets one today.
- Handlers are not listed. They are not run targets.
- Tests in `test/tags.test.js`: role prefix, `import_role` with `tasks_from`,
  `import_tasks` inside a role, `import_playbook` chain, templated names,
  inherited tags, `.yaml`, symlink cycle, multiple plays, line numbers.

### 2. Run options — `src/command.js` (no `vscode`)

`RunOptions` gains:

```js
 * @property {string} [fromTask]
 * @property {string} [untilTask]
 * @property {boolean} [step]
```

- `sanitizeRunOptions` keeps them only as non-empty trimmed strings, or `true`.
  No length limit is needed, since they go out as argv and env, never through
  a shell.
- `buildPlaybookArgs` adds `--step` when `step` is set. The task range is
  **not** an argument. Instead a new
  `buildPlaybookEnv(options, settings, pluginDir)` returns the env additions:
  `ANSIBLE_STRATEGY_PLUGINS=<pluginDir>`, `ANSIBLE_STRATEGY=playbook_runner_range`,
  `PLAYBOOK_RUNNER_FROM_TASK`, `PLAYBOOK_RUNNER_UNTIL_TASK`,
  `PLAYBOOK_RUNNER_SETUP_TAGS` (JSON). It returns `{}` when there is no range.
- A range combined with `--tags` is allowed. Tags filter first, then the range
  applies to what is left. The dashboard previews the command line, so this
  shows up.
- `runner.runPlaybook` passes the env through `ShellExecution`'s `env` option.
  The env and the extra argv reach the task's terminal, so the run says what it
  is doing.
- Tests in `test/command.test.js`: env for from-only, until-only, from = until,
  no range → `{}`, `--step` position, sanitising junk (numbers, objects,
  whitespace).

### 3. The strategy plugin — `ansible/strategy/playbook_runner_range.py`

It lives in the extension folder and is found through
`context.extensionPath`, so it ships inside the `.vsix`. It subclasses
`ansible.plugins.strategy.linear.StrategyModule` and wraps
`_get_next_task_lockstep`: it keeps calling the parent until it gets a
`(host, task)` batch that should run, or nothing is left.

How it decides, with state kept at module level because each play gets a new
strategy instance:

- Before the *from* match: run only setup-tagged tasks, `gather_facts`, loader
  tasks (`include_*`, `import_*`) and `meta`. Skip everything else.
- When a task's `get_name()` (or its bare name) equals `FROM_TASK`, the range
  starts. Matching is **exact**, not `fnmatch` like `--start-at-task`: the
  names always come from the outline, and a task called `Install [extras]`
  must not turn into a glob.
- A name that appears more than once (a role used in two plays): *from* is
  its first occurrence, *until* is the first occurrence at or after *from*.
- Inside the range: run everything.
- After the `UNTIL_TASK` batch has run: let only `meta: flush_handlers`
  through, so handlers already notified still fire (a changed template still
  restarts its service). Skip everything else in this play and all later
  plays, fact gathering included.

Fail-safes, which answer the main anti-goal:

- On load it prints `Playbook Runner: running from «X» until «Y»` through
  `display.banner`. If the run's output lacks that line, the plugin was
  bypassed. The extension cannot see the output, but you will.
- **Before the run**, `command.js` checks both names against a fresh outline
  and refuses an unknown name or an *until* that comes before *from*. This
  also catches a remembered last run whose task has since been renamed. It is
  the guard that actually prevents the anti-goal.
- **After the run**, a range edge that never matched still counts as a
  **failed run** in the extension: the history entry, the status bar and an
  error notification say *from-task never matched, nothing in the range ran*
  or *until-task never matched, the run went to the end*. ansible-core takes
  its exit code from the last play's result and gives a strategy plugin no
  hook after the last play, so the plugin reports through a status file
  instead: `PLAYBOOK_RUNNER_STATUS_FILE`, a JSON file
  `{ fromMatched, untilMatched }` under the extension's global storage,
  rewritten whenever either changes. The extension reads it when the task
  ends. The ansible exit code itself is left alone. A missed *from* never
  touches a host, because until it matches only setup tasks run.
- If the strategy setting was ignored (a play-level `strategy:` that slipped
  past the scanner), the env vars are present but the plugin never ran.
  There's no way to catch that from inside Ansible, which is why
  `command.js` refuses the run up front.
- Tests: `test/range-plugin.test.js` under `node --test`, so it runs inside
  `npm run check` and reaches the plugin through the real env from
  `buildPlaybookEnv`. It runs `ansible-playbook` (the repo's `.venv`, else
  `PATH`) against a temp playbook with inventory `localhost,`, `connection:
  local` and only `debug` tasks, and is skipped when no ansible-playbook is
  found. Cases: from, until, only, setup tags, handlers, multi-play, a
  duplicated name and the status file for a non-matching name. It pins the
  behaviour to the installed ansible-core (2.22 today).

### 4. Run history — new `src/history.js` (no `vscode`)

- `workspaceState` key `playbookRunner.runHistory`: an array, newest first,
  capped at 200 entries, `{ folder, environment, playbook, label, options,
  startedAt, endedAt?, exitCode?, status }`. `status` is one of `running`,
  `passed`, `failed`, `cancelled` or `unknown`, plus an optional `message`
  (the range-plugin verdict). Rebuilt field by field on read, like
  `parseLastRun`.
- `extension.js` writes it from `tasks.onDidStartTaskProcess` and
  `onDidEndTaskProcess`, filtered to `definition.type === "playbook-runner"`.
  A missing exit code (Terminate Task) counts as `cancelled`. `running`
  entries left over from a closed window become `unknown` on activation, not
  `cancelled`: a task terminal can outlive a window reload, so the run may
  well have finished.
- Helpers: `latestFor(env, playbook)` and `relativeTime(ms)` ("3 min ago"),
  tested.

### 5. Dashboard — `src/dashboard.js` (editor surface) + `media/dashboard/`

- `playbookRunner.openDashboard` (codicon `dashboard`) appears in the view
  title bar and the command palette. There is one panel, revealed if it is
  already open. A `WebviewPanelSerializer` restores it after a reload, keeping
  the selected environment and service in `vscode.setState`.
- **Data in.** A new vscode-free `src/model.js` builds one JSON model from
  `findEnvironments`, `findServices`, the outline and the history. That keeps
  the shape testable. It is posted again when `Watchers` fires and when the
  history changes.
- **Data out.** The webview posts `{ type: "run", folder, environment,
  playbook, options }` and `{ type: "open", file, line }`. `dashboard.js`
  resolves `folder`, `environment` and `playbook` against the current
  discovery result, so it never acts on a path the webview made up. Options go
  through `sanitizeRunOptions`, and the call goes into the same
  `runPlaybookCommand` path the tree uses, with the same production modal,
  lastRun and history. The modal also names the task range.
- **Look.** Only VS Code theme variables (`--vscode-editor-background`,
  `--vscode-button-*`, `--vscode-charts-red` for production, and so on). Only
  the VS Code font stacks. Codicons are vendored as `media/codicon.css` and
  `codicon.ttf` from `@vscode/codicons` (CC BY 4.0 font, MIT CSS, licence file
  alongside). Strict CSP with a nonce, `localResourceRoots: [media/]`. Tested
  in a dark, a light and a high-contrast theme.
- **Layout.**

```
┌ Playbook Runner ──────────────────────────────── [staging] [production●] ⟳ ┐
│ ⚠ production — runs ask for confirmation                                   │
├────────────────────────┬───────────────────────────────────────────────────┤
│ Services        filter │ authentik                                         │
│ ● authentik    ✓ 3m    │ ▾ authentik.yml        ✓ 3 min ago      ▶  ⚙      │
│ ● dns_servers  ✗ 1d    │   Play: Deploy authentik  (podman_servers)        │
│ ○ immich       —       │    ⊢ podman/user-setup : Create user   setup      │
│ …                      │    ⊢ storage/nfs : Mount data          nfs        │
│                        │    ▸ podman/deploy-app : Render manifest  ◀ from  │
│                        │    ▸ podman/deploy-app : Start unit       ◀ until │
│                        │    · nginx : Write vhost                          │
├────────────────────────┴───────────────────────────────────────────────────┤
│ Range: from «Render manifest» until «Start unit» + setup tags   [✕ clear]  │
│ ☐ check ☐ diff ☐ step  verbosity [0▾]  limit [      ]                      │
│ $ ansible-playbook -i inventories/production/hosts.ini … (env shown)       │
│                                             [ ▶ Run range on production ]  │
└────────────────────────────────────────────────────────────────────────────┘
```

  - Left: the services in the chosen environment, each with a status dot for
    its playbooks' latest run, and a text filter.
  - Right: the service's playbooks. Each expands into plays and tasks with tag
    chips. A task row shows on hover: *only this*, *from here*, *until here*,
    *open in editor*. Clicking two rows also sets a range. Setup-tagged tasks
    before the range are marked as "will also run".
  - Bottom bar: run options plus a **live preview of the command line**,
    built in the extension by `buildPlaybookArgs` and `buildPlaybookEnv` and
    sent to the webview, never built in the webview. The Run button names the
    environment and turns production red.
  - A playbook whose outline found nothing shows "No tasks found by the
    scanner. ⚙ still runs it by tag." A playbook with a `strategy:` shows
    "Task ranges are unavailable: this playbook sets `strategy:`".
- Keyboard: rows are focusable buttons with ARIA roles. Arrow keys move
  through them, Enter runs the default action.

### 6. Native polish

- **Tree last-run status:** each playbook row's description becomes
  `✓ 3 min ago` / `✗ 1 d ago` / `running…`, with a `loading~spin` icon while
  running. The view badge counts running playbooks. No `FileDecorationProvider`
  for now. The description is enough.
- **Status bar item:** shows the latest run on the left
  (`$(pass) staging · authentik.yml · 3m`). Clicking it runs
  `playbookRunner.rerunLast`. It uses the `statusBarItem.errorBackground` theme
  colour after a failed run, and hides when there is no history.
- **Welcome view:** `viewsWelcome` when no environment is found. It explains
  where inventories are looked for (the configured settings) and has buttons
  for *Open Settings* and *Open Dashboard*.
- **Pickers:** `QuickPickItemKind.Separator` between *Scope* (tags, from-task,
  until-task) and *Output* (verbosity, check, diff, step). `ignoreFocusOut` on
  every multi-step picker. The task picker is a QuickPick of the outline,
  grouped by play with separators, and shows each task's tags as its
  `description`.

### 7. Docs

- `README.md`: tree sketch, dashboard section, settings table
  (`setupTags`).
- `CHANGELOG.md`: entry under the next version.
- `workflow.md`: new numbered steps for the dashboard and for the strategy
  plugin, including the accepted trade-off that it depends on ansible-core
  internals and how that is guarded.
- The skill file's module boundary table gains `history.js` and `model.js`.

## Decided in conversation

- Dashboard tab alongside the tree, not instead of it.
- Polish items: last-run status, status bar item, welcome / empty state,
  nicer pickers.
- Task runs: only / from / until, through a shipped plugin, plus `--step`.

## My calls, for you to check

- *From* goes through the plugin too, with `setupTags` defaulting to
  `podman-user-setup` (see "A change from what was discussed").
- After *until*, handlers that were already notified still run.
- A range edge that never matches fails the run, rather than passing quietly.
- Tasks are shown in the dashboard. The side bar tree keeps its tag rows and
  does not grow a task level, to keep it short.
- 200-entry run history in workspace state.
- Vendored codicons rather than inline SVG.

## Left to the builder

- Exact CSS, spacing and empty-state wording.
- Whether `findPlaybookOutline` shares a single pass with `findPlaybookTags`
  or walks separately. The two orderings must stay as described.
- How the webview's JS is typed (`// @ts-check` with JSDoc is enough).
- Which Python runs the plugin tests. The repo's `.venv` (via `uv run`, as
  the toolchain already does) is the obvious one. Make sure `ansible/` and
  `media/` are not excluded from the `.vsix` by `.vscodeignore` or `files`.

## Verification

- `npm run check`: eslint, tsc, node tests, plus the plugin's Python tests.
- F5 checklist handed back: open the dashboard, switch environments, expand
  `authentik.yml` tasks, set a range, confirm the command preview, then run
  **⚙ → Check** on a staging playbook with a from/until range. That's a dry
  run. Never against production.
