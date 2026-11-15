---
name: vscode-extension-release
description: Cutting a version of the Playbook Runner VS Code extension - bumping the version, writing the changelog, building the .vsix in dist/ and installing it. Use for "release the extension", "bump the extension version", "build a vsix", "why is VS Code still on the old version".
---

# Releasing the Playbook Runner extension

There is no build step and no marketplace — a release is a version bump, a
changelog entry and a `.vsix` the user installs locally. Everything happens in
`scripts/vscode-extension/`.

## Order

1. **`npm run check` first.** Lint, typecheck and tests must pass before the
   version moves; a `.vsix` built over a failing check is worse than no `.vsix`.
2. **Decide the version.** `package.json` `version` is the single source of
   truth — VS Code reads it, not the directory name. Patch for fixes, minor for
   new dashboard actions, commands or settings. Ask the user if it is not obvious.
3. **`CHANGELOG.md`**: a new `## <version>` section at the top, bullets in the
   voice of the existing ones — what changed and *why it mattered*, not a commit
   log. Group by area the way 0.3.0 does.
4. **`README.md`**: the install line names the file by version —
   `code --install-extension dist/playbook-runner-0.3.0.vsix`. Bump it, or it
   tells the user to install a file that no longer exists. Check the settings
   table and dashboard sketch still match while you are in there.
5. **Build**:
   ```bash
   npm run package      # -> dist/playbook-runner-<version>.vsix
   ```
   `dist/` and `*.vsix` are gitignored; the artefact is never committed.
6. **Report**: the path of the `.vsix`, and the install command. Installing it
   into the user's editor is their call — offer it, do not do it unasked.

## Details worth knowing

- `npm run package` passes `--no-dependencies` (the extension has no runtime
  dependencies, only dev tooling). If `vsce`
  complains about something new, fix the cause rather than adding a flag.
- `.vscodeignore` decides what ships: `extension.js`, `src/`, `media/`,
  `package.json`, `README.md`, `CHANGELOG.md`. Tests, `workflow.md`,
  `eslint.config.js`, `tsconfig.json`, `.vscode/`, `.claude/`, `docs/` and
  `node_modules/` stay out.
  A new development-only file at the top level needs a line there.
- **The symlink install does not need a release.** If the user installed via
  `~/.vscode/extensions/playbook-runner-<version>` → this repository, a `git pull` plus
  *Developer: Reload Window* is the whole update, and the stale directory name
  is harmless. That is the usual reason "the new version isn't showing up" —
  check which install they have before rebuilding anything.
- A `.vsix` install needs *Developer: Reload Window* too.
- Removing or renaming a command id or setting is a breaking change for
  keybindings and `settings.json`. Keep the old id registered as an alias by
  default, and say so in the changelog. The `homelab.*` → `playbookRunner.*`
  rename was a deliberate exception (a clean break, workflow.md step 15) —
  call it out under **Breaking** when that version is cut.
