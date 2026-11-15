---
name: vscode-extension-release
description: Cutting a version of the Playbook Runner VS Code extension - bumping the version, writing the changelog, building the .vsix in dist/, and publishing it to the VS Code Marketplace and Open VSX. Use for "release the extension", "publish the extension", "bump the extension version", "build a vsix", "why is VS Code still on the old version".
---

# Releasing the Playbook Runner extension

There is no build step — a release is a version bump, a changelog entry, a
`.vsix`, and that same `.vsix` published to the VS Code Marketplace and to
Open VSX under the publisher `sebgad`. Everything happens at the root of this
repository, `vscode-playbook-runner`.

## Order

1. **`npm run check` first.** Lint, typecheck and tests must pass before the
   version moves; a `.vsix` built over a failing check is worse than no `.vsix`.
2. **Decide the version.** `package.json` `version` is the single source of
   truth — VS Code reads it, not the directory name. Patch for fixes, minor for
   new dashboard actions, commands or settings. Ask the user if it is not obvious.
3. **`CHANGELOG.md`**: turn `## Unreleased` into `## <version>`, bullets in
   the voice of the existing ones — what changed and *why it mattered*, not a
   commit log. Group by area the way 0.3.0 does. The Marketplace shows this
   file as the extension's *Changelog* tab.
4. **`README.md`** is the Marketplace page. Check the settings table, the
   requirements and the dashboard sketch still match.
5. **Build**:
   ```bash
   npm run package      # -> dist/playbook-runner-<version>.vsix
   ```
   `dist/` and `*.vsix` are gitignored; the artefact is never committed.
6. **Check what ships**: `npx vsce ls --no-dependencies` lists the files the
   package holds — no `test/`, `docs/`, `CLAUDE.md` or `.claude/`.
7. **Publish — only when the user says so.** It is public and a version number
   can never be reused, even after unpublishing. Publish the file just built,
   so both registries get the same bytes:
   ```bash
   npx vsce publish --packagePath dist/playbook-runner-<version>.vsix   # token: VSCE_PAT
   npx ovsx publish dist/playbook-runner-<version>.vsix                 # token: OVSX_PAT
   ```
   The tokens are the user's; never ask for them in chat or write them to a
   file — they set `VSCE_PAT` / `OVSX_PAT` in their shell. The first Open VSX
   publish needs the namespace once: `npx ovsx create-namespace sebgad`.
8. **Report**: the `.vsix` path and, if published, the Marketplace and Open
   VSX listing URLs. Installing into the user's editor is their call — offer
   it, do not do it unasked.

## Details worth knowing

- `npm run package` passes `--no-dependencies` (the extension has no runtime
  dependencies, only dev tooling). If `vsce`
  complains about something new, fix the cause rather than adding a flag.
- `.vscodeignore` decides what ships: `extension.js`, `src/`, `media/`,
  `ansible/`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`. Tests,
  `workflow.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `eslint.config.js`,
  `tsconfig.json`, `.vscode/`, `.claude/`, `docs/` and `node_modules/` stay
  out.
  A new development-only file at the top level needs a line there.
- `"preview": true` in `package.json` shows the Preview badge. Dropping it is
  the user's decision, typically with a 1.0.
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
