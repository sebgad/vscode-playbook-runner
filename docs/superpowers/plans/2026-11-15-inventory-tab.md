# Inventory Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dashboard *Inventory* tab that edits each environment's INI inventory — server groups, hosts with SSH login fields, group vars, service children — preserving marked manual blocks, plus planned rename/delete of groups that carry `group_vars/<name>/` along.

**Architecture:** A new pure module `src/inventory.js` (no `vscode`) parses `hosts.ini` into a model, validates it, serializes it in the homelab-infra layout and plans group rename/delete; `src/model.js` exposes it to the page and rebuilds the new messages; `extension.js`/`src/dashboard.js` confirm and write; `media/dashboard/main.js` renders the tab and holds a draft per environment.

**Tech Stack:** Plain CommonJS JavaScript, JSDoc types under `tsc --strict` + `noUncheckedIndexedAccess`, `node:test`, VS Code webview. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-15-inventory-tab-design.md`

## Global Constraints

- `src/inventory.js` never `require("vscode")`; every decision about file content, names or paths lives there with a test.
- No environment, group or service name as a literal in non-test code. `hosts.ini`, `inventories`, `group_vars` come from settings (`inventoryFile`, `inventoriesDir`, `groupVarsDir`).
- Only INI inventories: if `path.extname(settings.inventoryFile)` is in `STRUCTURED_INVENTORY` (`src/environments.js`), the tab shows `editable: false` with reason "Editing is only supported for INI inventories."
- Marker lines, exact after trim: `# playbook-runner: manual begin` and `# playbook-runner: manual end`.
- Refused variable names (host and group): `ansible_password`, `ansible_ssh_pass`, `ansible_become_pass`, `ansible_become_password`.
- Host SSH fields in this order: `ansible_host`, `ansible_user`, `ansible_port`, `ansible_ssh_private_key_file`, `ansible_ssh_common_args`.
- Webview messages are untrusted: rebuilt field by field; folder/environment/group names matched by exact string against the model; manual blocks and read-only groups always taken from disk, never from a message; a new group name is asked for by the extension.
- Production environments: every write goes through `pickers.confirmProduction(settings, environment, description)` in addition to the modal.
- Group delete moves `group_vars/<name>/` only via `vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true })`, no permanent fallback, only when the user opts in.
- Rename/delete/save refused while `tracker.isRunning(root, environment.name)`.
- `npm run check` passes at the end of every task.

## Review Focus

1. **The real homelab-infra production file** (comments, duplicate `[immich:children]`, `ansible_ssh_common_args='-o StrictHostKeyChecking=accept-new'`, double-spaced `host  ansible_user=`) must parse, serialize, and re-parse to the same model with every host var intact — Task 1 `round-trips the homelab production layout`.
2. **Values containing `=` or spaces** (`-o Foo=bar -o Baz=qux`) split on the first `=` only and come back quoted — Task 1 `keeps = and spaces inside quoted values`.
3. **Host patterns and ports** (`web[01:10].example`, `db.example:2222`) are valid host names, not rejected by validation — Task 2 `accepts host ranges and ports`.
4. **Inline comments and `;` comments** (`[g] # note`, `host a=b ; x`) are not read as vars and are counted in `warnings` — Task 1 `drops and counts inline comments`.
5. **Hosts before the first header and `[all:vars]`** survive a round trip: ungrouped hosts land in a server group `ungrouped`, `[all:vars]` stays `[all:vars]` with no `[all]` header emitted — Task 1 `keeps ungrouped hosts and all:vars`.

---

## File Structure

- Create `src/inventory.js` — parse, serialize, validate, diff summary, hash, rename/delete plans, playbook `hosts:` scan.
- Create `test/inventory.test.js` — its spec.
- Modify `src/discovery.js` — `findInventoryCandidates`.
- Modify `src/model.js` — `inventory` on `ModelEnvironment`, `candidates` on `ModelFolder`, five new messages, resolvers.
- Modify `test/model.test.js`, `test/discovery.test.js`.
- Modify `src/dashboard.js`, `extension.js` — actions, confirmation, diff provider, writes.
- Modify `media/dashboard/main.js`, `media/dashboard/style.css` — the tab.
- Modify `README.md`, `CHANGELOG.md`, `workflow.md` (step 25), `CLAUDE.md` and `.claude/skills/vscode-extension/SKILL.md` (add `inventory.js` to the pure-module list).

---

### Task 1: Parse and serialize the INI inventory

**Files:**
- Create: `src/inventory.js`
- Test: `test/inventory.test.js`

**Interfaces:**
- Produces:
  ```js
  /** @typedef {[string, string]} Var */
  /** @typedef {{ name: string, vars: Var[] }} Host */
  /** @typedef {{ name: string, hosts: Host[], vars: Var[], readOnly: boolean }} ServerGroup */
  /** @typedef {{ name: string, children: string[], hosts: Host[], vars: Var[], readOnly: boolean }} Service */
  /** @typedef {{ text: string, line: number, anchors: string[] }} ManualBlock
   *   text: verbatim incl. markers, no trailing EOL; line: 1-based line of the begin marker;
   *   anchors: managed section headers (e.g. "podman_servers:vars") preceding it, nearest first */
  /** @typedef {{ serverGroups: ServerGroup[], services: Service[], manual: ManualBlock[],
   *   manualGroups: string[], warnings: string[], error: string | null, eol: "\n" | "\r\n" }} Inventory */
  function parseInventory(text: string): Inventory
  function serializeInventory(inventory: Inventory): string
  const MANUAL_BEGIN = "# playbook-runner: manual begin", MANUAL_END = "# playbook-runner: manual end"
  ```

Rules the parser implements (from the spec):
- A group with any `:children` section is a `Service` (its direct hosts go to `Service.hosts`); every other group is a `ServerGroup`. Hosts before the first header go to a server group `ungrouped`.
- Duplicate sections merge; children and hosts de-duplicated in first-seen order; a duplicate host's vars merge, later key wins.
- Host line: name, then `key=value` tokens; value may be `'…'` or `"…"`; split on first `=`. Tokens after an unquoted `#` or `;` are a comment.
- Comment lines and inline comments outside manual blocks are dropped; `warnings` gets `"N comment line(s) outside manual blocks will be removed"` and `"M duplicate section(s) will be merged"` when N/M > 0.
- `manualGroups`: names of groups with any section inside a manual block. Their sections outside blocks are parsed into the lists with `readOnly: true`.
- `begin` without `end`, `end` without `begin`, or nested `begin` → `error` set (e.g. `"Manual block opened on line 12 is never closed."`), lists still filled.
- `eol` is `"\r\n"` if the text contains `\r\n`, else `"\n"`.

Serializer layout: server groups in order (`[g]` + host lines; `[g]` emitted when the group has hosts or has no vars; never for `all`), then every `[g:vars]` with vars, then each service (`[s]` + hosts if any, `[s:children]` + members, `[s:vars]` if any). Sections separated by one blank line, single trailing EOL. Host line `name k=v k=v` (single space). Quote a value containing whitespace, `'`, `"`, `#` or `;`: single quotes unless it contains `'`, then double. Each manual block is emitted right after the first of its `anchors` that is emitted, else at the top; blocks with the same position keep file order.

- [ ] **Step 1: Write the failing tests** in `test/inventory.test.js` (`describe("parseInventory / serializeInventory")`):
  - `round-trips the homelab production layout` — fixture string copied from the production `hosts.ini` structure (with fake hostnames): `parse(serialize(parse(t)))` deep-equals `parse(t)` minus `warnings`; `services.find(s => s.name === "immich").children` equals `["nfs_servers", "podman_servers"]`; the podman host's `ansible_ssh_common_args` var equals `"-o StrictHostKeyChecking=accept-new"`.
  - `serializes in the homelab layout` — input `[b:children]\na\n[a]\nh1 ansible_host=x\n[a:vars]\nk=v\n` serializes to exactly `"[a]\nh1 ansible_host=x\n\n[a:vars]\nk=v\n\n[b:children]\na\n"`.
  - `keeps = and spaces inside quoted values` — `h k='-o A=b -o C=d'` → var `["k", "-o A=b -o C=d"]`, serialized back as `k='-o A=b -o C=d'`.
  - `drops and counts inline comments` — `[g] # x\nh a=b ; c\n# lone\n` → host vars `[["a","b"]]`, `warnings` includes exactly `"3 comment line(s) outside manual blocks will be removed"` (every line carrying a comment counts once).
  - `keeps ungrouped hosts and all:vars` — `h1\n[all:vars]\nx=1\n` → server groups `ungrouped` (host `h1`) and `all` (vars `x=1`); serialization contains `[all:vars]` and not `[all]\n`.
  - `writes manual blocks back verbatim after their anchor` — block after `[a:vars]` stays after `[a:vars]` byte-for-byte; when `a` is removed from the model before serialize, the block moves after the nearest earlier surviving anchor, or the top.
  - `marks groups touched by a manual block read-only` — `[p]` inside a block, `[p:vars]` outside → `manualGroups` `["p"]`, server group `p` present with `readOnly: true` and its vars.
  - `reports an unclosed manual block` — `error` matches `/never closed/`.
  - `keeps CRLF` — CRLF input serializes with `\r\n` only.
- [ ] **Step 2: Run** `node --test test/inventory.test.js` — Expected: FAIL, `Cannot find module '../src/inventory'`.
- [ ] **Step 3: Implement** `parseInventory`, `serializeInventory`, the marker constants in `src/inventory.js`; export them.
- [ ] **Step 4: Run** `node --test test/inventory.test.js` — Expected: PASS. Then `npm run check` — Expected: exit 0.
- [ ] **Step 5: Commit** `git add src/inventory.js test/inventory.test.js && git commit -m "Parse and serialize INI inventories with manual blocks"`

### Task 2: Validate, summarise changes, hash, merge with disk

**Files:**
- Modify: `src/inventory.js`
- Test: `test/inventory.test.js`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  ```js
  const PASSWORD_VARS: ReadonlySet<string>
  const SSH_FIELDS: readonly string[]   // the five, in the Global Constraints order
  function validateInventory(inventory: Inventory): string[]           // [] = savable
  function inventoryHash(text: string): string                         // sha256 hex, node:crypto
  function mergeEdits(disk: Inventory, edited: { serverGroups: ServerGroup[], services: Service[] }): Inventory
  function describeChanges(before: Inventory, after: Inventory): string[]
  function newInventoryText(): string
  ```

- `validateInventory` errors (one string each): `inventory.error` if set; group name not `/^[A-Za-z_][A-Za-z0-9_]*$/` ("Ansible group names allow letters, digits and _"); host name not `/^[A-Za-z0-9_.\-\[\]:]+$/`; var key not `/^[A-Za-z_][A-Za-z0-9_]*$/`; any `\n`/`\r` in a value; a group name used twice across serverGroups, services and `manualGroups` (a read-only list entry for a manual group does not count against itself); a child that names no group in the inventory; a service cycle; a password var (message names the group and suggests its vault); a host with non-empty vars in more than one group.
- `mergeEdits`: result = `disk` with its non-read-only server groups and services replaced by `edited`'s, entries in `edited` marked `readOnly` or named in `disk.manualGroups` ignored, `disk`'s read-only entries kept at their original positions; `manual`, `manualGroups`, `eol`, `error` from `disk`; `warnings` from `disk`.
- `describeChanges` lines, in this form: `"+ server group lab"`, `"− server group lab"`, `"podman_servers: + host h2"`, `"podman_servers: − host h2"`, `"podman_servers: h1 changed (ansible_user)"`, `"immich: + dns_servers"`, `"immich: − dns_servers"`, `"podman_servers:vars changed"`, `"+ service x"`, `"− service x"`.
- `newInventoryText()` returns exactly:
  ```
  # Edited by Playbook Runner. Text between these two marker lines is kept as written:
  # playbook-runner: manual begin
  # playbook-runner: manual end
  ```

- [ ] **Step 1: Write the failing tests** (`describe("validateInventory")`, `describe("mergeEdits")`, `describe("describeChanges")`):
  - `accepts host ranges and ports` — hosts `web[01:10].example` and `db.example:2222` → `[]`.
  - `refuses password variables` — `ansible_password` on a host → one error containing `vault`.
  - `refuses a child that does not exist`, `refuses a service cycle` (a→b→a), `refuses a group name used twice`, `refuses a newline in a value`, `refuses a dash in a group name`.
  - `keeps read-only groups from disk whatever the edit says` — edited copy changes a read-only group's vars → merged result has disk's vars.
  - `describes host and child changes` — adding `h2` to `podman_servers` and `dns_servers` to `immich` yields exactly `["podman_servers: + host h2", "immich: + dns_servers"]`.
  - `hash differs for different text and matches for equal text`.
  - `new inventory text parses to an empty inventory with one manual block`.
- [ ] **Step 2: Run** `node --test test/inventory.test.js` — Expected: FAIL on the new tests (`not a function`).
- [ ] **Step 3: Implement** the six exports in `src/inventory.js`.
- [ ] **Step 4: Run** `node --test test/inventory.test.js` then `npm run check` — Expected: PASS / exit 0.
- [ ] **Step 5: Commit** `git commit -am "Validate inventory edits and describe what a save changes"` (add the test file if needed).

### Task 3: Plan group rename and delete; find inventory candidates

**Files:**
- Modify: `src/inventory.js`, `src/discovery.js`
- Test: `test/inventory.test.js`, `test/discovery.test.js`

**Interfaces:**
- Consumes: Tasks 1–2; `findEnvironments`, `findPlaybookGroups` from `src/discovery.js`; `makeFixture`/`removeFixture` from `test/helpers.js`.
- Produces:
  ```js
  /** @typedef {{ name: string, dir: string }} InventoryCandidate */
  function findInventoryCandidates(root: string, settings?: Partial<Settings>): InventoryCandidate[]   // discovery.js
  function playbooksNamingGroup(root: string, settings: Settings, group: string): string[]          // relative paths
  /** @typedef {{ environment: string, from: string, to: string, text: string,
   *   groupVarsFrom: string | null, groupVarsTo: string, services: string[],
   *   playbooks: string[], otherEnvironments: string[] }} GroupRenamePlan */
  function planGroupRename(root: string, settings: Settings, environment: Environment, diskText: string, from: string, to: string): GroupRenamePlan  // throws Error with a user-facing message
  /** @typedef {{ environment: string, name: string, text: string, groupVars: string | null,
   *   services: string[], emptied: string[], playbooks: string[] }} GroupDeletePlan */
  function planGroupDelete(root: string, settings: Settings, environment: Environment, diskText: string, name: string): GroupDeletePlan
  function applyGroupRename(plan: GroupRenamePlan, inventoryPath: string): void   // writeFileSync text, then renameSync group_vars if groupVarsFrom
  ```

- `playbooksNamingGroup`: every playbook from `findPlaybookGroups`; a line matching `/^\s*(?:-\s+)?hosts:\s*(.+?)\s*$/` whose value, stripped of quotes and split on `/[:,]/`, with each part trimmed of leading `&!`, contains `group`. Returns paths relative to `root`, sorted.
- `planGroupRename` throws when: `from` not a group in the parsed text, `from` in `manualGroups`, `to` fails the group-name rule or already names a group (incl. manual), `groupVarsDir/to` exists, `parseInventory(diskText).error` set. `text` = serialized inventory with the group renamed and every `children` entry renamed. `otherEnvironments` = other environments whose inventory has a group `from`.
- `planGroupDelete` throws on: unknown group, manual group, parse error. `services` = services that listed it; `emptied` = those left with no children and no hosts. `groupVars` = the dir if it exists, else null.

- [ ] **Step 1: Write the failing tests:**
  - discovery: `lists inventory directories without an inventory file` — fixture `inventories/a/hosts.ini`, `inventories/b/` → `[{ name: "b", dir: <root>/inventories/b }]`.
  - `finds playbooks whose hosts line names the group` — `hosts: immich`, `- hosts: "a:immich"`, `hosts: '!immich'` all found; `hosts: immich_x` not.
  - `rename plan renames children and group_vars` — fixture with `group_vars/podman_servers/env.yml`; plan from `podman_servers` to `podman` → `text` has `[podman]` and `immich` children `podman`, `groupVarsFrom` ends with `group_vars/podman_servers`; `applyGroupRename` leaves `group_vars/podman/env.yml` on disk.
  - `rename refuses a taken name, a manual group and an existing group_vars target` — three `assert.throws`.
  - `delete plan removes the group from every service and lists emptied ones`.
- [ ] **Step 2: Run** `node --test test/inventory.test.js test/discovery.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the functions above.
- [ ] **Step 4: Run** the same, then `npm run check` — Expected: PASS / exit 0.
- [ ] **Step 5: Commit** `"Plan group rename and delete, find environments without an inventory"`.

### Task 4: The inventory in the dashboard model and its messages

**Files:**
- Modify: `src/model.js`
- Test: `test/model.test.js`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces on the model:
  ```js
  /** @typedef {{ editable: boolean, reason: string | null, hash: string,
   *   serverGroups: ServerGroup[], services: Service[], manualGroups: string[],
   *   manual: { line: number, preview: string }[], warnings: string[],
   *   unlisted: string[] }} ModelInventory
   *   preview: first non-marker line of the block; unlisted: discovered service (playbook folder) names
   *   that are no group in the inventory */
  // ModelEnvironment gains   inventory: ModelInventory
  // ModelFolder gains        candidates: { name: string, dir: string }[]
  ```
  New `WebviewMessage` members:
  ```js
  | { type: "saveInventory", folder: string, environment: string, hash: string,
      serverGroups: ServerGroup[], services: Service[] }
  | { type: "createInventory", folder: string, candidate: string }
  | { type: "openInventory", folder: string, environment: string, line: number }
  | { type: "renameGroup" | "deleteGroup", folder: string, environment: string, hash: string, group: string }
  ```
  ```js
  function resolveCandidateRequest(model, folderPath, candidate): { folder: ModelFolder, candidate: { name, dir } } | null
  ```
  Use the existing `resolveEnvironmentRequest` for the others.

- `buildDashboardModel` reads the inventory text with `fs.readFileSync` (a read error → `editable: false`, `reason` = the error message); `editable` is false for structured inventories (Global Constraints) or when `parseInventory(...).error` is set (reason = that error).
- `parseWebviewMessage` for `saveInventory`: arrays capped at 500 groups, 500 hosts per group, 200 vars per host/group, strings ≤ 4096 chars; each group rebuilt as `{ name, hosts, vars, readOnly: false }` (services also `children`); every var a 2-tuple of strings; anything else → `null`. `openInventory.line` integer ≥ 1.

- [ ] **Step 1: Write the failing tests:**
  - `model carries the parsed inventory and its hash` (fixture env with a small `hosts.ini`).
  - `model marks a structured inventory not editable` (`inventoryFile: "hosts.yml"`).
  - `model lists playbook services missing from the inventory`.
  - `parses a saveInventory message field by field` — extra fields dropped, `readOnly: true` in the message becomes `false`.
  - `refuses a saveInventory with a non-string var, a 3-tuple var or 501 groups` → `null`.
  - `parses createInventory, openInventory, renameGroup, deleteGroup`; `refuses openInventory with line 0`.
  - `resolves a candidate by exact name and refuses ../b`.
- [ ] **Step 2: Run** `node --test test/model.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** in `src/model.js`.
- [ ] **Step 4: Run** `node --test test/model.test.js`, `npm run check` — Expected: PASS / exit 0.
- [ ] **Step 5: Commit** `"Expose the inventory to the dashboard and parse its messages"`.

### Task 5: Extension side — save, create, open, rename, delete

**Files:**
- Modify: `src/dashboard.js` (`DashboardActions`, `receive`), `extension.js` (commands, diff provider, `actions` object near line 1058)

**Interfaces:**
- Consumes: Tasks 1–4; `pickers.confirmProduction`, `pickers.confirmByName`, `resolveContext`, `asCommandNode`, `readSettings`, the `refresh` callback.
- Produces in `DashboardActions`:
  ```js
  saveInventory(node, edited: { hash: string, serverGroups, services }): Promise<void>
  createInventory(node: { folder: vscode.WorkspaceFolder, candidate: { name: string, dir: string } }): Promise<void>
  openInventory(node, line: number): Promise<void>
  renameGroup(node, hash: string, group: string): Promise<void>
  deleteGroup(node, hash: string, group: string): Promise<void>
  ```
  `node` = `this.discovered(folder, environment)` as for `renameEnvironment`. No palette commands (dashboard-only actions).

Save, in order (spec "Saving"): refuse if running; re-read; hash mismatch → warning `"Playbook Runner: <inventoryFile> changed on disk; the dashboard has reloaded it."` and `refresh()`; `mergeEdits` → `validateInventory` (errors → `showErrorMessage` with them joined); `serializeInventory`; equal to disk → return; modal `showInformationMessage("Save <inventoryFile> for <env>?", { modal: true, detail: describeChanges(...) + warnings }, "Save", "Show diff")` — *Show diff* opens `vscode.diff(fileUri, previewUri, "<env>: <inventoryFile> ↔ after save")` and re-asks; production → `confirmProduction` with the change lines; `fs.writeFileSync`; `refresh()`. After any failure the webview gets `{ type: "inventoryResult", folder, environment, error: string | null }`; on success `error: null` so the page drops the draft.

Diff preview: one `TextDocumentContentProvider` registered in `activate()` for scheme `playbook-runner-inventory`, serving text from a `Map<string, string>` keyed by the URI path; entries removed when the dialog closes.

Rename: refuse if running or hash mismatch; `pickers.pickEnvironmentName`-style input box for the new name (reuse it if its validation fits, else a `showInputBox` validating with the Task 2 group-name rule); `planGroupRename`; modal listing services updated, `group_vars` move, playbooks and other environments that still use the old name ("not changed"); production → `confirmProduction`; `applyGroupRename`; `refresh()`.

Delete: refuse if running or hash mismatch; `planGroupDelete`; modal `showWarningMessage` with buttons `"Delete"` and, when `groupVars`, `"Delete and trash group_vars"`; production → `confirmProduction`; write `text`; then for the second button `vscode.workspace.fs.delete(Uri.file(groupVars), { recursive: true, useTrash: true })` — on failure say the inventory was changed but `group_vars/<name>/` was not moved; `refresh()`.

Create: `fs.writeFileSync(path.join(candidate.dir, settings.inventoryFile), newInventoryText(), { flag: "wx" })`, `refresh()`.

Open: `vscode.window.showTextDocument(Uri.file(environment.inventory), { selection: new Range(line-1, 0, line-1, 0) })`.

- [ ] **Step 1:** Implement the five actions in `extension.js`, wire them into the `actions` object, handle the five message types in `DashboardPanel.receive` building `node` from `discovered()` (candidate from `resolveCandidateRequest`), post `inventoryResult`.
- [ ] **Step 2: Run** `npm run check` — Expected: exit 0.
- [ ] **Step 3: Commit** `"Save, create, rename and delete inventory groups from the dashboard"`.

### Task 6: The Inventory tab

**Files:**
- Modify: `media/dashboard/main.js`, `media/dashboard/style.css`

**Interfaces:**
- Consumes: `ModelInventory`, `ModelFolder.candidates`, the Task 4 messages, `inventoryResult`.

- `state.tab` type becomes `"runs" | "settings" | "inventory"`; restore from saved state accepts `"inventory"`; a third `tabButton("inventory", "server-environment", "Inventory")`. The topbar/environment switcher follow the Runs tab's pattern.
- Draft per `folder + "\n" + environment`: `{ hash, serverGroups, services }` deep-copied from the model on first edit; kept in `state` (persisted with `vscode.setState`). If the model's `hash` ≠ draft `hash`: banner "hosts.ini changed on disk", inputs disabled, Save disabled, Discard enabled. Unsaved marker `●` on the tab and the environment chip.
- Sections per the spec sketch: *Services (access control)* (one checkbox per server group and per other service, read-only groups and `manualGroups` included as choices; `unlisted` names with an *Add* button creating an empty service in the draft); *Server groups* (collapsible, host rows, *+ Host*, vars editor, *Vault* button only when the matching `ModelService` has `vaultFile`, ⋯ menu with *Rename…*/*Delete…* sending `renameGroup`/`deleteGroup`, disabled while a draft exists with the hint "Save or discard first"); *Manual sections* (preview + *Open in editor* → `openInventory`); read-only groups greyed with the hint "part of a manual group — move it into the block to keep comments".
- Host form: name, the five `SSH_FIELDS` (label = field, placeholder from the first host in the group if any), *Other variables* key/value rows; the page warns inline on a password var name and on an empty host name, and disables Save while any warning shows.
- `editable: false` → show `reason`, nothing editable. `warnings` shown above Save.
- Candidates: under the environment switcher, "`<name>` has no inventory file" + *Create inventory* → `createInventory`.
- Only `--vscode-*` colours in `style.css`.

- [ ] **Step 1:** Implement the tab.
- [ ] **Step 2: Run** `npm run check` — Expected: exit 0 (eslint covers `media/**` as browser code).
- [ ] **Step 3: Commit** `"Add the Inventory tab to the dashboard"`.

### Task 7: Docs and design record

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `workflow.md`, `CLAUDE.md`, `.claude/skills/vscode-extension/SKILL.md`

- [ ] **Step 1:** `README.md`: dashboard sketch gains the Inventory tab; a section "Editing the inventory" covering services/children, SSH fields, manual block markers (exact lines), the first-save warning about comments and duplicate sections, no passwords (use the vault), rename/delete reach.
- [ ] **Step 2:** `CHANGELOG.md`: an *Unreleased* entry "Inventory tab: edit hosts, SSH login, group vars and service children per environment; manual blocks are kept verbatim; group rename/delete carry group_vars along."
- [ ] **Step 3:** `workflow.md` step 25 (✅) per the spec's "Workflow record": drops the step 21/23 "never hosts into an existing inventory" rule, keeps "no copied hosts for a new environment", records the accepted cost (comments outside manual blocks are dropped on first save, with warning and diff).
- [ ] **Step 4:** Add `src/inventory.js` to the vscode-free module list in `CLAUDE.md` and to the table in the skill.
- [ ] **Step 5: Run** `npm run check` — Expected: exit 0. **Commit** `"Document the Inventory tab"`.

### Task 8: Manual checklist for the user

- [ ] Hand the user this checklist (F5 opens `../homelab-infra`; **staging only**, never production, no vault decryption):
  1. Inventory tab shows staging's server groups, hosts and services; `immich` lists `nfs_servers` and `podman_servers` ticked.
  2. Add a host to a scratch server group, *Save* → dialog lists `+ host`, warns about dropped comments; *Show diff* shows the canonical layout; file written as shown.
  3. Wrap a section in manual markers, edit something else, save → the block is byte-identical.
  4. Edit `hosts.ini` in the text editor while a draft is open → banner, Save disabled, Discard reloads.
  5. Rename a scratch group with a `group_vars/` dir → dir renamed, services updated, playbooks naming it listed.
  6. Delete it with *Delete and trash group_vars* → group gone, dir in the trash.
  7. Type `ansible_password` as a variable → Save disabled with the vault hint.
  8. Create an empty `inventories/scratch/` → *Create inventory* appears and creates the file; remove it afterwards.
