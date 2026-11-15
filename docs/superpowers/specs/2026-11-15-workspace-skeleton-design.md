# Get started and starter playbooks — design

## Why

The extension is about to be published. Someone who finds it on the
Marketplace and opens an empty folder today gets "No Ansible environments
found" and can create an empty environment and an empty service folder — and
then has nothing to run. The goal: from an empty folder to a first ▶ that
actually runs Ansible, in one step.

## Goals

* **Get started** on the dashboard's empty state lays out a complete, runnable
  workspace: `ansible.cfg`, `roles/`, one environment, one service with a
  starter playbook, and an inventory that puts `localhost` in that service's
  group. After it, ▶ on the starter playbook succeeds on the user's machine.
* **New service…** can optionally create the same starter playbook.

## Non-goals and anti-goals

* No templates for anything beyond the starter: no example roles, no vault, no
  CI files.
* **The extension still never chooses hosts in an existing repository.** Only
  Get started writes `localhost`, and only into an inventory it creates.
* Nothing existing is ever overwritten — files are created with `wx`, as now.
* No hardcoded environment or service names: both are typed by the user, the
  input boxes start empty (placeholders are examples only).

## Approaches

* **A — one combined plan in `src/scaffold.js` (chosen).** A pure function
  builds a single `SkeletonEntry` list from the existing environment and
  service planning plus the new files; one confirmation, testable under
  `node --test`.
* B — chain the existing commands. Less code, but two or three confirmations
  with no overview, and the inventory would have to be edited after it was
  written to add `localhost`.
* C — template files shipped in the extension and copied with substitution. A
  second mechanism beside the plan/confirm one, for no gain.

## Design

### Pure module (`src/scaffold.js`)

* `starterPlaybook(service)` → the YAML text:
  ```yaml
  - name: <service>
    hosts: <service>
    gather_facts: false
    tasks:
      - name: Check the connection
        ansible.builtin.ping:
        tags: [hello]
  ```
* `planService(root, name, settings, { starter })` — unchanged entries plus,
  with `starter: true`, `playbooks/<service>/<service>.yml` with that content.
* `planWorkspace(root, { environment, service }, settings)` → a plan with:
  * `ansible.cfg` — `[defaults]\nroles_path = <rolesDir>\n`
  * `<rolesDir>/`, `<playbooksDir>/<service>/` and the starter playbook
  * `<inventoriesDir>/<environment>/<inventoryFile>` containing
    `[<service>]\nlocalhost ansible_connection=local\n`
  * `<groupVarsDir>/<service>/<envFileName>` (empty) in that environment
  * validated with the existing `validateEnvironmentName` /
    `validateServiceName`; refused if the folder already has an environment.
* Every entry keeps `exists`, so the confirmation lists only what is missing —
  an `ansible.cfg` that is already there is left alone and not listed.

### Editor surface

* `extension.js`: a `getStarted(node, refresh)` command
  (`playbookRunner.getStarted`, *Playbook Runner: Get Started…*): pick folder →
  environment name → service name → confirmation listing the paths → create →
  refresh, open the starter playbook in the editor.
* New service…: after the name, a QuickPick *Empty folder* / *With a starter
  playbook*. When the service's group has no hosts in an environment, the
  confirmation says so (the playbook would match no hosts there).
* Dashboard empty state: **Get started…** becomes the primary button; *New
  environment…*, *New service…* and *Open Settings* stay beside it. A new
  `getStarted` webview message, rebuilt and checked in `src/model.js` like the
  others.

### Docs

README (empty-folder walkthrough in *Repository layout*, the command), CHANGELOG
entry under Unreleased, a `workflow.md` step: the extension now writes a host
once, and only into an inventory it creates.

## Left to the builder

* How "the group has no hosts" is detected for the New service note — a simple
  INI scan of the inventory is enough; YAML inventories can skip the note.
* Exact wording of prompts and confirmations, in the voice of the existing ones.
