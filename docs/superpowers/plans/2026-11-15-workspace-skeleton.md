# Get Started and Starter Playbooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From an empty folder to a runnable first playbook in one step (*Get started*), and an optional starter playbook in *New service…*.

**Architecture:** The plans live in `src/scaffold.js` (no `vscode` import), built from the existing `SkeletonEntry` list and carried out by the existing `createSkeleton` (`wx`, never overwrites). The editor surface adds one command, one QuickPick and one dashboard button that reuse the existing plan → modal confirmation → create → refresh flow.

**Tech Stack:** Plain CommonJS JavaScript with JSDoc types (`tsc --noEmit`, `strict`, `noUncheckedIndexedAccess`), `node:test`, VS Code extension API ^1.93.

**Spec:** `docs/superpowers/specs/2026-11-15-workspace-skeleton-design.md`

## Global Constraints

- Load the project skill `vscode-extension` before starting; its invariants apply.
- No literal environment or service name in code. Names come from the user; input boxes start empty (a `placeHolder` example is fine).
- `localhost` is written only by `planWorkspace`, only into an inventory file the plan creates.
- Files are created only through `createSkeleton` (flag `wx`); nothing existing is overwritten.
- Every path comes from settings (`playbooksDir`, `rolesDir`, `inventoriesDir`, `inventoryFile`, `groupVarsDir`, `envFileName`) via `withDefaults`.
- `npm run check` must pass apart from the range-plugin suite, which fails on this machine because ansible-core is 2.21.5 (pre-existing; not this plan's concern). Use `node --test $(ls test/*.test.js | grep -v range-plugin)` as the gate.
- Work on the existing branch `publish-prep`; do not create another branch.

## Review Focus

1. **Folder that already has an `ansible.cfg`, `roles/` or `playbooks/`, but no environment** — Get started must still work, list only what is missing, and leave the existing `ansible.cfg` untouched. (Task 2 test `keeps an existing ansible.cfg`.)
2. **Service and environment given the same name** (`web` / `web`) — paths do not collide (`playbooks/web/`, `inventories/web/`), plan is valid. (Task 2 test `same name for environment and service`.)
3. **Non-default settings** (`inventoryFile: "hosts.yml"`, custom dirs) — Get started writes the INI localhost line only into an INI inventory; with a `.yml`/`.yaml` inventory file the content is the YAML equivalent. (Task 2 test `yaml inventory gets yaml content`.)
4. **New service with a starter, run again on an existing service** — an existing `<service>.yml` is not listed as created and not overwritten. (Task 1 test `starter is not overwritten`.)
5. **Group-has-hosts detection on awkward INI** — comments, `[group:vars]`, `[group:children]`, and a group header with only blank lines. (Task 1 tests on `groupHasHosts`.)

---

### Task 1: Starter playbook and hosts check in `src/scaffold.js`

**Files:**
- Modify: `src/scaffold.js` (`planService` at ~line 145; exports)
- Test: `test/scaffold.test.js`

**Interfaces:**
- Produces:
  - `starterPlaybook(service: string): string`
  - `planService(root, name, settings?, opts?: { starter?: boolean }): SkeletonPlan` — with `starter: true` adds a file entry `<playbooksDir>/<service>/<service>.yml` whose `content` is `starterPlaybook(service)`, right after the playbook directory entry.
  - `groupHasHosts(inventoryText: string, group: string): boolean`

- [ ] **Step 1: Write the failing tests** in `test/scaffold.test.js`, new `describe("starter playbook")`:

```js
it("is a ping on the service's group", () => {
  assert.equal(
    starterPlaybook("web"),
    "- name: web\n  hosts: web\n  gather_facts: false\n  tasks:\n    - name: Check the connection\n      ansible.builtin.ping:\n      tags: [hello]\n",
  );
});
it("planService adds it only when asked", () => {
  assert.equal(planService(root, "web").entries.some((e) => e.relative.endsWith("web.yml")), false);
  const file = entry(planService(root, "web", {}, { starter: true }), "playbooks/web/web.yml");
  assert.equal(file.type, "file");
  assert.equal(file.content, starterPlaybook("web"));
  assert.equal(file.exists, false);
});
it("starter is not overwritten", () => {
  fs.mkdirSync(path.join(root, "playbooks/immich"), { recursive: true });
  const plan = planService(root, "immich", {}, { starter: true }); // playbooks/immich/immich.yml exists in FIXTURE
  assert.equal(entry(plan, "playbooks/immich/immich.yml").exists, true);
  createSkeleton(plan);
  assert.equal(fs.readFileSync(path.join(root, "playbooks/immich/immich.yml"), "utf8"), "");
});
```

and `describe("groupHasHosts")`:

```js
it("finds a host under the header", () => assert.equal(groupHasHosts("[web]\nhost1\n", "web"), true));
it("ignores comments and blank lines", () => assert.equal(groupHasHosts("[web]\n# none\n; none\n\n[db]\nh\n", "web"), false));
it("does not count :vars", () => assert.equal(groupHasHosts("[web:vars]\nx=1\n", "web"), false));
it("counts :children", () => assert.equal(groupHasHosts("[web:children]\nfront\n", "web"), true));
it("missing group", () => assert.equal(groupHasHosts("[db]\nh\n", "web"), false));
```

- [ ] **Step 2: Run** `node --test test/scaffold.test.js` — Expected: FAIL, `starterPlaybook is not a function`.

- [ ] **Step 3: Implement** the three functions and export them. `planService` gets a fourth parameter `opts = {}`; the entry `add` helper takes an optional content argument the way `planEnvironment`'s does. `groupHasHosts` is a line scan: a section is `[name]` or `[name:children]` (not `:vars`); a non-empty line not starting with `#` or `;` inside it counts.

- [ ] **Step 4: Run** `node --test test/scaffold.test.js` — Expected: PASS.

- [ ] **Step 5: Commit** `git commit -am "Offer a starter playbook in the service plan"` (with the Co-Authored-By trailer).

### Task 2: `planWorkspace` in `src/scaffold.js`

**Files:**
- Modify: `src/scaffold.js`
- Test: `test/scaffold.test.js`

**Interfaces:**
- Consumes: `starterPlaybook`, `validateServiceName` (scaffold), `validateEnvironmentName` (`src/environments.js`), `findEnvironments` (`src/discovery.js`).
- Produces: `planWorkspace(root: string, names: { environment: string, service: string }, settings?: Partial<Settings>): SkeletonPlan & { environment: string }` — `name` is the service, `environments` is `[environment]`, `unknownEnvironments: []`, `limited: false`. Throws `Error` with the validator's message for a bad name, and `"<folder> already has an environment."` (folder = `path.basename(root)`) when `findEnvironments` finds any.

Entries, in this order (paths from settings):
1. file `ansible.cfg` — content `"[defaults]\nroles_path = <rolesDir>\n"`
2. directory `<rolesDir>`
3. directory `<playbooksDir>/<service>`
4. file `<playbooksDir>/<service>/<service>.yml` — `starterPlaybook(service)`
5. directory `<inventoriesDir>/<environment>`
6. file `<inventoriesDir>/<environment>/<inventoryFile>` — INI: `` `[${service}]\nlocalhost ansible_connection=local ansible_python_interpreter="{{ ansible_playbook_python }}"\n` ``; when `inventoryFile` ends in `.yml`/`.yaml`: `` `all:\n  children:\n    ${service}:\n      hosts:\n        localhost:\n          ansible_connection: local\n          ansible_python_interpreter: "{{ ansible_playbook_python }}"\n` ``
7. directory `<inventoriesDir>/<environment>/<groupVarsDir>/<service>`
8. file `…/<service>/<envFileName>` — empty

- [ ] **Step 1: Write the failing tests**, `describe("planWorkspace")`, each with its own `makeFixture([])` (empty folder) or a small list:

```js
it("lays out a runnable workspace in an empty folder", () => {
  const plan = planWorkspace(empty, { environment: "dev", service: "web" });
  assert.deepEqual(plan.entries.map((e) => e.relative.split(path.sep).join("/")), [
    "ansible.cfg", "roles", "playbooks/web", "playbooks/web/web.yml",
    "inventories/dev", "inventories/dev/hosts.ini",
    "inventories/dev/group_vars/web", "inventories/dev/group_vars/web/env.yml",
  ]);
  createSkeleton(plan);
  assert.match(fs.readFileSync(path.join(empty, "inventories/dev/hosts.ini"), "utf8"), /^\[web\]\nlocalhost ansible_connection=local /);
  assert.equal(fs.readFileSync(path.join(empty, "ansible.cfg"), "utf8"), "[defaults]\nroles_path = roles\n");
  assert.deepEqual(findEnvironments(empty, {}).map((e) => e.name), ["dev"]);
});
it("keeps an existing ansible.cfg", () => { /* fixture [["ansible.cfg", "[defaults]\nx = 1\n"]]; entry exists === true; after createSkeleton content unchanged */ });
it("same name for environment and service", () => { /* { environment: "web", service: "web" } → no duplicate relative paths */ });
it("yaml inventory gets yaml content", () => { /* settings { inventoryFile: "hosts.yml" } → content starts "all:\n  children:\n    web:" */ });
it("uses the configured directories", () => { /* { playbooksDir: "pb", rolesDir: "r", inventoriesDir: "inv", groupVarsDir: "gv", envFileName: "vars.yml" } → "r", "pb/web", "inv/dev/gv/web/vars.yml"; ansible.cfg says roles_path = r */ });
it("refuses a folder that has an environment", () => assert.throws(() => planWorkspace(root, { environment: "dev", service: "web" }), /already has an environment/));
it("refuses bad names", () => { assert.throws(() => planWorkspace(empty, { environment: "a/b", service: "web" })); assert.throws(() => planWorkspace(empty, { environment: "dev", service: "" })); });
```

The commented tests are written out in full with the assertions named in each comment.

- [ ] **Step 2: Run** `node --test test/scaffold.test.js` — Expected: FAIL, `planWorkspace is not a function`.

- [ ] **Step 3: Implement** `planWorkspace` and export it. Validate both names before touching the filesystem.

- [ ] **Step 4: Run** `node --test test/scaffold.test.js` — Expected: PASS. Then `npm run typecheck && npm run lint` — clean.

- [ ] **Step 5: Commit** `"Plan a whole workspace from an empty folder"`.

### Task 3: `getStarted` webview message in `src/model.js`

**Files:**
- Modify: `src/model.js` (`DashboardMessage` typedef ~line 110, `parseWebviewMessage` ~line 179)
- Test: `test/model.test.js` (beside the `createService` cases ~line 186)

**Interfaces:**
- Produces: message `{ type: "getStarted", folder: string }`, parsed exactly like `createService`.

- [ ] **Step 1: Write the failing tests**: `parseWebviewMessage({ type: "getStarted", folder: "/f", extra: 1 })` deep-equals `{ type: "getStarted", folder: "/f" }`; `parseWebviewMessage({ type: "getStarted" })` and `({ type: "getStarted", folder: 3 })` are `null`.
- [ ] **Step 2: Run** `node --test test/model.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the typedef member and the `case`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `"Accept a getStarted message from the dashboard"`.

### Task 4: Editor surface — command, QuickPick, button

**Files:**
- Modify: `src/pickers.js` (new `pickServiceStart`, export), `extension.js` (`createServiceSkeleton` ~line 419, new `getStarted`, `actions` ~line 899, `register` ~line 941), `src/dashboard.js` (`DashboardDeps.actions` typedef ~line 99, `receive` ~line 320), `media/dashboard/main.js` (empty state ~line 1473), `package.json` (`contributes.commands`)

**Interfaces:**
- Consumes: `planService(…, { starter })`, `groupHasHosts`, `planWorkspace`, `createSkeleton` (Tasks 1–2); `getStarted` message (Task 3); existing `pickers.pickFolder`, `pickers.pickEnvironmentName({ title, prompt, taken })`, `pickers.pickServiceName(existing)`.
- Produces: `pickers.pickServiceStart(): Promise<{ starter: boolean } | undefined>`; command `playbookRunner.getStarted`; `DashboardDeps.actions.getStarted(node)`.

- [ ] **Step 1: `pickServiceStart`** — QuickPick, title `"New service: start with"`, items `$(folder) Empty folder` (`starter: false`) and `$(file-code) With a starter playbook` (description `"<name>.yml: a ping on the service's group"`, `starter: true`); `ignoreFocusOut: true`; `undefined` when dismissed.

- [ ] **Step 2: New service…** — in `createServiceSkeleton`, after the name ask `pickServiceStart()` (return on `undefined`), pass `{ starter }` to `planService`. When `starter` is true, for each environment in the plan read its inventory (skip YAML inventories and unreadable files) and, where `!groupHasHosts(text, plan.name)`, add one note: `` `${plan.name}.yml runs on the ${plan.name} group, which has no hosts in ${names.join(", ")} yet.` ``. After creating, when the starter was created, open it with `vscode.window.showTextDocument`.

- [ ] **Step 3: `getStarted(argument, refresh)`** in `extension.js`, beside `createEnvironmentSkeleton`: folder via `asCommandNode`/`pickFolder` → if `findEnvironments` finds any, info message `"<folder> already has environments — use New service… or New environment…"` and return → `pickEnvironmentName({ title: "Get started: first environment", prompt: \`Directory name under ${settings.inventoriesDir}/\`, taken: [] })` → `pickServiceName(scaffold.existingServiceNames(root, settings))` → `planWorkspace` (error message on throw, as the other commands) → modal `"Set up <folder> for Ansible?"`, detail = missing entries as in `createServiceSkeleton` plus `"\n\nThe inventory puts localhost in the <service> group, so ▶ on <service>.yml runs on this machine."`, button `"Create"` → `createSkeleton` → `refresh()` → open the starter playbook.

- [ ] **Step 4: Wire it** — `actions.getStarted`, `register("playbookRunner.getStarted", …)` inside the single `context.subscriptions.push(...)`; `package.json` command `{ "command": "playbookRunner.getStarted", "title": "Get Started…", "category": "Playbook Runner", "icon": "$(rocket)" }`; `DashboardDeps.actions.getStarted` typedef; `receive` handles `getStarted` exactly like `createService`.

- [ ] **Step 5: Button** — in the empty state of `media/dashboard/main.js`, a first button `class: "run"`, `icon("rocket")`, `"Get started…"`, posting `{ type: "getStarted", folder: folder.path }`; *Open Settings* becomes `class: "icon-button"` like its neighbours.

- [ ] **Step 6: Verify** — `npm run lint && npm run typecheck` clean; `node --test $(ls test/*.test.js | grep -v range-plugin)` all pass.

- [ ] **Step 7: Commit** `"Add Get started and the starter-playbook choice"`.

### Task 5: Docs

**Files:**
- Modify: `README.md` (*Repository layout*, *Adding a service*), `CHANGELOG.md` (under `## Unreleased`), `workflow.md` (new step 23 after step 22)

- [ ] **Step 1: README** — at the end of *Repository layout*: an *Starting from an empty folder* paragraph: *Get started…* on the dashboard (or *Playbook Runner: Get Started…*) asks for an environment and a service name and creates the tree above with `localhost` in the service's group, so ▶ on the starter playbook runs right away; replace `localhost` with real hosts afterwards. In *Adding a service*: the *Empty folder* / *With a starter playbook* choice, and that it never adds hosts.
- [ ] **Step 2: CHANGELOG** — one bullet for *Get started* (what it lays out, the localhost line, why), one for the starter-playbook choice.
- [ ] **Step 3: workflow.md step 23** — ✅ Get started and starter playbooks: the extension writes a host for the first time, only `localhost` and only into an inventory it creates itself; an existing inventory is still never given hosts.
- [ ] **Step 4: Commit** `"Document Get started and starter playbooks"`.

### Manual check (for the user, after Task 5)

`F5` with `.vscode/launch.json` pointed at an empty folder: the dashboard shows *Get started…* → enter `dev` / `hello` → confirmation lists 8 paths → *Create* → the dashboard shows `dev` with service `hello`, the starter opens → ▶ on `hello.yml` passes (`ping` → `pong`). Then *New service…* → `second` → *With a starter playbook* → the confirmation notes that `second` has no hosts in `dev`.
