# Inventory tab — design

## Why

Each environment's `hosts.ini` is maintained by hand today: adding a host,
pointing a service at server groups, or changing a host's SSH login means
editing INI text per environment and keeping staging and production in step by
eye. The dashboard already discovers environments, services and vaults; the
inventory is the one part of the layout it can only show, not change. The goal
is to edit it from the dashboard, per environment, in the layout homelab-infra
already uses.

## Goals

* A third dashboard tab, **Inventory**, next to *Runs* and *Settings*, with an
  environment switcher like the Runs tab.
* **Server groups** (`[nfs_servers]`, `[podman_servers]`, …): create, rename,
  delete (rename/delete also carry `group_vars/<name>/` along — see below);
  add, edit and remove their **hosts**.
* **Hosts** carry their SSH login as form fields: `ansible_host`,
  `ansible_user`, `ansible_port`, `ansible_ssh_private_key_file`,
  `ansible_ssh_common_args`. Any other host variable is kept and editable as a
  key/value row.
* **Group variables** (`[group:vars]`) editable as key/value rows, with the
  same SSH fields offered as suggestions (`ansible_python_interpreter`,
  `ansible_ssh_pass_auth` are the ones the repo uses).
* **Services — access control**: a service is a `[service:children]` group;
  the user picks which server groups it contains (checkboxes). Create and
  delete services.
* **Create** an inventory file for an environment directory that has none, and
  **edit** an existing one in place.
* **Manual blocks**: text between marker comments is never touched by the
  extension and is written back verbatim.

## Non-goals and anti-goals

* No passwords in `hosts.ini`. The file is committed in plaintext. The GUI
  refuses `ansible_password`, `ansible_ssh_pass`, `ansible_become_pass`,
  `ansible_become_password` as host or group variables and offers the
  existing vault action for the group instead (`group_vars/<group>/vault.yml`).
* No YAML/JSON/TOML inventories. If `playbookRunner.inventoryFile` has one of
  the extensions in `STRUCTURED_INVENTORY`, the tab says editing is only
  supported for INI and shows nothing editable.
* No service gets its own inventory file; there is one file per environment.
* No syncing between environments (no "copy host to production"). Hosts are
  per environment by design (workflow.md step 21).
* No hardcoded environment, group or service names. A literal one in new code
  is a bug.
* **Anti-goal:** a save that silently changes something the user did not
  touch. Every save that would drop or reorder content outside manual blocks
  says so before writing.
* **Anti-goal:** a save that overwrites a change made in the text editor
  since the page loaded.

## Constraints

* Pure logic in a new `src/inventory.js` that never `require`s `vscode`, with
  `test/inventory.test.js`. Webview messages rebuilt field by field in
  `src/model.js`; names matched against the model by exact string.
* Plain CommonJS + JSDoc, `strict`, `noUncheckedIndexedAccess`.
* Existing invariants: production confirmation via `pickers.confirmProduction`,
  watchers already cover `inventoriesDir`, `--vscode-*` colours only.

## Approaches

* **A — Inventory tab in the dashboard, backed by a pure parser/writer
  (chosen by the user).** Fits how Settings and environment
  create/rename/delete already work; the risky part, rewriting the file, is
  unit-tested.
* B — a `CustomTextEditorProvider` for `hosts.ini`: free undo and dirty-state,
  but lives outside the dashboard and is mostly hand-verified editor code.
* C — palette QuickPick flows only: cheapest, but five SSH fields per host
  through pickers is unusable. Ruled out.

## Design

### Workflow record

A new step 25 in `workflow.md` drops the rule of steps 21 and 23 ("an existing
inventory is never given hosts"): the extension now writes hosts the user typed
into an existing inventory. Steps 21's rule that a *new environment modelled on
another* gets no copied hosts still holds.

### The file model (`src/inventory.js`)

```js
/** @typedef {{ name: string, vars: [string, string][] }} Host  // vars in file order */
/** @typedef {{ name: string, hosts: Host[], vars: [string, string][] }} ServerGroup */
/** @typedef {{ name: string, children: string[], vars: [string, string][] }} Service */
/** @typedef {{ text: string, after: string | null }} ManualBlock  // anchor: section header before it, null = top */
/** @typedef {{ serverGroups: ServerGroup[], services: Service[], manual: ManualBlock[],
 *              manualGroups: string[], warnings: string[] }} Inventory */
```

* `parseInventory(text) → Inventory`
  * Sections: `[g]` (hosts), `[g:vars]`, `[g:children]`. A group that has a
    `:children` section is a **service**; every other group is a **server
    group**. A group with both hosts and children (rare) is a service whose
    direct hosts are kept in `ServerGroup` form under the same name and shown
    in both lists — the builder may instead push it into a warning; either way
    nothing is lost.
  * Duplicate sections (production has `[immich:children]` twice) are merged;
    children de-duplicated in first-seen order.
  * Host lines: `name key=value key='quoted value' key="…"`. A value may be
    single- or double-quoted; `ansible_ssh_common_args='-o …'` must survive.
  * Comments outside manual blocks are not part of the model; `warnings`
    reports how many comment lines and merged duplicate sections a rewrite
    would drop.
  * Groups (and the hosts in them) defined inside manual blocks go into
    `manualGroups`: shown read-only, selectable as service children, not
    editable.
* `serializeInventory(inventory) → string` — the homelab-infra layout:
  1. every server group: `[g]` then its host lines;
  2. every `[g:vars]` that has vars;
  3. every service: `[s:children]` then its members, then `[s:vars]` if any;
  4. sections separated by one blank line, file ends with one newline.
  Order within each list is the model's order (file order for existing groups,
  appended for new ones). Values containing whitespace, `'` or `"` are quoted
  (single quotes unless the value contains one). Manual blocks are written
  after the section named by `after` (or at the top), in original order; if
  that section no longer exists, after the nearest earlier surviving anchor.
* `validateInventory(inventory, manualGroups) → string[]` — errors, empty if
  savable: group/host/variable names match an INI-safe pattern (letters,
  digits, `_`, `-`, `.`; groups no `-` per Ansible's group-name warning),
  no newlines in any value, no group name used twice (incl. manual groups),
  service children name existing groups, no password variables, no service
  that contains itself (directly or via a cycle), a host name may appear in
  several server groups but its vars only in one of them.
* `inventoryHash(text)` — content hash used for the stale-write check.
* `INVENTORY_SKELETON` / `newInventory()` — the empty text written by *Create
  inventory* (no hosts, just the marker comment explaining manual blocks).

### Manual blocks

```ini
# playbook-runner: manual begin
# Root over the FIDO key: every run asks for a touch on the key.
[proxmox_servers]
pve ansible_host=192.168.178.58 ansible_user=root …
# playbook-runner: manual end
```

* Exact marker lines (leading/trailing whitespace ignored). Several blocks
  allowed. A `begin` without `end`, or nested markers, make the file
  read-only in the tab with the error shown — the extension does not guess.
* Everything in the block, markers included, is written back byte-for-byte.
* The tab shows a block as a collapsed, read-only "Manual section" with an
  *Open in editor* link (opens `hosts.ini` at that line).
* A group is **manual** if *any* of its sections (`[g]`, `[g:vars]`,
  `[g:children]`) is inside a manual block. Its sections outside the block
  are then also read-only: they are kept from the disk text as parsed and
  re-serialized unchanged, and the tab shows a hint "part of a manual group —
  move it into the block to keep comments". So a file like production's, where
  only `[proxmox_servers]` is wrapped and `[proxmox_servers:vars]` is not,
  stays savable. (Claude's call.)

### Discovery

`discovery.findEnvironments` stays as is (an environment is a directory *with*
an inventory file). A new `findInventoryCandidates(root, settings)` returns
directories under `inventoriesDir` that lack the inventory file; the tab lists
them with a **Create inventory** button. Creating one turns it into an
environment, and the existing watchers refresh the dashboard. New environments
continue to come from the existing *New environment…* action.

### Dashboard model and messages

* `model.buildDashboardModel` adds, per environment, `inventory`:
  `{ editable: boolean, reason?: string, hash, serverGroups, services,
  manualGroups, manual: { line, preview }[], warnings, playbookServices }`.
  `playbookServices` = discovered service (playbook folder) names that have no
  inventory group yet, shown as "not in inventory — add" hints.
* The page edits a **draft** per environment and sends the whole inventory on
  **Save**; a *Discard* button resets the draft. Unsaved-change marker on the
  environment switcher and the tab. One write per save, one confirmation.
* **The file changes on disk while a draft is open** (the model's `hash`
  differs from the draft's): the draft is kept but frozen — a banner says
  "hosts.ini changed on disk", Save is disabled, the edited values stay
  visible to copy, and *Discard* loads the new file. A draft is never moved
  onto a new hash. Without a draft the page simply shows the new file.
  (Claude's call.)
* New message `saveInventory { environment, hash, inventory }` — rebuilt field
  by field in `parseWebviewMessage` (arrays of plain objects with string
  fields only, length caps), environment resolved by exact name, then
  `validateInventory`. Manual blocks and manual groups are taken from the file
  on disk, never from the message.
* New message `createInventory { candidate }` — resolved against
  `findInventoryCandidates`, writes the skeleton with `wx`.
* `openInventory { environment, line? }` — opens the file in the text editor.
* `vault { environment, group }` reuses the existing vault action for the
  password hint.

### Saving (`src/dashboard.js` → `extension.js`)

1. Re-read the file; if `inventoryHash` differs from the message's `hash`,
   refuse with "hosts.ini changed on disk — reloaded" and push a fresh model.
2. Parse disk text for manual blocks/groups, merge with the message's
   managed part, validate, serialize.
3. If the new text equals the old, do nothing.
4. Confirmation (modal): what changes, in counts ("2 hosts added, 1 removed,
   immich: +dns_servers"), plus — when `warnings` is non-empty — "N comment
   lines outside manual blocks will be removed, M duplicate sections merged",
   with a **Show diff** button (`vscode.diff` against an untitled/virtual
   document holding the new text). For a production environment this is the
   `confirmProduction` dialog with the same description.
5. Write with `fs.writeFileSync` (whole file, same encoding, LF unless the file
   used CRLF). Watchers refresh the dashboard.

### Renaming and deleting a group (decided by the user)

Rename and delete of a server group or service are **separate actions**, not
part of the draft, because they reach beyond `hosts.ini`. They follow the
environment rename/delete pattern of step 21: a plan first, the plan shown in
the confirmation, then apply. They are refused while the environment has an
unsaved draft (the page asks to Save or Discard first), and they carry the
file hash like `saveInventory`.

* `planGroupRename(env, inventory, from, to, discovered)` in
  `src/inventory.js` (pure) →
  * `hosts.ini`: the group's sections renamed, and every service's children
    list updated;
  * `group_vars/<from>/` → `group_vars/<to>/` in **this environment only**, if
    it exists (refused if `group_vars/<to>/` already exists);
  * `playbookRunner.serviceEnvironments`: the key renamed when it names the
    group (`renameInSetting`, as for environments);
  * **listed, not edited**: playbooks whose `hosts:` line names `<from>` (read
    with the same line scanner style as `tags.js`), and the other
    environments that still have a group called `<from>`.
  Refused for manual groups and for a name that fails validation or is taken.
* `planGroupDelete(env, inventory, name, discovered)` →
  * `hosts.ini`: the group's sections removed, and the group removed from
    every service's children (listed per service in the dialog);
  * the dialog offers a checkbox-style second button *"Also move
    group_vars/<name>/ to the trash"*, off by default; the move uses
    `vscode.workspace.fs.delete(..., { useTrash: true })` with no permanent
    fallback, as for environments;
  * playbooks naming the group in `hosts:` are listed as a warning.
  Refused for manual groups. Deleting a server group that is the only child of
  a service leaves the service with no children, and the dialog says so.
* Messages `renameGroup { environment, hash, group }` and
  `deleteGroup { environment, hash, group }`; the new name is asked for by the
  extension in an input box, never taken from the page (as for environments).
* Production environments get `confirmProduction` with the plan as the
  description.

### Page (`media/dashboard/main.js`)

```
[ Runs | Settings | Inventory ]          environment: [ staging | production ]

Services (access control)                       [+ Service]
  immich        ☑ nfs_servers ☑ podman_servers ☐ dns_servers …   [⋯]
  nextcloud     ☑ nfs_servers ☑ podman_servers ☐ dns_servers …
  jellyfin      not in inventory — [Add]

Server groups                                   [+ Server group]
  ▾ podman_servers                         [vars] [vault] [⋯]
      podman_server  podman-server.int…  user podman-server  key ~/.ssh/…  [edit] [✕]
      [+ Host]
  ▸ nfs_servers (1 host)

Manual sections
  ▸ proxmox_servers (lines 120–126)  read-only        [Open in editor]

                                      [Discard]  [Save]   ● unsaved changes
```

Host edit form: name, `ansible_host`, `ansible_user`, `ansible_port`,
`ansible_ssh_private_key_file`, `ansible_ssh_common_args`, then "Other
variables" key/value rows. Validation errors are shown inline before Save is
enabled (the extension validates again; the page's check is convenience only).

### Docs

`README.md`: dashboard sketch with the Inventory tab, a section on manual
blocks and the no-password rule. `CHANGELOG.md` entry. `workflow.md` step 25.

## Decisions made by Claude (open to correction)

* Outside manual blocks the extension owns the file and rewrites it in the
  canonical layout; comments there are dropped and duplicates merged, with a
  warning and diff on the save that does it.
* Draft + Save per environment rather than writing on every click.
* Password variables refused; vault offered instead.
* Groups classified by the presence of a `:children` section.
* Directories without an inventory file appear as candidates with *Create
  inventory*.
* Groups defined inside manual blocks are read-only but usable as children.

## Left to the builder

* Exact CSS and component structure of the tab.
* Hash function (any stable content hash from `node:crypto`).
* How the diff's right-hand document is provided (untitled document vs a
  `TextDocumentContentProvider`).
* Length caps in `parseWebviewMessage`.
