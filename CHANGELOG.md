# Changelog

## 0.4.0

* *Homelab: Rekey Vaults…* (`homelab.rekeyVaults`, and the context menu of an
  environment row) rotates the passphrase of every vault in one environment
  through a single `ansible-vault rekey`. One environment per invocation: the
  passphrase is per environment, so rekeying across all of them at once could
  only mean typing the wrong one into the wrong files.
* The new passphrase is never passed as an argument —
  `--new-vault-password-file` is deliberately omitted so ansible prompts for it,
  keeping it out of the process table and the shell history. A resolved
  `vaultPasswordFiles` entry is passed as the *current* passphrase only, and the
  confirmation points out that the file still holds the old one afterwards.
* The confirmation is shown in every environment, not just production, and warns
  that a run failing part-way leaves the vaults split between the two
  passphrases. Production still asks a second time.
* *Homelab: Create Service Skeleton…* (`homelab.createService`, the ＋ folder
  button in the view title) lays out a new service in one go: `playbooks/<name>/`
  and a `group_vars/<name>/` holding an empty env file in **every** environment.
  A service that exists in one environment and is missing from another is the
  drift this removes, so the command takes no environment and is not offered on
  an environment row.
* The paths are listed for confirmation before anything is written, and only
  what is missing gets created: files are opened `wx`, so an `env.yml` that is
  already there is never overwritten and running the command again on the same
  name simply fills the gaps.
* No `vault.yml` is created — an encrypted file is `ansible-vault create`'s job,
  which the new group_vars directory offers on its ＋ *Vault* row.
* The path and name rules live in `src/scaffold.js`, which imports no `vscode`
  for the same reason the other four such modules do not: `test/scaffold.test.js`
  covers what ends up on disk.

## 0.3.0

* Clicking a playbook row opens the file in the editor instead of running
  it; running moved to the row's inline `▶` and `⚙` buttons.
* Activity bar icon is the Ansible mark.
* npm environment: `npm run lint` (ESLint 9), `npm run typecheck` (tsc over the
  JSDoc types), `npm test` (node:test), `npm run package` (`.vsix` into `dist/`).
* The extension declares itself unsupported in untrusted and virtual
  workspaces, and the settings naming an executable or a vault password file
  (`ansiblePlaybookCommand`, `ansibleVaultCommand`, `vaultPasswordFilePattern`,
  `vaultPasswordFiles`) are now `machine` scope, so a repository's
  `.vscode/settings.json` can no longer decide what gets run.
* Playbook task arguments are passed to the shell with explicit strong
  quoting instead of relying on VS Code's default.
* Vault commands get their own terminal per run, so a second vault action can
  no longer type into the `nano` a previous one left open. The terminal takes
  focus now, since the command starts by asking for the password, and finished
  ones are closed when the next vault command runs.
* File watchers are rebuilt when `homelab.playbooksDir` or
  `homelab.inventoriesDir` changes.
* Playbook discovery no longer follows symlink cycles.
* The pure path helpers moved out of `src/settings.js` into `src/paths.js`, so
  they are covered by the plain-node tests.

## 0.2.0

* Environments, playbooks and vaults are discovered from the filesystem; the
  tree became environment → service → Playbooks / Env / Vault.
* Playbooks run as a `vscode.Task`, vaults in a terminal.

## 0.1.0

* First version: a flat tree over the entries in `.vscode/tasks.json`.
