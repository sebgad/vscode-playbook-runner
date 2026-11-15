/**
 * Playbook Runner — an Ansible dashboard for this repository.
 *
 * Playbooks, environments and vaults are discovered from the filesystem
 * (src/discovery.js), so no path, and in particular no environment name, is
 * written down anywhere in here. The commands below replace the shell scripts
 * this repository used to keep in scripts/ (run-ansible-playbooks.sh and the two
 * vault scripts), which have been removed — this is now the only front end.
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const {
  buildPlaybookEnv,
  describeRun,
  hasTaskRange,
  sanitizeRunOptions,
  validateTaskRange,
} = require("./src/command");
const { findEnvironments, findVaultGroups } = require("./src/discovery");
const { resolveVaultPasswordFile } = require("./src/paths");
const {
  findPlaybookOutline,
  findPlaybookTags,
  formatTagList,
  parseTagList,
} = require("./src/tags");
const runner = require("./src/runner");
const pickers = require("./src/pickers");
const environments = require("./src/environments");
const { isProductionName } = require("./src/paths");
const scaffold = require("./src/scaffold");
const { DashboardPanel, VIEW_TYPE } = require("./src/dashboard");
const { relativeTime } = require("./src/history");
const { readSettings } = require("./src/settings");
const { RunTracker } = require("./src/tracker");

const LAST_RUN_KEY = "playbookRunner.lastRun";

/**
 * A command node, as it arrives back through a command argument from the
 * dashboard. Every field is
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
 * a command node already knows and asking for the rest.
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
 * Run a playbook from the palette, or from a caller passing a node.
 *
 * `withOptions` is the path that asks. Without it the node may still carry a
 * single tag, which runs the playbook with only that one. It goes through the same parse the picker's result does, because it
 * reaches a command line either way.
 *
 * @param {vscode.ExtensionContext} context
 * @param {RunTracker} tracker
 * @param {unknown} argument
 * @param {boolean} withOptions
 */
async function runPlaybookCommand(context, tracker, argument, withOptions) {
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

  /** @type {import("./src/command").RunOptions} */
  let options = {};
  if (withOptions) {
    const last = parseLastRun(context.workspaceState.get(LAST_RUN_KEY));
    const previous = last && last.playbookFile === playbookFile ? last.options : {};
    // Read out of the YAML rather than asked of ansible, so the checkbox list
    // is there without a vault passphrase and without a wait -- see src/tags.js
    // for what that trades away.
    const tags = findPlaybookTags(folder.uri.fsPath, playbookFile, settings);
    const outline = findPlaybookOutline(folder.uri.fsPath, playbookFile, settings);
    const picked = await pickers.pickRunOptions(previous, tags, outline);
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

  await startPlaybookRun(context, tracker, { folder, settings, environment, playbookFile, options });
}

/**
 * Everything every run goes through, whoever asked for it -- the
 * palette, Re-run Last or the dashboard: the task-range check, the production
 * confirmation, the remembered last run, the history entry, and only then the
 * task itself.
 *
 * @param {vscode.ExtensionContext} context
 * @param {RunTracker} tracker
 * @param {{ folder: vscode.WorkspaceFolder, settings: import("./src/defaults").Settings, environment: import("./src/discovery").Environment, playbookFile: string, options: import("./src/command").RunOptions }} run
 */
async function startPlaybookRun(context, tracker, run) {
  const { folder, settings, environment, playbookFile, options } = run;
  const root = folder.uri.fsPath;
  const label = runner.playbookLabel(root, settings, playbookFile);

  if (hasTaskRange(options)) {
    // Against a fresh outline: a remembered run whose task was renamed since
    // must stop here, not turn into a whole run.
    const reason = validateTaskRange(findPlaybookOutline(root, playbookFile, settings), options);
    if (reason) {
      vscode.window.showErrorMessage(`Playbook Runner: cannot run ${label}: ${reason}.`);
      return;
    }
  }

  if (!(await pickers.confirmProduction(settings, environment, describeRun(label, options)))) {
    return;
  }

  /** @type {LastRun} */
  const lastRun = {
    folderPath: root,
    environmentName: environment.name,
    playbookFile,
    options,
  };
  await context.workspaceState.update(LAST_RUN_KEY, lastRun);

  const runId = crypto.randomUUID();
  /** @type {string | null} */
  let statusFile = null;
  /** @type {Record<string, string>} */
  let env = {};
  if (hasTaskRange(options)) {
    const runsDir = path.join(context.globalStorageUri.fsPath, "runs");
    try {
      fs.mkdirSync(runsDir, { recursive: true });
    } catch (err) {
      vscode.window.showErrorMessage(`Playbook Runner: could not prepare ${runsDir}: ${messageOf(err)}`);
      return;
    }
    statusFile = path.join(runsDir, `${runId}.json`);
    try {
      // The one-shot token the range plugin insists on: it replaces this
      // with its result, so a replay of this task cannot run unchecked.
      fs.writeFileSync(statusFile, JSON.stringify({ armed: true }));
    } catch (err) {
      vscode.window.showErrorMessage(`Playbook Runner: could not write ${statusFile}: ${messageOf(err)}`);
      return;
    }
    env = buildPlaybookEnv({
      options,
      setupTags: settings.setupTags,
      pluginDir: path.join(context.extensionPath, "ansible", "strategy"),
      statusFile,
    });
  }

  await tracker.begin(
    {
      id: runId,
      folder: root,
      environment: environment.name,
      playbook: playbookFile,
      label,
      options,
      startedAt: Date.now(),
      status: "running",
    },
    statusFile,
  );

  try {
    const { finished } = await runner.runPlaybook(folder, settings, {
      environment,
      playbookFile,
      options,
      env,
    });
    if (finished) {
      void finished.then((exitCode) => tracker.end(runId, exitCode));
    } else {
      await tracker.end(runId, null);
    }
  } catch (err) {
    await tracker.abandon(runId);
    vscode.window.showErrorMessage(`Playbook Runner: could not run ${label}: ${messageOf(err)}`);
  }
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {RunTracker} tracker
 */
async function rerunLast(context, tracker) {
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

  await startPlaybookRun(context, tracker, {
    folder,
    settings,
    environment,
    playbookFile: last.playbookFile,
    options: last.options,
  });
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
 * Lay out the directories of a new service: playbooks/<name>/ once, and a
 * group_vars/<name>/ with an empty env file in every environment (or in those
 * playbookRunner.serviceEnvironments names), so a service cannot end up existing in
 * one environment and missing from another.
 *
 * The plan is shown before anything is written, and only what is missing is
 * created -- an env file that exists is never touched. The vault is left to
 * `ansible-vault create`, which the dashboard offers on the new service.
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

  const start = await pickers.pickServiceStart();
  if (!start) {
    return;
  }

  /** @type {import("./src/scaffold").SkeletonPlan} */
  let plan;
  try {
    plan = scaffold.planService(root, name, settings, { starter: start.starter });
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

  const detail = describeMissing(plan);
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
  if (start.starter) {
    const hostless = environmentsWithoutGroup(root, settings, plan);
    if (hostless.length) {
      notes.push(
        `${plan.name}.yml runs on the ${plan.name} group, which has no hosts in ${hostless.join(", ")} yet.`,
      );
    }
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

  const created = applyPlan(plan, refresh, {
    done: `for ${plan.name}.`,
    failed: `create the skeleton for ${plan.name}`,
  });
  if (created) {
    await openStarter(plan, root, settings, created);
  }
}

/**
 * Create what a plan lists, refresh the dashboard and report it. The caller
 * words the tail of the message and what failed.
 *
 * @param {{ entries: import("./src/scaffold").SkeletonEntry[] }} plan
 * @param {() => void} refresh
 * @param {{ done: string, failed: string }} wording  `done` follows "created N entries "; `failed` follows "could not "
 * @returns {import("./src/scaffold").SkeletonEntry[] | undefined} what was created, undefined on failure
 */
function applyPlan(plan, refresh, wording) {
  try {
    const { created } = scaffold.createSkeleton(plan);
    refresh();
    vscode.window.showInformationMessage(
      `Playbook Runner: created ${created.length} ${created.length === 1 ? "entry" : "entries"} ${wording.done}`,
    );
    return created;
  } catch (err) {
    vscode.window.showErrorMessage(`Playbook Runner: could not ${wording.failed}: ${messageOf(err)}`);
    return undefined;
  }
}

/**
 * The entries a plan still has to create, one per line, for a confirmation.
 *
 * @param {{ entries: import("./src/scaffold").SkeletonEntry[] }} plan
 * @returns {string}
 */
function describeMissing(plan) {
  return plan.entries
    .filter((entry) => !entry.exists)
    .map((entry) => (entry.type === "directory" ? `${entry.relative}/` : entry.relative))
    .join("\n");
}

/**
 * The environments of the plan whose inventory has no hosts under the
 * plan's service. YAML
 * inventories and unreadable files are skipped: the check is a line scan of
 * an INI file and says nothing about them.
 *
 * @param {string} root
 * @param {import("./src/defaults").Settings} settings
 * @param {import("./src/scaffold").SkeletonPlan} plan  only its environments are looked at
 * @returns {string[]}
 */
function environmentsWithoutGroup(root, settings, plan) {
  /** @type {string[]} */
  const names = [];
  for (const environment of findEnvironments(root, settings)) {
    if (!plan.environments.includes(environment.name) || scaffold.isYamlInventory(environment.inventory)) {
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(environment.inventory, "utf8");
    } catch {
      continue;
    }
    if (!scaffold.groupHasHosts(text, plan.name)) {
      names.push(environment.name);
    }
  }
  return names;
}

/**
 * Open the starter playbook of a plan, when this run created it.
 *
 * @param {import("./src/scaffold").SkeletonPlan} plan
 * @param {string} root workspace folder path
 * @param {import("./src/defaults").Settings} settings
 * @param {import("./src/scaffold").SkeletonEntry[]} created
 */
async function openStarter(plan, root, settings, created) {
  const starterPath = path.join(root, settings.playbooksDir, plan.name, `${plan.name}.yml`);
  const starter = created.find((entry) => entry.type === "file" && entry.path === starterPath);
  if (starter) {
    await vscode.window.showTextDocument(vscode.Uri.file(starter.path));
  }
}

/**
 * Set up an empty workspace folder for Ansible: a first environment whose
 * inventory puts localhost in the service's group, an empty roles directory
 * and one service with a starter playbook -- so there is something to press
 * play on. Refused when the folder already has environments.
 *
 * @param {unknown} argument
 * @param {() => void} refresh
 */
async function getStarted(argument, refresh) {
  const node = asCommandNode(argument);
  const folder = node.folder || (await pickers.pickFolder());
  if (!folder) {
    return;
  }
  const settings = readSettings(folder);
  const root = folder.uri.fsPath;

  if (findEnvironments(root, settings).length) {
    vscode.window.showInformationMessage(
      `Playbook Runner: ${folder.name} already has environments \u2014 use New service\u2026 or New environment\u2026`,
    );
    return;
  }

  const environment = await pickers.pickEnvironmentName({
    title: "Get started: first environment",
    prompt: `Directory name under ${settings.inventoriesDir}/`,
    taken: [],
  });
  if (!environment) {
    return;
  }
  const service = await pickers.pickServiceName(scaffold.existingServiceNames(root, settings), {
    title: "Get started: first service",
    prompt: `Directory name, used for ${settings.playbooksDir}/<name>/ and as the group in ${environment}'s inventory`,
  });
  if (!service) {
    return;
  }

  /** @type {import("./src/scaffold").SkeletonPlan} */
  let plan;
  try {
    plan = scaffold.planWorkspace(root, { environment, service }, settings);
  } catch (err) {
    vscode.window.showErrorMessage(`Playbook Runner: ${messageOf(err)}`);
    return;
  }

  const detail = describeMissing(plan);
  const starterExists = plan.entries.some(
    (entry) => entry.type === "file" && entry.exists && entry.path === path.join(root, settings.playbooksDir, service, `${service}.yml`),
  );
  const outcome = starterExists
    ? `${service}.yml already exists and is not the starter playbook \u2014 the inventory puts localhost in the ${service} group, so it will run against this machine.`
    : `The inventory puts localhost in the ${service} group, so \u25b6 on ${service}.yml runs on this machine.`;
  const answer = await vscode.window.showInformationMessage(
    `Set up ${folder.name} for Ansible?`,
    {
      modal: true,
      detail: `${detail}\n\n${outcome}`,
    },
    "Create",
  );
  if (answer !== "Create") {
    return;
  }

  const created = applyPlan(plan, refresh, { done: `in ${folder.name}.`, failed: `set up ${folder.name}` });
  if (created) {
    await openStarter(plan, root, settings, created);
  }
}

/**
 * Lay out a new environment: inventories/<name>/ with an inventory file and
 * group_vars/. Modelled on an existing environment it also gets that one's
 * groups -- the names in the inventory, a group_vars/<group>/ with an empty
 * env file each -- and never its hosts, its values or its vaults.
 *
 * @param {unknown} argument
 * @param {() => void} refresh
 */
async function createEnvironmentSkeleton(argument, refresh) {
  const node = asCommandNode(argument);
  const folder = node.folder || (await pickers.pickFolder());
  if (!folder) {
    return;
  }
  const settings = readSettings(folder);
  const root = folder.uri.fsPath;
  const existing = findEnvironments(root, settings);

  const name = await pickers.pickEnvironmentName({
    title: "New environment skeleton",
    prompt: `Directory name under ${settings.inventoriesDir}/`,
    taken: existing.map((item) => item.name),
  });
  if (!name) {
    return;
  }
  const source = await pickers.pickEnvironmentSource(existing);
  if (!source) {
    return;
  }

  /** @type {import("./src/environments").EnvironmentPlan} */
  let plan;
  try {
    plan = environments.planEnvironment(root, name, settings, source);
  } catch (err) {
    vscode.window.showErrorMessage(`Playbook Runner: ${messageOf(err)}`);
    return;
  }

  const detail = describeMissing(plan);
  const notes = [];
  if (plan.from) {
    notes.push(
      plan.groupsCopied
        ? `${settings.inventoryFile} gets the group names of ${plan.from} and no hosts; the env files are empty and no vault is copied.`
        : `${settings.inventoryFile} starts empty (the groups of ${plan.from} could not be read from its inventory); the env files are empty and no vault is copied.`,
    );
  }
  if (isProductionName(settings, plan.name)) {
    notes.push(`${plan.name} matches playbookRunner.productionPattern: runs against it will ask for confirmation.`);
  }
  const note = notes.map((line) => `\n\n${line}`).join("");
  const answer = await vscode.window.showInformationMessage(
    `Create the environment ${plan.name}?`,
    { modal: true, detail: `${detail}${note}` },
    "Create",
  );
  if (answer !== "Create") {
    return;
  }

  applyPlan(plan, refresh, {
    done: `for ${plan.name}. Add its hosts to ${settings.inventoryFile}, then create its vaults.`,
    failed: `create the environment ${plan.name}`,
  });
}

/**
 * Every level a setting is set at, with the environment renamed where it is
 * mentioned. vaultPasswordFiles is keyed by environment and
 * serviceEnvironments lists them; left alone, both would keep pointing at a
 * name that no longer exists.
 *
 * @param {vscode.WorkspaceFolder} folder
 * @param {string} from
 * @param {string} to
 * @returns {Promise<string[]>} the settings that were updated
 */
async function renameEnvironmentInSettings(folder, from, to) {
  const config = vscode.workspace.getConfiguration("playbookRunner", folder.uri);
  /** @type {string[]} */
  const updated = [];
  for (const key of ["vaultPasswordFiles", "serviceEnvironments"]) {
    const inspected = config.inspect(key);
    if (!inspected) {
      continue;
    }
    /** @type {[unknown, vscode.ConfigurationTarget][]} */
    const levels = [
      [inspected.globalValue, vscode.ConfigurationTarget.Global],
      [inspected.workspaceValue, vscode.ConfigurationTarget.Workspace],
      [inspected.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
    ];
    for (const [value, target] of levels) {
      const renamed = environments.renameInSetting(value, from, to);
      if (renamed !== undefined) {
        await config.update(key, renamed, target);
        if (!updated.includes(key)) {
          updated.push(key);
        }
      }
    }
  }
  return updated;
}

/**
 * Rename an environment: move its directory, then let everything that knows
 * it by name follow -- the two settings that name environments, the run
 * history and the last run.
 *
 * @param {vscode.ExtensionContext} context
 * @param {RunTracker} tracker
 * @param {unknown} argument
 * @param {() => void} refresh
 */
async function renameEnvironmentCommand(context, tracker, argument, refresh) {
  const resolved = await resolveContext(asCommandNode(argument));
  if (!resolved) {
    return;
  }
  const { folder, settings, environment } = resolved;
  const root = folder.uri.fsPath;
  if (tracker.isRunning(root, environment.name)) {
    vscode.window.showWarningMessage(
      `Playbook Runner: a playbook is running against ${environment.name}; rename it when the run has finished.`,
    );
    return;
  }

  const name = await pickers.pickEnvironmentName({
    title: `Rename environment ${environment.name}`,
    prompt: `New directory name under ${settings.inventoriesDir}/`,
    value: environment.name,
    taken: findEnvironments(root, settings).map((item) => item.name),
  });
  if (!name) {
    return;
  }

  /** @type {import("./src/environments").RenamePlan} */
  let plan;
  try {
    plan = environments.planRename(root, environment.name, name, settings);
  } catch (err) {
    vscode.window.showErrorMessage(`Playbook Runner: ${messageOf(err)}`);
    return;
  }

  const detail = [
    `${plan.relativeFrom}/ → ${plan.relativeTo}/`,
    "Settings that name the environment, the run history and the last run follow the new name. Anything else that spells out the old path — scripts, docs, CI — does not.",
    ...plan.notes,
  ].join("\n\n");
  const answer = await vscode.window.showWarningMessage(
    `Rename the environment ${plan.from} to ${plan.to}?`,
    { modal: true, detail },
    "Rename",
  );
  if (answer !== "Rename") {
    return;
  }

  try {
    environments.renameEnvironment(plan);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Playbook Runner: could not rename ${plan.from}: ${messageOf(err)}`,
    );
    return;
  }

  // The directory has moved; what follows only keeps names in step, so a
  // failure here is reported and the rest still happens.
  /** @type {string[]} */
  let updated = [];
  try {
    updated = await renameEnvironmentInSettings(folder, plan.from, plan.to);
  } catch (err) {
    vscode.window.showWarningMessage(
      `Playbook Runner: ${plan.from} was renamed, but the settings naming it could not be updated: ${messageOf(err)}`,
    );
  }
  await tracker.renameEnvironment(root, plan.from, plan.to);
  const last = parseLastRun(context.workspaceState.get(LAST_RUN_KEY));
  if (last && last.folderPath === root && last.environmentName === plan.from) {
    await context.workspaceState.update(LAST_RUN_KEY, { ...last, environmentName: plan.to });
  }
  refresh();
  vscode.window.showInformationMessage(
    `Playbook Runner: renamed ${plan.from} to ${plan.to}${
      updated.length ? ` and updated ${updated.map((key) => `playbookRunner.${key}`).join(", ")}` : ""
    }.`,
  );
}

/**
 * Remove an environment, by moving its directory to the trash -- its vaults
 * go with it, and the trash is what makes a wrong click recoverable. Asked
 * twice: a dialog saying what goes, then the name typed out.
 *
 * @param {RunTracker} tracker
 * @param {unknown} argument
 * @param {() => void} refresh
 */
async function deleteEnvironmentCommand(tracker, argument, refresh) {
  const resolved = await resolveContext(asCommandNode(argument));
  if (!resolved) {
    return;
  }
  const { folder, settings, environment } = resolved;
  const root = folder.uri.fsPath;
  if (tracker.isRunning(root, environment.name)) {
    vscode.window.showWarningMessage(
      `Playbook Runner: a playbook is running against ${environment.name}; delete it when the run has finished.`,
    );
    return;
  }

  /** @type {import("./src/environments").DeletePlan} */
  let plan;
  try {
    plan = environments.planDelete(root, environment.name, settings);
  } catch (err) {
    vscode.window.showErrorMessage(`Playbook Runner: ${messageOf(err)}`);
    return;
  }
  if (plan.isLink) {
    vscode.window.showErrorMessage(
      `Playbook Runner: ${plan.relative} is a symbolic link; remove it by hand, so it is clear whether the link or what it points at should go.`,
    );
    return;
  }

  const detail = [
    `${plan.relative}/ is moved to the trash: ${plan.files} file${plan.files === 1 ? "" : "s"}, ${
      plan.vaults
        ? `${plan.vaults} vault${plan.vaults === 1 ? "" : "s"} among them`
        : "no vault among them"
    }.`,
    "Playbooks and roles are not touched. Changes in it that are not committed exist only in the trash afterwards.",
    plan.isProduction ? `${plan.name} is treated as production.` : "",
    plan.isLast ? "It is the only environment: nothing can be run until there is another." : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const answer = await vscode.window.showWarningMessage(
    `Delete the environment ${plan.name}?`,
    { modal: true, detail },
    "Delete…",
  );
  if (answer !== "Delete…" || !(await pickers.confirmByName(plan.name))) {
    return;
  }

  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(plan.dir), { recursive: true, useTrash: true });
    refresh();
    vscode.window.showInformationMessage(`Playbook Runner: moved ${plan.relative} to the trash.`);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Playbook Runner: could not move ${plan.relative} to the trash, and nothing was deleted: ${messageOf(err)}`,
    );
  }
}

/**
 * The file watchers that keep the dashboard current.
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

/**
 * The status bar item: the newest run, click to run it again.
 */
class LastRunStatus {
  /** @param {RunTracker} tracker */
  constructor(tracker) {
    this.tracker = tracker;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    this.item.command = "playbookRunner.rerunLast";
    this.item.name = "Playbook Runner: last run";
    // The "3 min ago" goes stale on its own; a minute is as fine as it gets.
    this.timer = setInterval(() => this.update(), 60_000);
    this.update();
  }

  update() {
    const [latest] = this.tracker.history;
    if (!latest) {
      this.item.hide();
      return;
    }
    const icon = {
      running: "$(loading~spin)",
      passed: "$(pass)",
      failed: "$(error)",
      cancelled: "$(circle-slash)",
      unknown: "$(question)",
    }[latest.status];
    this.item.text = `${icon} ${latest.environment} · ${latest.label}${
      latest.status === "running" ? "" : ` · ${relativeTime(latest.endedAt ?? latest.startedAt, Date.now())}`
    }`;
    this.item.tooltip = `${describeRun(latest.label, latest.options)} against ${latest.environment}: ${
      latest.message || latest.status
    } — click to run it again`;
    this.item.backgroundColor =
      latest.status === "failed" ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
    this.item.show();
  }

  dispose() {
    clearInterval(this.timer);
    this.item.dispose();
  }
}

/**
 * The way in, now that there is no sidebar: an always-visible status bar item
 * that opens the dashboard and counts the playbooks running.
 */
class DashboardLauncher {
  /** @param {RunTracker} tracker */
  constructor(tracker) {
    this.tracker = tracker;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 11);
    this.item.command = "playbookRunner.openDashboard";
    this.item.name = "Playbook Runner";
    this.item.tooltip = "Open the Playbook Runner dashboard";
    this.update();
    this.item.show();
  }

  update() {
    const running = this.tracker.history.filter((entry) => entry.status === "running").length;
    this.item.text = running ? `$(run-all) Playbook Runner · ${running} running` : "$(run-all) Playbook Runner";
  }

  dispose() {
    this.item.dispose();
  }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const tracker = new RunTracker(context);
  const status = new LastRunStatus(tracker);
  const launcher = new DashboardLauncher(tracker);
  const refresh = () => DashboardPanel.refresh();
  /** @type {import("./src/dashboard").DashboardDeps} */
  const dashboardDeps = {
    tracker,
    startRun: (run) => startPlaybookRun(context, tracker, run),
    actions: {
      vault: (node, action) => vaultCommand(node, action),
      rekey: (node) => rekeyVaultsCommand(node),
      createService: (node) => createServiceSkeleton(node, refresh),
      getStarted: (node) => getStarted(node, refresh),
      createEnvironment: (node) => createEnvironmentSkeleton(node, refresh),
      renameEnvironment: (node) => renameEnvironmentCommand(context, tracker, node, refresh),
      deleteEnvironment: (node) => deleteEnvironmentCommand(tracker, node, refresh),
      rerunLast: () => rerunLast(context, tracker),
    },
  };
  const watchers = new Watchers(refresh);

  const onHistory = tracker.onDidChange(() => {
    status.update();
    launcher.update();
    DashboardPanel.refresh();
  });

  /**
   * @param {string} id
   * @param {(...args: any[]) => any} handler
   */
  const register = (id, handler) => vscode.commands.registerCommand(id, handler);

  context.subscriptions.push(
    watchers,
    tracker,
    status,
    launcher,
    onHistory,

    register("playbookRunner.runPlaybook", (node) =>
      runPlaybookCommand(context, tracker, node, false),
    ),
    register("playbookRunner.runPlaybookWithOptions", (node) =>
      runPlaybookCommand(context, tracker, node, true),
    ),
    register("playbookRunner.rerunLast", () => rerunLast(context, tracker)),
    register("playbookRunner.openDashboard", () => DashboardPanel.show(context, dashboardDeps)),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => DashboardPanel.revive(panel, context, dashboardDeps),
    }),
    register("playbookRunner.editVault", (node) => vaultCommand(node, "edit")),
    register("playbookRunner.createVault", (node) => vaultCommand(node, "create")),
    register("playbookRunner.rekeyVaults", (node) => rekeyVaultsCommand(node)),
    register("playbookRunner.createService", (node) => createServiceSkeleton(node, refresh)),
    register("playbookRunner.getStarted", (node) => getStarted(node, refresh)),
    register("playbookRunner.createEnvironment", (node) => createEnvironmentSkeleton(node, refresh)),
    register("playbookRunner.renameEnvironment", (node) =>
      renameEnvironmentCommand(context, tracker, node, refresh),
    ),
    register("playbookRunner.deleteEnvironment", (node) => deleteEnvironmentCommand(tracker, node, refresh)),

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
