/**
 * Playbook Runner — an Ansible sidebar for this repository.
 *
 * Playbooks, environments and vaults are discovered from the filesystem
 * (src/discovery.js), so no path, and in particular no environment name, is
 * written down anywhere in here. The commands below replace the shell scripts
 * this repository used to keep in scripts/ (run-ansible-playbooks.sh and the two
 * vault scripts), which have been removed — this is now the only front end.
 */

"use strict";

const vscode = require("vscode");

const { sanitizeRunOptions } = require("./src/command");
const { findEnvironments, findVaultGroups } = require("./src/discovery");
const { resolveVaultPasswordFile } = require("./src/paths");
const { findPlaybookTags, formatTagList, parseTagList } = require("./src/tags");
const runner = require("./src/runner");
const pickers = require("./src/pickers");
const scaffold = require("./src/scaffold");
const { readSettings } = require("./src/settings");
const { PlaybookRunnerTreeProvider } = require("./src/tree");

const LAST_RUN_KEY = "playbookRunner.lastRun";

/**
 * A tree node, as it arrives back through a command argument. Every field is
 * optional: the same commands are in the palette, where there is no node and
 * everything gets asked for instead.
 *
 * @typedef {object} CommandNode
 * @property {vscode.WorkspaceFolder} [folder]
 * @property {import("./src/discovery").Environment} [environment]
 * @property {string} [playbookFile]
 * @property {string} [tag]
 * @property {string} [envFile]
 * @property {string} [vaultFile]
 * @property {boolean} [hasVault]
 */

/**
 * @param {unknown} value
 * @returns {CommandNode}
 */
function asCommandNode(value) {
  return value && typeof value === "object" ? /** @type {CommandNode} */ (value) : {};
}

/** @param {unknown} err */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @typedef {object} LastRun
 * @property {string} folderPath
 * @property {string} environmentName
 * @property {string} playbookFile
 * @property {import("./src/command").RunOptions} options
 */

/**
 * The last run as workspace state gave it back. It survives restarts and
 * upgrades, so it is checked rather than trusted -- see sanitizeRunOptions.
 *
 * @param {unknown} value
 * @returns {LastRun | null}
 */
function parseLastRun(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  if (
    typeof raw.folderPath !== "string" ||
    typeof raw.environmentName !== "string" ||
    typeof raw.playbookFile !== "string"
  ) {
    return null;
  }
  return {
    folderPath: raw.folderPath,
    environmentName: raw.environmentName,
    playbookFile: raw.playbookFile,
    options: sanitizeRunOptions(raw.options),
  };
}

/**
 * Resolve a command invocation to folder + settings + environment, taking what
 * a tree node already knows and asking for the rest.
 *
 * @param {CommandNode} node
 * @returns {Promise<{ folder: vscode.WorkspaceFolder, settings: import("./src/defaults").Settings, environment: import("./src/discovery").Environment } | null>}
 */
async function resolveContext(node) {
  const folder = node.folder || (await pickers.pickFolder());
  if (!folder) {
    return null;
  }
  const settings = readSettings(folder);

  const environment = node.environment || (await pickers.pickEnvironment(folder, settings));
  if (!environment) {
    return null;
  }

  return { folder, settings, environment };
}

/**
 * Run a playbook: from a row, from a tag row, or from the palette.
 *
 * `withOptions` is the ⚙ path, which asks. Without it the node may still carry
 * a single tag -- that is a tag row, which runs the playbook with only that
 * one. It goes through the same parse the picker's result does, because it
 * reaches a command line either way.
 *
 * @param {vscode.ExtensionContext} context
 * @param {unknown} argument
 * @param {boolean} withOptions
 */
async function runPlaybookCommand(context, argument, withOptions) {
  const node = asCommandNode(argument);
  const resolved = await resolveContext(node);
  if (!resolved) {
    return;
  }
  const { folder, settings, environment } = resolved;

  const playbookFile =
    node.playbookFile || (await pickers.pickPlaybook(folder, settings));
  if (!playbookFile) {
    return;
  }

  const label = runner.playbookLabel(folder.uri.fsPath, settings, playbookFile);

  /** @type {import("./src/command").RunOptions} */
  let options = {};
  if (withOptions) {
    const last = parseLastRun(context.workspaceState.get(LAST_RUN_KEY));
    const previous = last && last.playbookFile === playbookFile ? last.options : {};
    // Read out of the YAML rather than asked of ansible, so the checkbox list
    // is there without a vault passphrase and without a wait -- see src/tags.js
    // for what that trades away.
    const tags = findPlaybookTags(folder.uri.fsPath, playbookFile, settings);
    const picked = await pickers.pickRunOptions(previous, tags);
    if (!picked) {
      return;
    }
    options = picked;
  } else {
    const tags = formatTagList(parseTagList(node.tag));
    if (tags) {
      options.tags = tags;
    }
  }

  const description = options.tags ? `${label} --tags ${options.tags}` : label;
  if (!(await pickers.confirmProduction(settings, environment, description))) {
    return;
  }

  /** @type {LastRun} */
  const lastRun = {
    folderPath: folder.uri.fsPath,
    environmentName: environment.name,
    playbookFile,
    options,
  };
  await context.workspaceState.update(LAST_RUN_KEY, lastRun);

  try {
    await runner.runPlaybook(folder, settings, { environment, playbookFile, options });
  } catch (err) {
    vscode.window.showErrorMessage(`Playbook Runner: could not run ${label}: ${messageOf(err)}`);
  }
}

/** @param {vscode.ExtensionContext} context */
async function rerunLast(context) {
  const last = parseLastRun(context.workspaceState.get(LAST_RUN_KEY));
  if (!last) {
    vscode.window.showInformationMessage("Playbook Runner: nothing has been run yet.");
    return;
  }

  const folder = (vscode.workspace.workspaceFolders || []).find(
    (item) => item.uri.fsPath === last.folderPath,
  );
  if (!folder) {
    vscode.window.showErrorMessage("Playbook Runner: the folder of the last run is no longer open.");
    return;
  }

  const settings = readSettings(folder);
  const environment = findEnvironments(folder.uri.fsPath, settings).find(
    (item) => item.name === last.environmentName,
  );
  if (!environment) {
    vscode.window.showErrorMessage(
      `Playbook Runner: environment "${last.environmentName}" no longer exists.`,
    );
    return;
  }

  const label = runner.playbookLabel(folder.uri.fsPath, settings, last.playbookFile);
  const description = last.options.tags ? `${label} --tags ${last.options.tags}` : label;
  if (!(await pickers.confirmProduction(settings, environment, description))) {
    return;
  }

  try {
    await runner.runPlaybook(folder, settings, {
      environment,
      playbookFile: last.playbookFile,
      options: last.options,
    });
  } catch (err) {
    vscode.window.showErrorMessage(`Playbook Runner: could not run ${label}: ${messageOf(err)}`);
  }
}

/**
 * @param {unknown} argument
 * @param {"edit" | "create"} action
 */
async function vaultCommand(argument, action) {
  const node = asCommandNode(argument);
  const resolved = await resolveContext(node);
  if (!resolved) {
    return;
  }
  const { folder, settings, environment } = resolved;

  let vaultFile = node.vaultFile;
  if (vaultFile && node.hasVault === (action !== "edit")) {
    // Node came from the other kind of row -- fall back to asking.
    vaultFile = undefined;
  }
  if (!vaultFile) {
    const group = await pickers.pickVaultGroup(environment, settings, action);
    if (!group) {
      return;
    }
    vaultFile = group.vaultFile;
  }

  try {
    runner.runVaultCommand(folder, settings, { environment, vaultFile, action });
  } catch (err) {
    vscode.window.showErrorMessage(
      `Playbook Runner: could not ${action} the vault: ${messageOf(err)}`,
    );
  }
}

/**
 * Rotate the passphrase of every vault in one environment.
 *
 * One environment per invocation on purpose. The passphrase is per environment
 * -- playbookRunner.vaultPasswordFiles is keyed by environment name -- so "rekey
 * everything" is not one operation but one per environment, each with its own
 * old and new passphrase. Offering it across all of them would only mean typing
 * the wrong passphrase into the wrong set of files.
 *
 * @param {unknown} argument
 */
async function rekeyVaultsCommand(argument) {
  const node = asCommandNode(argument);
  const resolved = await resolveContext(node);
  if (!resolved) {
    return;
  }
  const { folder, settings, environment } = resolved;

  const vaultFiles = findVaultGroups(environment, settings)
    .filter((group) => group.hasVault)
    .map((group) => group.vaultFile);
  if (!vaultFiles.length) {
    vscode.window.showErrorMessage(
      `Playbook Runner: no ${settings.vaultFileName} in ${environment.name} to rekey.`,
    );
    return;
  }

  const passwordFile = resolveVaultPasswordFile(
    settings,
    environment.name,
    folder.uri.fsPath,
  );
  if (!(await pickers.confirmRekey(environment, vaultFiles.length, passwordFile))) {
    return;
  }
  const label = `a rekey of ${vaultFiles.length} vault${vaultFiles.length === 1 ? "" : "s"}`;
  if (!(await pickers.confirmProduction(settings, environment, label))) {
    return;
  }

  try {
    runner.runVaultRekey(folder, settings, { environment, vaultFiles });
  } catch (err) {
    vscode.window.showErrorMessage(
      `Playbook Runner: could not rekey the vaults of ${environment.name}: ${messageOf(err)}`,
    );
  }
}

/**
 * @param {unknown} argument
 * @param {"playbookFile" | "envFile"} key
 */
async function openFile(argument, key) {
  const file = asCommandNode(argument)[key];
  if (!file) {
    return;
  }
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document);
  } catch (err) {
    vscode.window.showErrorMessage(`Playbook Runner: could not open ${file}: ${messageOf(err)}`);
  }
}

/**
 * Lay out the directories of a new service: playbooks/<name>/ once, and a
 * group_vars/<name>/ with an empty env file in every environment (or in those
 * playbookRunner.serviceEnvironments names), so a service cannot end up existing in
 * one environment and missing from another.
 *
 * The plan is shown before anything is written, and only what is missing is
 * created -- an env file that exists is never touched. The vault is left to
 * `ansible-vault create`, which the tree offers on the new group_vars row.
 *
 * @param {unknown} argument
 * @param {() => void} refresh
 */
async function createServiceSkeleton(argument, refresh) {
  const node = asCommandNode(argument);
  const folder = node.folder || (await pickers.pickFolder());
  if (!folder) {
    return;
  }
  const settings = readSettings(folder);
  const root = folder.uri.fsPath;

  const name = await pickers.pickServiceName(scaffold.existingServiceNames(root, settings));
  if (!name) {
    return;
  }

  /** @type {import("./src/scaffold").SkeletonPlan} */
  let plan;
  try {
    plan = scaffold.planService(root, name, settings);
  } catch (err) {
    vscode.window.showErrorMessage(`Playbook Runner: ${messageOf(err)}`);
    return;
  }

  const missing = plan.entries.filter((entry) => !entry.exists);
  if (!missing.length) {
    vscode.window.showInformationMessage(
      `Playbook Runner: ${plan.name} already has every directory; nothing to create.`,
    );
    return;
  }

  const detail = missing
    .map((entry) => (entry.type === "directory" ? `${entry.relative}/` : entry.relative))
    .join("\n");
  const notes = [];
  if (plan.unknownEnvironments.length) {
    notes.push(
      `playbookRunner.serviceEnvironments names ${plan.unknownEnvironments.join(", ")}, which ${plan.unknownEnvironments.length === 1 ? "is not an environment" : "are not environments"} (no ${settings.inventoryFile} under ${settings.inventoriesDir}/) — skipped.`,
    );
  }
  if (!plan.environments.length) {
    notes.push(
      plan.limited
        ? "None of the environments in playbookRunner.serviceEnvironments exist, so only the playbook folder is created."
        : `No environment found under ${settings.inventoriesDir}/, so only the playbook folder is created.`,
    );
  } else if (plan.limited) {
    notes.push(`Environments limited by playbookRunner.serviceEnvironments: ${plan.environments.join(", ")}.`);
  }
  const note = notes.map((line) => `\n\n${line}`).join("");
  const answer = await vscode.window.showInformationMessage(
    `Create the skeleton for ${plan.name}?`,
    { modal: true, detail: `${detail}${note}` },
    "Create",
  );
  if (answer !== "Create") {
    return;
  }

  try {
    const { created } = scaffold.createSkeleton(plan);
    refresh();
    vscode.window.showInformationMessage(
      `Playbook Runner: created ${created.length} ${created.length === 1 ? "entry" : "entries"} for ${plan.name}.`,
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Playbook Runner: could not create the skeleton for ${plan.name}: ${messageOf(err)}`,
    );
  }
}

/**
 * The file watchers that keep the tree current.
 *
 * They are scoped to each folder's configured playbooks/ and inventories/
 * rather than the whole workspace, and rebuilt when either of those settings
 * or the folder list changes -- a watcher on last session's directory would
 * quietly stop refreshing anything.
 */
class Watchers {
  /** @param {() => void} onChange */
  constructor(onChange) {
    this.onChange = onChange;
    /** @type {vscode.Disposable[]} */
    this.disposables = [];
    this.rebuild();
  }

  rebuild() {
    this.dispose();
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const settings = readSettings(folder);
      for (const dir of [settings.playbooksDir, settings.inventoriesDir]) {
        if (!dir) {
          continue;
        }
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(folder, `${dir}/**`),
        );
        this.disposables.push(
          watcher,
          watcher.onDidChange(this.onChange),
          watcher.onDidCreate(this.onChange),
          watcher.onDidDelete(this.onChange),
        );
      }
    }
  }

  dispose() {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const provider = new PlaybookRunnerTreeProvider();
  const refresh = () => provider.refresh();
  const watchers = new Watchers(refresh);

  /**
   * @param {string} id
   * @param {(...args: any[]) => any} handler
   */
  const register = (id, handler) => vscode.commands.registerCommand(id, handler);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("playbookRunnerExplorer", provider),
    watchers,

    register("playbookRunner.runPlaybook", (node) => runPlaybookCommand(context, node, false)),
    register("playbookRunner.runPlaybookWithOptions", (node) =>
      runPlaybookCommand(context, node, true),
    ),
    register("playbookRunner.runPlaybookTag", (node) => runPlaybookCommand(context, node, false)),
    register("playbookRunner.rerunLast", () => rerunLast(context)),
    register("playbookRunner.editVault", (node) => vaultCommand(node, "edit")),
    register("playbookRunner.createVault", (node) => vaultCommand(node, "create")),
    register("playbookRunner.rekeyVaults", (node) => rekeyVaultsCommand(node)),
    register("playbookRunner.openPlaybook", (node) => openFile(node, "playbookFile")),
    register("playbookRunner.openEnv", (node) => openFile(node, "envFile")),
    register("playbookRunner.createService", (node) => createServiceSkeleton(node, refresh)),
    register("playbookRunner.refresh", refresh),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      watchers.rebuild();
      refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("playbookRunner")) {
        watchers.rebuild();
        refresh();
      }
    }),
  );
}

function deactivate() {
  runner.dispose();
}

module.exports = { activate, deactivate };
