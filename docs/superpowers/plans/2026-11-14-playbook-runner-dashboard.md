# Playbook Runner dashboard and task-scoped runs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dashboard editor tab and from/until/only-task runs to the Playbook Runner extension, plus last-run status, a status bar item, a welcome view and tidier pickers.

**Architecture:** Every decision is made in modules that never import `vscode`, and those modules are tested with `node --test`: the outline scanner (`src/tags.js`), the run options, env and range check (`src/command.js`), the run history (`src/history.js`) and the dashboard model and message parsing (`src/model.js`). A small ansible strategy plugin (`ansible/strategy/playbook_runner_range.py`) does the task-range skipping, enabled per run through env vars. The webview (`src/dashboard.js` + `media/dashboard/`) only renders. Every run it asks for goes through the same `runPlaybookCommand` path as the tree.

**Tech Stack:** VS Code extension API (engine `^1.75.0`), plain CommonJS + JSDoc under `tsc --noEmit --strict`, `node:test`, ansible-core 2.22 (Python strategy plugin), vendored `@vscode/codicons`.

**Spec:** [docs/superpowers/specs/2026-11-14-playbook-runner-dashboard-design.md](../specs/2026-11-14-playbook-runner-dashboard-design.md). Read it and `.claude/skills/vscode-extension/SKILL.md` before Task 1.

## Global Constraints

- No build step, no runtime npm dependency. `npm run package` keeps `--no-dependencies`.
- `src/defaults.js`, `src/discovery.js`, `src/command.js`, `src/paths.js`, `src/tags.js`, and the new `src/history.js` and `src/model.js` never `require("vscode")`.
- Argument vectors are arrays, never concatenated strings. Env values are passed through `ShellExecution`'s `options.env`, never put into the command string.
- Everything read from `workspaceState` or received from the webview is rebuilt field by field, never spread.
- No environment name or repo path in code. The only new default is `setupTags: ["podman-user-setup"]` in `defaults.js`.
- Task names match **exactly** (no `fnmatch`). Role tasks are named `"<role as referenced> : <task name>"`, e.g. `podman/deploy-app : Render manifest`.
- Strategy name `playbook_runner_range`. Env vars: `ANSIBLE_STRATEGY_PLUGINS`, `ANSIBLE_STRATEGY`, `PLAYBOOK_RUNNER_FROM_TASK`, `PLAYBOOK_RUNNER_UNTIL_TASK`, `PLAYBOOK_RUNNER_SETUP_TAGS` (JSON array), `PLAYBOOK_RUNNER_STATUS_FILE`.
- History: `workspaceState` key `playbookRunner.runHistory`, newest first, max 200, statuses `running | passed | failed | cancelled | unknown`.
- Webview colours come only from `--vscode-*` CSS variables. Production uses `--vscode-charts-red`. CSP with a nonce, `localResourceRoots` = `media/`.
- Never run a playbook against a real inventory. The only `ansible-playbook` invocation allowed is Task 3's test, against inventory `localhost,` with `connection: local` and only `debug` tasks.
- `npm run check` (eslint + tsc + node --test) passes at the end of every task.
- Commit on `main` after each task, staging **only that task's files** (`git add <paths>`, then `git commit -- <paths>` if other changes are staged). The working tree holds unrelated uncommitted work. End every message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A remembered last run whose task was renamed or deleted.** *Re-run Last* must refuse with a message naming the missing task, never fall back to a full run. Test: `validateTaskRange` cases in Task 2. The wiring in `rerunLast` is in Task 5.
2. **Task names with glob or shell characters** (`Install [extras]`, `it's *done*`). They must match only themselves and reach ansible intact. Test: Task 3, `exact match, glob characters`.
3. **The same task name twice in one playbook** (a role used by two plays). *until* stops at the first occurrence at or after *from*, not the first overall. Test: Task 3, `duplicated name`.
4. **A webview message naming a file outside discovery** (`playbook: "/etc/passwd"`, `../`, an unknown environment). It is dropped without running or opening anything. Test: Task 7, `resolveRunRequest rejects`.
5. **A window reload while a playbook runs.** Its history entry becomes `unknown`, not `failed`, and the tree doesn't keep spinning. Test: Task 4, `settleStale`.

---

### Task 1: Playbook outline in the tag scanner

**Files:**
- Modify: `src/tags.js`
- Test: `test/tags.test.js`

**Interfaces:**
- Produces:
  ```js
  /** @typedef {{ name: string, bareName: string, role: string | null, tags: string[], file: string, line: number }} OutlineTask */
  /** @typedef {{ name: string, hosts: string, tasks: OutlineTask[] }} OutlinePlay */
  /** @typedef {{ plays: OutlinePlay[], strategy: string | null, skipped: number }} PlaybookOutline */
  function findPlaybookOutline(root, playbookFile, settings) /* → PlaybookOutline */
  function outlineTaskNames(outline) /* → string[], flattened, run order, duplicates kept */
  ```
  `name` is ansible's `get_name()`. `bareName` is the `name:` value. `role` is the role as referenced (`podman/deploy-app`), or null. `tags` are the task's own tags plus the inherited play, role-reference and block tags, without duplicates. `line` is 1-based. `skipped` counts tasks left out (unnamed, or `{{` in the name). `strategy` is the first `strategy:` value at play level, else null.

- [ ] **Step 1: Write the failing tests** in a new `describe("findPlaybookOutline")`, with fixtures from `makeFixture`:
  - `role tasks carry the role prefix`: a playbook with a play task `top task`, then `roles: [podman/deploy-app]` whose `tasks/main.yml` has `inner task` → names `["top task", "podman/deploy-app : inner task"]`, `role` `null` / `"podman/deploy-app"`. (This matches `ansible-playbook --list-tasks` on 2.22; see the spec.)
  - `run order, not tag order`: `import_role` with `tasks_from: setup` in the middle of two play tasks → the role's tasks appear between them.
  - `import_tasks inside a role keeps the role prefix`; `import_playbook chain becomes extra plays`; `multiple plays keep name and hosts`.
  - `inherited tags`: play `tags: [p]`, a role reference with `tags: deploy-app`, a block with `tags: [b]` → a task inside the role has `tags` containing `p` and `deploy-app`, and a task in the block has `p` and `b`.
  - `templated and unnamed tasks are skipped and counted`: `- name: "Install {{ pkg }}"` plus one `- debug:` without a name → neither is listed, `skipped === 2`.
  - `strategy is reported`: `strategy: free` on a play → `outline.strategy === "free"`. Without it → `null`.
  - `line numbers are 1-based and point at the "- name:" line`.
  - `.yaml task files`, `symlink cycle terminates` (reuse the existing cycle fixture shape), `missing playbook → { plays: [], strategy: null, skipped: 0 }`.
  - `findPlaybookTags order is unchanged`: the existing tag-order test still passes untouched.

- [ ] **Step 2: Run** `node --test test/tags.test.js`. Expected: the new tests FAIL with `findPlaybookOutline is not a function`.

- [ ] **Step 3: Implement `findPlaybookOutline` in `src/tags.js`.** Write a separate walk that reuses the existing line helpers (`readLine`, `blockAfter`, `inlineField`, `fieldIn`, `resolveRole`, `resolveFile`, `realPathOrNull`, `MAX_FILES`). It must not reuse `scanFile`, whose deferred descent produces tag order, not run order: here a reference descends *in place*. A play starts at a top-level sequence item that has `hosts:`. Tasks are sequence items under `pre_tasks`, `tasks`, `post_tasks` (in that order per play, as ansible runs them, with `roles:` between `pre_tasks` and `tasks`) and inside `block`/`rescue`/`always`. Handlers are ignored. Export both functions.

- [ ] **Step 4: Run** `node --test test/tags.test.js`. Expected: all PASS. Then `npm run check`. Expected: PASS.

- [ ] **Step 5: Commit** `src/tags.js test/tags.test.js`, with the message `Read a playbook's tasks in run order`.

---

### Task 2: Task-range run options, env and pre-flight check

**Files:**
- Modify: `src/command.js`, `src/defaults.js`, `package.json` (configuration + `taskDefinitions`)
- Test: `test/command.test.js`

**Interfaces:**
- Consumes: `PlaybookOutline`, `outlineTaskNames` (Task 1).
- Produces:
  ```js
  // RunOptions gains: fromTask?: string, untilTask?: string, step?: boolean
  function hasTaskRange(options) /* → boolean */
  function buildPlaybookEnv(spec) /* spec: { options: RunOptions, setupTags: string[], pluginDir: string, statusFile: string } → Record<string,string> */
  function validateTaskRange(outline, options) /* → string | null  (null = ok, else a user-facing reason) */
  function describeRun(label, options) /* → string, e.g. "authentik.yml --tags deploy-app from «A» until «B»" */
  const RANGE_STRATEGY = "playbook_runner_range";
  ```
- `Settings` gains `setupTags: string[]` (default `["podman-user-setup"]`).

- [ ] **Step 1: Write the failing tests:**
  - `sanitizeRunOptions keeps task range and step`: `{ fromTask: "  A ", untilTask: "B", step: true }` → `{ fromTask: "A", untilTask: "B", step: true }`. `{ fromTask: 3, untilTask: {}, step: "yes" }` → `{}`. `{ fromTask: "   " }` → `{}`.
  - `buildPlaybookArgs adds --step before extraArgs and never carries the range`: with `{ step: true, fromTask: "A", extraArgs: ["-e", "x=1"] }` the argv ends `["--step", "-e", "x=1"]` and contains neither `"A"` nor `--start-at-task`.
  - `buildPlaybookEnv without a range is empty`: `{}` for `{ tags: "x", step: true }`.
  - `buildPlaybookEnv for from-only / until-only / from=until`, with `pluginDir: "/ext/ansible/strategy"`, `statusFile: "/s/run.json"`, `setupTags: ["podman-user-setup"]` → exactly
    `{ ANSIBLE_STRATEGY_PLUGINS: "/ext/ansible/strategy", ANSIBLE_STRATEGY: "playbook_runner_range", PLAYBOOK_RUNNER_FROM_TASK: "A", PLAYBOOK_RUNNER_UNTIL_TASK: "", PLAYBOOK_RUNNER_SETUP_TAGS: '["podman-user-setup"]', PLAYBOOK_RUNNER_STATUS_FILE: "/s/run.json" }` (the until case leaves `FROM_TASK` as `""`).
  - `validateTaskRange`, with outline names `["a", "r : b", "c"]`:
    - `{}` → `null`
    - `{ fromTask: "r : b" }` → `null`
    - `{ fromTask: "zz" }` → a string containing `zz` and `not found`
    - `{ fromTask: "c", untilTask: "a" }` → a string containing `before`
    - outline with `strategy: "free"` and any range → a string containing `strategy`
    - names `["x", "y", "x"]` with `{ fromTask: "y", untilTask: "x" }` → `null` (the second `x` follows `y`)
  - `describeRun`: `("p.yml", { tags: "t", fromTask: "A", untilTask: "A" })` → `"p.yml --tags t only «A»"`. From/until-only and both produce `from «A»`, `until «B»`, `from «A» until «B»`.

- [ ] **Step 2: Run** `node --test test/command.test.js`. Expected: FAIL on the missing exports.

- [ ] **Step 3: Implement** in `src/command.js` as specified. Add `setupTags` to `defaults.js` and the `Settings` typedef. In `package.json`, add `playbookRunner.setupTags` (array of string, `markdownDescription` explaining that these tags still run before a *from* task) and add `runId` (string) to the `playbook-runner` task definition properties.

- [ ] **Step 4: Run** `npm run check`. Expected: PASS.

- [ ] **Step 5: Commit** `src/command.js src/defaults.js package.json test/command.test.js`, with the message `Model task-range runs as run options and env`.

---

### Task 3: The range strategy plugin

**Files:**
- Create: `ansible/strategy/playbook_runner_range.py`
- Create: `test/range-plugin.test.js`
- Modify: `.vscodeignore` (add `**/__pycache__/**`), `.gitignore` (same)

**Interfaces:**
- Consumes: `buildPlaybookEnv`, `RANGE_STRATEGY` (Task 2).
- Produces: a strategy module named `playbook_runner_range`, and a status file of the form `{"fromMatched": bool, "untilMatched": bool}`, rewritten whenever either value changes and once at plugin load.

- [ ] **Step 1: Write the failing test** `test/range-plugin.test.js`. Find `ansible-playbook` at `path.resolve(__dirname, "../../../.venv/bin/ansible-playbook")`, else on `PATH`. If neither exists, `describe(..., { skip: "ansible-playbook not found" })`. For each case, write a temp playbook (`hosts: localhost`, `connection: local`, `gather_facts: false`, tasks are `ansible.builtin.debug: msg=<name>`), run it with `spawnSync(bin, ["-i", "localhost,", pb], { env: { ...process.env, ...buildPlaybookEnv(...), ANSIBLE_NOCOLOR: "1" } })`, and assert on which `msg` values appear in stdout and on the status file JSON:
  - `from`: tasks `s1`(tag `podman-user-setup`), `a`, `b`, `c`, with `fromTask: "b"` → ran `s1, b, c`, did not run `a`. Status `{fromMatched: true, untilMatched: false}`.
  - `until`: `untilTask: "b"` → ran `s1, a, b`, not `c`.
  - `only`: `fromTask = untilTask = "b"` → ran `s1, b`.
  - `setup tags empty`: `setupTags: []`, `fromTask: "b"` → ran `b, c` only.
  - `handlers notified inside the range still fire after until`: `b` has `changed_when: true` + `notify: h`, `untilTask: "b"` → handler `h` ran, `c` did not.
  - `multi-play`: two plays, `untilTask` in play 1 → no task of play 2 ran.
  - `role prefix`: a role `r` with task `t`, `fromTask: "r : t"` → `t` ran.
  - `duplicated name`: play 1 has `x`, `y`, play 2 has `x`, `z`, with `fromTask: "y"`, `untilTask: "x"` → ran `y` and play 2's `x`, not `z`, not play 1's `x`.
  - `exact match, glob characters`: tasks `Install [extras]`, `Installe`, `it's *done*`, with `fromTask = untilTask = "Install [extras]"` → only that one ran. Then `fromTask = untilTask = "it's *done*"` → only that one ran.
  - `non-matching until`: `untilTask: "nope"` → all tasks ran, status `untilMatched: false`. `non-matching from`: `fromTask: "nope"` → only setup-tagged tasks ran, status `fromMatched: false`.
  - `banner`: stdout contains `Playbook Runner: running`.

- [ ] **Step 2: Run** `node --test test/range-plugin.test.js`. Expected: FAIL with ansible reporting that it could not find strategy `playbook_runner_range`.

- [ ] **Step 3: Implement the plugin.** It subclasses `ansible.plugins.strategy.linear.StrategyModule`, keeps state at module level (a fresh strategy instance is made per play), and overrides `_get_next_task_lockstep(self, hosts, iterator)` to call `super()` in a loop until it returns a batch `keep(task)` accepts, or an empty batch. In `keep`:
  - Always keep: `isinstance(task, Handler)`; `task.action in C._ACTION_META` with `task.args.get("_raw_params")` in `{"flush_handlers", "role_complete", "noop", "end_role"}`.
  - If *until* has already run: keep nothing else.
  - If *from* hasn't matched yet: keep `C._ACTION_FACT_GATHERING`, `C._ACTION_ALL_INCLUDES`, and tasks whose `task.tags` intersect the setup tags. A task whose `get_name()` or `name` equals `FROM_TASK` sets `fromMatched` and is kept. An empty `FROM_TASK` counts as matched from the start.
  - Inside the range: keep everything. A kept task whose `get_name()` or `name` equals `UNTIL_TASK` sets `untilMatched`, and every task after it is skipped.
  - Print the banner once, via `Display().banner("Playbook Runner: running from «X» until «Y»")` (use "the start" / "the end" for an empty edge).
  - Write the status file with `json.dump` whenever a flag changes. Never raise on an I/O error; `display.warning` instead.

  Add the standard `DOCUMENTATION = """ name: playbook_runner_range ... """` header so `ansible-doc -t strategy` can list it.

- [ ] **Step 4: Run** `node --test test/range-plugin.test.js`. Expected: all PASS (or skipped, with the notice, when no ansible is installed). Then `npm run check`.

- [ ] **Step 5: Commit** `ansible/ test/range-plugin.test.js .vscodeignore .gitignore`, with the message `Ship an ansible strategy that runs a task range`.

---

### Task 4: Run history

**Files:**
- Create: `src/history.js`
- Test: `test/history.test.js`

**Interfaces:**
- Consumes: `sanitizeRunOptions` (Task 2).
- Produces:
  ```js
  /** @typedef {"running"|"passed"|"failed"|"cancelled"|"unknown"} RunStatus */
  /** @typedef {{ id: string, folder: string, environment: string, playbook: string, label: string, options: RunOptions, startedAt: number, endedAt?: number, exitCode?: number, status: RunStatus, message?: string }} RunEntry */
  const HISTORY_KEY = "playbookRunner.runHistory", MAX_ENTRIES = 200;
  function parseHistory(value) /* unknown → RunEntry[] */
  function startRun(history, entry) /* → RunEntry[] (prepended, capped) */
  function finishRun(history, id, { exitCode, endedAt, rangeStatus }) /* rangeStatus: {fromMatched,untilMatched}|null → RunEntry[] */
  function settleStale(history) /* running → unknown */
  function latestFor(history, folder, environment, playbook) /* → RunEntry | null */
  function relativeTime(ms, now) /* → "just now" | "3 min ago" | "5 h ago" | "2 d ago" */
  ```

- [ ] **Step 1: Write the failing tests:**
  - `parseHistory` drops non-arrays, entries missing `id`, `folder`, `environment` or `playbook`, unknown statuses and non-finite timestamps. It runs `options` through `sanitizeRunOptions` (an injected `extraArgs: [1, "-e"]` → `["-e"]`) and caps at 200.
  - `startRun` prepends and caps at 200 (201 inserts → length 200, the oldest dropped).
  - `finishRun`: exitCode `0` → `passed`. `2` → `failed`. `undefined` → `cancelled`. With `rangeStatus {fromMatched:false}` and exitCode 0 → `failed`, message `from-task never matched, nothing in the range ran`. With `{fromMatched:true, untilMatched:false}` on a run that had `untilTask` → `failed`, message `until-task never matched, the run went to the end`. An unknown id → unchanged.
  - `settleStale`: a `running` entry → `unknown`. The others are untouched.
  - `latestFor` returns the newest matching entry, else `null`.
  - `relativeTime(now - 30_000, now)` → `"just now"`. `- 3*60_000` → `"3 min ago"`. `- 5*3_600_000` → `"5 h ago"`. `- 2*86_400_000` → `"2 d ago"`.

- [ ] **Step 2: Run** `node --test test/history.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/history.js`. Pure functions that return new arrays. It never imports `vscode`.
- [ ] **Step 4: Run** `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `src/history.js test/history.test.js`, with the message `Keep a run history with pass/fail per playbook`.

---

### Task 5: Wire ranges, history and status files into the run path

**Files:**
- Modify: `src/runner.js`, `extension.js`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `runner.runPlaybook(folder, settings, request)` where `request` gains `env?: Record<string,string>` and `runId: string`, which goes into the task definition.
  - In `extension.js`, a `RunTracker` class: `constructor(context, onChange)`, `get history(): RunEntry[]`, `begin(entry)`, a `dispose()` that is registered in subscriptions, and `onChange` fired after every write. It listens to `vscode.tasks.onDidStartTaskProcess` / `onDidEndTaskProcess`, matching `execution.task.definition.type === "playbook-runner"` and `definition.runId`. On end it reads and deletes the status file (when present) and calls `finishRun`. If the result has a `message`, it shows `vscode.window.showErrorMessage("Playbook Runner: <label>: <message>")`. On construction it runs `settleStale`.
  - `runPlaybookCommand` and `rerunLast` both go through one helper, `startPlaybookRun(context, tracker, { folder, settings, environment, playbookFile, options })`. That helper:
    1. if `hasTaskRange(options)`, calls `validateTaskRange(findPlaybookOutline(...), options)`; on a reason, shows `showErrorMessage` and returns;
    2. runs `confirmProduction` with `describeRun(label, options)`;
    3. writes lastRun;
    4. builds the env with `pluginDir = path.join(context.extensionPath, "ansible", "strategy")` and `statusFile = path.join(context.globalStorageUri.fsPath, "runs", runId + ".json")` (creating the directory first);
    5. calls `tracker.begin` and `runner.runPlaybook`.
  - `runId` = `crypto.randomUUID()`.

- [ ] **Step 1: Implement** the above. `runPlaybookCommand` keeps its node and picker resolution unchanged and hands over to `startPlaybookRun`.
- [ ] **Step 2: Run** `npm run check`. Expected: PASS.
- [ ] **Step 3: Commit** `src/runner.js extension.js`, with the message `Run task ranges through the plugin and record every run`.

(This task is verified by hand in Task 9's F5 checklist. The decisions it makes are already covered by Tasks 2–4.)

---

### Task 6: Native polish — tree status, badge, status bar, welcome view, pickers

**Files:**
- Modify: `src/tree.js`, `src/pickers.js`, `extension.js`, `package.json`

**Interfaces:**
- Consumes: `RunTracker.history`, `latestFor`, `relativeTime` (Tasks 4–5); `findPlaybookOutline` (Task 1).
- Produces:
  - `PlaybookRunnerTreeProvider` gets a `constructor(getHistory)` where `getHistory: () => RunEntry[]`. `PlaybookNode.description` becomes `✓ 3 min ago` / `✗ 1 d ago` / `cancelled` / `running…` (no description without history). The icon is `loading~spin` while running.
  - `extension.js`: `vscode.window.createTreeView("playbookRunnerExplorer", { treeDataProvider })` replaces `registerTreeDataProvider`. `treeView.badge = { value: n, tooltip: "n running" }` when n > 0, else `undefined`.
  - A status bar item (left, priority 10): `$(pass)|$(error)|$(loading~spin)|$(circle-slash) <env> · <playbook label> · <relativeTime>`, `command: "playbookRunner.rerunLast"`, with `backgroundColor = new ThemeColor("statusBarItem.errorBackground")` after a failure. Hidden when there is no history. Relative time is refreshed every 60 s by a `setInterval`, cleared in dispose.
  - `package.json` `viewsWelcome` for `playbookRunnerExplorer`, shown when `playbookRunner.noEnvironments` is set. `extension.js` sets that context key with `setContext` after each refresh, from `findEnvironments` over all folders. The text names `playbookRunner.inventoriesDir` / `inventoryFile` and has buttons `[Open Settings](command:workbench.action.openSettings?%5B%22playbookRunner%22%5D)` and `[Open Dashboard](command:playbookRunner.openDashboard)`.
  - `pickers.pickRunOptions(previous, availableTags, outline)`: items are grouped under `QuickPickItemKind.Separator` labels **Scope** (Tags, From task, Until task) and **Output** (Verbosity, Limit, Check, Diff, Step), with `ignoreFocusOut: true` on it and on every follow-up picker. The new `pickTask(outline, title, previousName)` is a QuickPick of the outline: a separator per play (`play.name` — `play.hosts`), items labelled with `task.name` and described by `task.tags.join(", ")`, and a name that appears more than once described as `(appears N×)`. It returns the name, or undefined. **From task** / **Until task** are hidden when the outline has no tasks or `outline.strategy` is set; in that case a disabled-looking item with detail `task ranges unavailable: playbook sets strategy:` appears instead.

- [ ] **Step 1: Implement** the above. The tree is refreshed from the tracker's `onChange`.
- [ ] **Step 2: Run** `npm run check`. Expected: PASS.
- [ ] **Step 3: Commit** `src/tree.js src/pickers.js extension.js package.json`, with the message `Show last-run status and add task pickers`.

---

### Task 7: Dashboard model and webview message parsing

**Files:**
- Create: `src/model.js`
- Test: `test/model.test.js`

**Interfaces:**
- Consumes: `findEnvironments`, `findServices` (discovery), `latestFor`, `RunEntry` (Task 4), `PlaybookOutline` (Task 1), `buildPlaybookArgs`, `buildPlaybookEnv`, `sanitizeRunOptions`, `validateTaskRange` (Task 2).
- Produces:
  ```js
  /** @typedef {{ file: string, name: string, label: string, latest: RunEntry | null }} ModelPlaybook */
  /** @typedef {{ name: string, playbooks: ModelPlaybook[], hasEnv: boolean, hasVault: boolean, envFile: string | null }} ModelService */
  /** @typedef {{ name: string, isProduction: boolean, services: ModelService[] }} ModelEnvironment */
  /** @typedef {{ name: string, path: string, environments: ModelEnvironment[] }} ModelFolder */
  function buildDashboardModel(folders, readSettingsFor, history, isProductionFor) /* folders: {name,path}[] → { folders: ModelFolder[] } */
  /** @typedef {{ type: "ready" } | { type: "outline", folder: string, playbook: string } | { type: "preview" | "run", folder: string, environment: string, playbook: string, options: RunOptions } | { type: "open", folder: string, file: string, line: number }} WebviewMessage */
  function parseWebviewMessage(value) /* unknown → WebviewMessage | null */
  function resolveRunRequest(model, message) /* → { folder: ModelFolder, environment: ModelEnvironment, playbook: ModelPlaybook } | null */
  function resolveOpenRequest(model, message, outlineFor) /* → { file, line } | null — file must be a known playbook, env file, or a task file from that folder's outlines */
  function buildPreview(spec) /* { root, environment, playbookFile, settings, options, outline, pluginDir } → { argv: string[], env: Record<string,string>, error: string | null }
     setupTags come from settings; PLAYBOOK_RUNNER_STATUS_FILE is shown as the literal "<per-run status file>", since the real path is only made at run time */
  ```
  Playbook outlines are **not** in the model. The webview asks for one per playbook with `outline`, so opening the dashboard doesn't scan every playbook.

- [ ] **Step 1: Write the failing tests** (fixture with two environments, one matching the production pattern, two services, and a history entry):
  - `buildDashboardModel` lists both environments with `isProduction` set correctly and the services in discovery order, attaches the right history entry as `latest` (else `null`), and contains no outline field.
  - `parseWebviewMessage` accepts each type and rejects unknown types, non-string fields and a non-integer or negative `line`. `options` goes through `sanitizeRunOptions`, so `{ options: { extraArgs: ["--become-password-file", "/x"] } }` comes back without `extraArgs`: **the webview can't pass `extraArgs`**.
  - `resolveRunRequest rejects`: `playbook: "/etc/passwd"`, `playbook: "<folder>/playbooks/../../x.yml"`, an unknown environment, an unknown folder → `null`. A real one → the resolved triple.
  - `resolveOpenRequest`: a task file from an outline → ok. A file outside → `null`.
  - `buildPreview`: argv equals `buildPlaybookArgs(...)` for the same input, and env equals `buildPlaybookEnv(...)`. A range that `validateTaskRange` refuses → `error` set and argv still filled.

- [ ] **Step 2: Run** `node --test test/model.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/model.js`, with no `vscode` import. Production detection is passed in (`isProductionFor(settings)` → RegExp | null from `settings.productionPattern`), so there is no `settings.js` import.
- [ ] **Step 4: Run** `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit** `src/model.js test/model.test.js`, with the message `Build the dashboard model and validate webview messages`.

---

### Task 8: Dashboard webview

**Files:**
- Create: `src/dashboard.js`, `media/dashboard/main.js`, `media/dashboard/style.css`, `media/codicons/codicon.css`, `media/codicons/codicon.ttf`, `media/codicons/LICENSE`
- Modify: `extension.js`, `package.json` (command, `view/title` menu `navigation@0`, `activationEvents: ["onWebviewPanel:playbookRunner.dashboard"]` if the engine needs it), `eslint.config.js`, `package.json` devDependencies (`@vscode/codicons`, pinned to an exact version, only to copy the files from)

**Interfaces:**
- Consumes: `buildDashboardModel`, `parseWebviewMessage`, `resolveRunRequest`, `resolveOpenRequest`, `buildPreview` (Task 7); `findPlaybookOutline` (Task 1); `startPlaybookRun`, `RunTracker` (Task 5).
- Produces:
  - `class DashboardPanel` in `src/dashboard.js`, with `static show(context, deps)` (one instance, `reveal` if it already exists), `static revive(panel, context, deps)` for `registerWebviewPanelSerializer("playbookRunner.dashboard", …)`, `update()` (re-posts the model), and `dispose()`.
  - Extension → webview messages: `{ type: "model", model }`, `{ type: "outline", folder, playbook, outline }`, `{ type: "preview", argv, env, error }`.
  - Webview → extension: the `WebviewMessage`s from Task 7. Every incoming message goes through `parseWebviewMessage`, then `resolveRunRequest` / `resolveOpenRequest`, and is dropped when either returns null. `run` calls `startPlaybookRun` with the resolved objects and the sanitized options. `open` uses `showTextDocument` with a selection at `line - 1`.
  - `DashboardPanel.update()` is called from the Watchers refresh and from `RunTracker.onChange`.
- `eslint.config.js` gains a block for `media/**/*.js`: `sourceType: "script"`, `globals.browser`, plus `acquireVsCodeApi: "readonly"`.

- [ ] **Step 1: Copy codicons.** `npm install --save-dev --save-exact @vscode/codicons`, then copy `node_modules/@vscode/codicons/dist/codicon.css`, `codicon.ttf` and the package's `LICENSE*` into `media/codicons/`. Verify: `ls media/codicons` shows the three files.
- [ ] **Step 2: Implement `src/dashboard.js`.** The HTML shell has a CSP of `default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; font-src ${cspSource}; script-src 'nonce-${nonce}';`, uses `asWebviewUri` for the three media files, and sets `enableScripts: true`, `localResourceRoots: [media]`, `retainContextWhenHidden: false`.
- [ ] **Step 3: Implement `media/dashboard/main.js` and `style.css`** to the spec's layout (§5):
  - environment switcher;
  - production banner;
  - service list with filter and status dots;
  - playbook cards that request their outline on expand;
  - task rows with hover actions *only this / from here / until here / open*, and click-twice range selection;
  - setup-tagged tasks before *from* marked "will also run";
  - a bottom bar with check/diff/step/verbosity/limit, a command preview (requested with `preview` on every option change, debounced 150 ms) and a Run button that names the environment, styled with `--vscode-charts-red` on production and disabled while `preview.error` is set, which it shows.

  Restore the selected folder, environment, service, expanded playbooks and range with `vscode.getState`/`setState`. Rows are `<button>`s, with `role="tree"`/`treeitem`, `aria-expanded`, and up/down keys moving focus. Use only `--vscode-*` variables and `var(--vscode-font-family)` / `--vscode-editor-font-family` for the preview.
- [ ] **Step 4: Register** `playbookRunner.openDashboard` (category Playbook Runner, icon `$(dashboard)`), the serializer and the `view/title` menu entry in `activate()`.
- [ ] **Step 5: Run** `npm run check`. Expected: PASS.
- [ ] **Step 6: Commit** `src/dashboard.js media/ extension.js package.json package-lock.json eslint.config.js`, with the message `Add the Playbook Runner dashboard tab`.

---

### Task 9: Docs and final check

**Files:**
- Modify: `README.md`, `CHANGELOG.md` (under `## Unreleased`), `workflow.md` (new numbered steps after the last one: the dashboard, and the range plugin with its accepted trade-off of depending on ansible-core internals and how it is guarded), `.claude/skills/vscode-extension/SKILL.md` (add `src/tags.js`, `src/history.js`, `src/model.js` to the never-`vscode` table and the new `contextValue`s if any were added), and the root `CLAUDE.md` only if a statement there became false.

- [ ] **Step 1: Write the docs.** README: dashboard section with a sketch, the `setupTags` row in the settings table, *From/Until task* and *Step* in the run-options description, and a note that task ranges need the bundled plugin and ansible-core ≥ 2.22.
- [ ] **Step 2: Run** `npm run check`, then `npm run package`. Expected: both PASS, and `unzip -l dist/*.vsix | grep -E 'ansible/strategy/playbook_runner_range.py|media/codicons/codicon.ttf|media/dashboard/main.js'` lists all three.
- [ ] **Step 3: Commit** the doc files, with the message `Document the dashboard and task-scoped runs`.
- [ ] **Step 4: Hand back the F5 checklist** (do not claim UI behaviour works). Over **staging** only:
  1. The tree shows the welcome view after `playbookRunner.inventoriesDir` is temporarily pointed at an empty directory.
  2. **Open Dashboard** from the view title bar: environments switch, production shows the red banner, the service filter works.
  3. Expand `authentik/authentik.yml`: plays and tasks are listed with tag chips, and `podman-user-setup` tasks are marked when a later *from* is set.
  4. Set *from* / *until* by hovering. The preview shows the argv and the `PLAYBOOK_RUNNER_*` env, and an *until* before *from* disables Run with the reason.
  5. **⚙ → Check** with a from/until range on a staging playbook: the terminal shows the `Playbook Runner: running from …` banner, and the tree row, status bar and dashboard all show the result.
  6. **Re-run Last** after renaming that task in a scratch edit (reverted afterwards) refuses with the task name.
  7. Reload the window mid-run: the entry shows "unknown", and nothing spins.
  8. Light, dark and high-contrast themes all stay legible.
