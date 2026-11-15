# Playbook Runner — dashboard only, no sidebar

Status: design, awaiting approval (2026-11-14)

## Why

The dashboard tab (spec `2026-11-14-playbook-runner-dashboard-design.md`)
turned out to be the place Sebastian works from. The sidebar tree now
duplicates it, so it goes. Everything the tree could do moves into the
dashboard.

## Decided

- Remove the sidebar: the activity bar container, the `playbookRunnerExplorer`
  view, its welcome view, every `view/*` menu, and `src/tree.js`.
- Entry point: an always-visible status bar item **`$(run-all) Playbook
  Runner`** opens the dashboard. It reads `· N running` while playbooks run,
  which replaces the tree's badge. The last-run status bar item stays and
  still re-runs on click. The palette has *Open Dashboard*.
- No auto-open on startup.

## What moves into the dashboard

| Tree had | Dashboard gets |
| --- | --- |
| ▶ on a playbook row: run now with no options | a ▶ on each playbook card's header ("Run now, no options") |
| ▶ on a tag row: `--tags <that one>` only | expanded card: a **Tags** line, each tag with ▶ (run only this tag) and a click to add it to `--tags` |
| ⚙ run with options | the run bar (already there) |
| *Env* row | `env.yml` link (already there) |
| *Vault* row: edit, or create when missing | service header: **Edit vault** / **Create vault** |
| environment → *Rekey Vaults…* | top bar: **Rekey vaults** for the chosen environment |
| *Create Service Skeleton…* | top bar: **New service…** |
| *Re-run Last* (title bar) | top bar: **Re-run last** |
| services with only `group_vars` (e.g. `all`) | listed too. Today the dashboard hides services without playbooks, which would make their Env and Vault unreachable. |
| welcome view when nothing is found | empty state with **Open Settings** and **New service…** |

## How (constraints carried over)

- New webview messages `vault {folder, environment, service, action}`,
  `rekey {folder, environment}`, `createService {folder}`, `rerunLast`,
  `openSettings`. They are parsed field by field in `src/model.js` and
  resolved against the model, with tests, like the existing ones.
  *Run this tag* and *run now* reuse the existing `run` message
  (`{tags: tag}` / `{}`).
- The vault, rekey and create-service actions call the existing commands with
  a node built **in the extension** from discovery's objects, never from the
  message. That keeps one implementation each, with the same production
  confirmation and the same vault terminal.
- The model gains each service's `vaultFile` / `hasVault`. The outline reply
  gains the playbook's tags (`findPlaybookTags`), in run order with sources.
- The palette commands stay, and keep asking through pickers when invoked
  without an argument.

## Non-goals

- No other change to running, ranges, history or the runner terminal.

## Approaches

Decided in conversation: dashboard only, opened from the status bar and the
palette (vs. also auto-opening on startup, vs. keeping a launcher icon in the
activity bar).
