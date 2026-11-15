# Contributing

The extension is plain CommonJS JavaScript with **no build step** — what is
committed is what ships. Types are JSDoc, checked with `tsc --noEmit` under
`strict`. [workflow.md](workflow.md) is the design record: why it is built this
way, and the trade-offs that were accepted deliberately.

## Layout

```
extension.js        activation, commands, watchers
src/discovery.js    filesystem scanning        ⟵ no `vscode` import, hence testable
src/command.js      ansible argument vectors   ⟵ likewise
src/defaults.js     the default of every setting, and their types
src/paths.js        ${...} expansion, vault password and production rules  ⟵ likewise
src/tags.js         the tags a playbook offers, read out of the YAML  ⟵ likewise
src/scaffold.js     the paths a new service is laid out at  ⟵ likewise
src/environments.js creating, renaming and removing an environment  ⟵ likewise
src/settings.js     reading the settings out of vscode
src/history.js      the run history  ⟵ likewise
src/model.js        the dashboard model and the checks on its messages  ⟵ likewise
src/runner.js       the runner and vault terminals
src/tracker.js      recording runs in the history
src/dashboard.js    the dashboard webview panel
media/dashboard/    the dashboard page
src/pickers.js      the QuickPick chain used by the palette commands
```

The modules marked above import nothing from `vscode`, which is what lets
`node --test` cover the parts that decide what ends up on an ansible command
line. The rest is the editor surface.

`F5` opens an Extension Development Host with `../homelab-infra` loaded —
an Ansible repository checked out beside this one; edit
`.vscode/launch.json` to point it at yours. Logs land
in *Help → Toggle Developer Tools → Console*.

```bash
npm install       # dev tooling: eslint, typescript, vsce
npm run check     # lint + typecheck + tests, the one to run before committing
npm run lint      # eslint
npm run typecheck # tsc over the JSDoc types; nothing is emitted
npm test          # node --test
npm run package   # dist/playbook-runner-<version>.vsix
```

Types are JSDoc, checked with `tsc --noEmit` under `strict`; there is no
compile step and nothing is generated. `npm install` brings in dev tooling
only — the extension itself has no runtime dependencies, which is why
`npm run package` passes `--no-dependencies`.

## Running from source

Build a `.vsix` and install it:

```bash
npm install
npm run package      # -> dist/playbook-runner-<version>.vsix
code --install-extension dist/playbook-runner-<version>.vsix
```

Or symlink the checkout, so that `git pull` plus *Developer: Reload Window* is
the update:

```bash
ln -s "$PWD" ~/.vscode/extensions/playbook-runner-dev
```

VS Code reads `package.json`, not the directory name. For VS Code Insiders or
the Flatpak build, use `~/.vscode-insiders/extensions` or
`~/.var/app/com.visualstudio.code/data/vscode/extensions` instead. Uninstall a
Marketplace copy first, or the two compete.
