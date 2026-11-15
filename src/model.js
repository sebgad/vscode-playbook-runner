/**
 * The dashboard's data, and the checks on everything its webview sends back.
 *
 * The webview is a page that renders what it is given. Anything it posts --
 * a playbook to run, a file to open, run options -- is rebuilt here field by
 * field and then matched against what the model offered, so it can never
 * name a path or a flag the extension did not hand it first. Like the other
 * modules that decide things, this one imports `vscode` nowhere.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const {
  buildPlaybookArgs,
  buildPlaybookEnv,
  playbookLabel,
  sanitizeRunOptions,
  validateTaskRange,
} = require("./command");
const { findEnvironments, findInventoryCandidates, findServices } = require("./discovery");
const { STRUCTURED_INVENTORY } = require("./environments");
const { latestFor } = require("./history");
const { MANUAL_BEGIN, MANUAL_END, inventoryHash, parseInventory } = require("./inventory");
const { isProductionName, resolveVaultPasswordFile } = require("./paths");

/** What a preview shows for the status file, which only exists once a run starts. */
const STATUS_FILE_PLACEHOLDER = "<per-run status file>";

/**
 * @typedef {object} ModelPlaybook
 * @property {string} file
 * @property {string} name
 * @property {string} label
 * @property {import("./history").RunEntry | null} latest
 */

/**
 * @typedef {object} ModelService
 * @property {string} name
 * @property {ModelPlaybook[]} playbooks
 * @property {boolean} hasEnv
 * @property {boolean} hasVault
 * @property {string | null} vaultFile  where its vault is or would be; null without group_vars
 * @property {string | null} envFile
 */

/**
 * What the Inventory tab renders for one environment. When it is not
 * editable (structured format, unreadable, unparsable) the lists are empty and
 * `reason` says why. `preview` is the first line of a manual block that is
 * neither a marker nor blank; `unlisted` the playbook-folder services that
 * are no group in the inventory.
 *
 * @typedef {object} ModelInventory
 * @property {boolean} editable
 * @property {string | null} reason
 * @property {string} hash
 * @property {import("./inventory").ServerGroup[]} serverGroups
 * @property {import("./inventory").Service[]} services
 * @property {string[]} manualGroups
 * @property {{ line: number, preview: string }[]} manual
 * @property {string[]} warnings
 * @property {string[]} unlisted
 */

/**
 * @typedef {object} ModelEnvironment
 * @property {string} name
 * @property {string} inventoryFile  path of the inventory file (was `inventory` before the tab)
 * @property {boolean} isProduction
 * @property {ModelService[]} services
 * @property {ModelInventory} inventory
 */

/**
 * @typedef {object} ModelFolder
 * @property {string} name
 * @property {string} path
 * @property {ModelEnvironment[]} environments
 * @property {{ name: string, dir: string }[]} candidates  directories that could get an inventory
 */

/**
 * @typedef {object} DashboardModel
 * @property {ModelFolder[]} folders
 */

/**
 * @param {string} text
 * @returns {string}
 */
function manualPreview(text) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && trimmed !== MANUAL_BEGIN && trimmed !== MANUAL_END) {
      return trimmed;
    }
  }
  return "";
}

/**
 * @param {string} reason
 * @param {string} hash
 * @returns {ModelInventory}
 */
function lockedInventory(reason, hash) {
  return {
    editable: false,
    reason,
    hash,
    serverGroups: [],
    services: [],
    manualGroups: [],
    manual: [],
    warnings: [],
    unlisted: [],
  };
}

/**
 * @param {string} file
 * @param {string[]} playbookServices names of the playbook-folder services
 * @returns {ModelInventory}
 */
function buildInventoryModel(file, playbookServices) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return lockedInventory(error instanceof Error ? error.message : String(error), "");
  }
  const hash = inventoryHash(text);
  if (STRUCTURED_INVENTORY.has(path.extname(file).toLowerCase())) {
    return lockedInventory(
      `${path.basename(file)} is a structured inventory; only INI inventories can be edited here.`,
      hash,
    );
  }
  const parsed = parseInventory(text);
  if (parsed.error) {
    return lockedInventory(parsed.error, hash);
  }
  const known = new Set([
    ...parsed.serverGroups.map((group) => group.name),
    ...parsed.services.map((service) => service.name),
    ...parsed.manualGroups,
  ]);
  return {
    editable: true,
    reason: null,
    hash,
    serverGroups: parsed.serverGroups,
    services: parsed.services,
    manualGroups: parsed.manualGroups,
    manual: parsed.manual.map((block) => ({ line: block.line, preview: manualPreview(block.text) })),
    warnings: parsed.warnings,
    unlisted: playbookServices.filter((name) => !known.has(name)),
  };
}

/**
 * @param {{ name: string, path: string }[]} folders
 * @param {(folder: { name: string, path: string }) => import("./defaults").Settings} readSettingsFor
 * @param {import("./history").RunEntry[]} history
 * @returns {DashboardModel}
 */
function buildDashboardModel(folders, readSettingsFor, history) {
  return {
    folders: folders.map((folder) => {
      const settings = readSettingsFor(folder);
      return {
        name: folder.name,
        path: folder.path,
        candidates: findInventoryCandidates(folder.path, settings),
        environments: findEnvironments(folder.path, settings).map((environment) => {
          const services = findServices(folder.path, environment, settings);
          return {
          name: environment.name,
          inventoryFile: environment.inventory,
          inventory: buildInventoryModel(
            environment.inventory,
            services.map((service) => service.name),
          ),
          isProduction: isProductionName(settings, environment.name),
          services: services.map((service) => ({
            name: service.name,
            playbooks: service.playbooks.map((playbook) => ({
              file: playbook.file,
              name: playbook.name,
              label: playbookLabel(folder.path, settings, playbook.file),
              latest: latestFor(history, folder.path, environment.name, playbook.file),
            })),
            hasEnv: Boolean(service.vars && service.vars.hasEnv),
            hasVault: Boolean(service.vars && service.vars.hasVault),
            vaultFile: service.vars ? service.vars.vaultFile : null,
            envFile: service.vars && service.vars.hasEnv ? service.vars.envFile : null,
          })),
          };
        }),
      };
    }),
  };
}

/**
 * @typedef {{ type: "ready" }
 *   | { type: "outline", folder: string, playbook: string }
 *   | { type: "preview" | "run", folder: string, environment: string, playbook: string, options: import("./command").RunOptions }
 *   | { type: "open", folder: string, playbook: string, file: string, line: number }
 *   | { type: "vault", folder: string, environment: string, service: string, action: "edit" | "create" }
 *   | { type: "rekey", folder: string, environment: string }
 *   | { type: "createService", folder: string }
 *   | { type: "getStarted", folder: string }
 *   | { type: "createEnvironment", folder: string }
 *   | { type: "renameEnvironment" | "deleteEnvironment", folder: string, environment: string }
 *   | { type: "saveInventory", folder: string, environment: string, hash: string, serverGroups: import("./inventory").ServerGroup[], services: import("./inventory").Service[] }
 *   | { type: "createInventory", folder: string, candidate: string }
 *   | { type: "openInventory", folder: string, environment: string, line: number }
 *   | { type: "renameGroup" | "deleteGroup", folder: string, environment: string, hash: string, group: string }
 *   | { type: "rerunLast" }
 *   | { type: "openSettings" }
 *   | { type: "setSetting", key: string, value: unknown, target: "workspace" | "user" }
 *   | { type: "resetSetting", key: string, target: "workspace" | "user" }
 *   | { type: "moveSetting", key: string }} WebviewMessage
 */

/**
 * @param {Record<string, unknown>} raw
 * @param {string[]} keys
 * @returns {boolean}
 */
function allStrings(raw, keys) {
  return keys.every((key) => typeof raw[key] === "string");
}

const MAX_GROUPS = 500;
const MAX_HOSTS = 500;
const MAX_VARS = 200;
const MAX_STRING = 4096;

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function boundedString(value) {
  return typeof value === "string" && value.length <= MAX_STRING ? value : null;
}

/**
 * @param {unknown} value
 * @returns {import("./inventory").Var[] | null}
 */
function parseVars(value) {
  if (!Array.isArray(value) || value.length > MAX_VARS) {
    return null;
  }
  /** @type {import("./inventory").Var[]} */
  const vars = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) {
      return null;
    }
    const key = boundedString(item[0]);
    const val = boundedString(item[1]);
    if (key === null || val === null) {
      return null;
    }
    vars.push([key, val]);
  }
  return vars;
}

/**
 * @param {unknown} value
 * @returns {import("./inventory").Host[] | null}
 */
function parseHosts(value) {
  if (!Array.isArray(value) || value.length > MAX_HOSTS) {
    return null;
  }
  /** @type {import("./inventory").Host[]} */
  const hosts = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return null;
    }
    const name = boundedString(/** @type {Record<string, unknown>} */ (item).name);
    const vars = parseVars(/** @type {Record<string, unknown>} */ (item).vars);
    if (name === null || !vars) {
      return null;
    }
    hosts.push({ name, vars });
  }
  return hosts;
}

/**
 * Rebuild the groups of a saveInventory message. `readOnly` is always false:
 * the extension takes read-only groups from the file, not from the page.
 *
 * @param {unknown} value
 * @param {boolean} withChildren
 * @returns {import("./inventory").Service[] | null}
 */
function parseGroups(value, withChildren) {
  if (!Array.isArray(value) || value.length > MAX_GROUPS) {
    return null;
  }
  /** @type {import("./inventory").Service[]} */
  const groups = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      return null;
    }
    const raw = /** @type {Record<string, unknown>} */ (item);
    const name = boundedString(raw.name);
    const hosts = parseHosts(raw.hosts);
    const vars = parseVars(raw.vars);
    /** @type {string[]} */
    const children = [];
    if (withChildren) {
      if (!Array.isArray(raw.children) || raw.children.length > MAX_GROUPS) {
        return null;
      }
      for (const child of raw.children) {
        const text = boundedString(child);
        if (text === null) {
          return null;
        }
        children.push(text);
      }
    }
    if (name === null || !hosts || !vars) {
      return null;
    }
    groups.push({ name, children, hosts, vars, readOnly: false });
  }
  return groups;
}

/**
 * A message from the webview, in its exact shape, or null.
 *
 * Run options go through sanitizeRunOptions and then lose `extraArgs`: the
 * dashboard has no way to type raw arguments, so a message carrying some did
 * not come from the dashboard as written.
 *
 * @param {unknown} value
 * @returns {WebviewMessage | null}
 */
function parseWebviewMessage(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = /** @type {Record<string, unknown>} */ (value);
  switch (raw.type) {
    case "ready":
      return { type: "ready" };
    case "rerunLast":
      return { type: "rerunLast" };
    case "openSettings":
      return { type: "openSettings" };
    case "moveSetting":
      return typeof raw.key === "string" ? { type: "moveSetting", key: raw.key } : null;
    case "setSetting":
    case "resetSetting": {
      // The value is validated against the setting's type later, in
      // settingsEdit.validateSettingValue; here only the envelope.
      if (typeof raw.key !== "string" || (raw.target !== "workspace" && raw.target !== "user")) {
        return null;
      }
      return raw.type === "setSetting"
        ? { type: "setSetting", key: raw.key, value: raw.value, target: raw.target }
        : { type: "resetSetting", key: raw.key, target: raw.target };
    }
    case "vault":
      return allStrings(raw, ["folder", "environment", "service"]) &&
        (raw.action === "edit" || raw.action === "create")
        ? {
            type: "vault",
            folder: String(raw.folder),
            environment: String(raw.environment),
            service: String(raw.service),
            action: raw.action,
          }
        : null;
    case "rekey":
      return allStrings(raw, ["folder", "environment"])
        ? { type: "rekey", folder: String(raw.folder), environment: String(raw.environment) }
        : null;
    case "createService":
      return allStrings(raw, ["folder"]) ? { type: "createService", folder: String(raw.folder) } : null;
    case "getStarted":
      return allStrings(raw, ["folder"]) ? { type: "getStarted", folder: String(raw.folder) } : null;
    case "createEnvironment":
      return allStrings(raw, ["folder"]) ? { type: "createEnvironment", folder: String(raw.folder) } : null;
    case "renameEnvironment":
    case "deleteEnvironment":
      // Only which environment; the new name is asked for by the extension.
      return allStrings(raw, ["folder", "environment"])
        ? { type: raw.type, folder: String(raw.folder), environment: String(raw.environment) }
        : null;
    case "saveInventory": {
      if (!allStrings(raw, ["folder", "environment", "hash"])) {
        return null;
      }
      const serverGroups = parseGroups(raw.serverGroups, false);
      const services = parseGroups(raw.services, true);
      if (!serverGroups || !services) {
        return null;
      }
      return {
        type: "saveInventory",
        folder: String(raw.folder),
        environment: String(raw.environment),
        hash: String(raw.hash),
        serverGroups: serverGroups.map(({ name, hosts, vars, readOnly }) => ({ name, hosts, vars, readOnly })),
        services,
      };
    }
    case "createInventory":
      return allStrings(raw, ["folder", "candidate"])
        ? { type: "createInventory", folder: String(raw.folder), candidate: String(raw.candidate) }
        : null;
    case "openInventory": {
      const line = raw.line;
      if (!allStrings(raw, ["folder", "environment"]) || !Number.isInteger(line) || Number(line) < 1) {
        return null;
      }
      return {
        type: "openInventory",
        folder: String(raw.folder),
        environment: String(raw.environment),
        line: Number(line),
      };
    }
    case "renameGroup":
    case "deleteGroup":
      return allStrings(raw, ["folder", "environment", "hash", "group"])
        ? {
            type: raw.type,
            folder: String(raw.folder),
            environment: String(raw.environment),
            hash: String(raw.hash),
            group: String(raw.group),
          }
        : null;
    case "outline":
      return allStrings(raw, ["folder", "playbook"])
        ? { type: "outline", folder: String(raw.folder), playbook: String(raw.playbook) }
        : null;
    case "preview":
    case "run": {
      if (!allStrings(raw, ["folder", "environment", "playbook"])) {
        return null;
      }
      const options = sanitizeRunOptions(raw.options);
      delete options.extraArgs;
      return {
        type: raw.type,
        folder: String(raw.folder),
        environment: String(raw.environment),
        playbook: String(raw.playbook),
        options,
      };
    }
    case "open": {
      const line = raw.line;
      if (!allStrings(raw, ["folder", "playbook", "file"]) || !Number.isInteger(line) || Number(line) < 1) {
        return null;
      }
      return {
        type: "open",
        folder: String(raw.folder),
        playbook: String(raw.playbook),
        file: String(raw.file),
        line: Number(line),
      };
    }
    default:
      return null;
  }
}

/**
 * The folder, environment and playbook a preview or run message names --
 * matched by exact string against what the model offered, so `../` spellings
 * of a real path are refused along with paths it never offered.
 *
 * @param {DashboardModel} model
 * @param {WebviewMessage} message
 * @returns {{ folder: ModelFolder, environment: ModelEnvironment, playbook: ModelPlaybook } | null}
 */
function resolveRunRequest(model, message) {
  if (message.type !== "run" && message.type !== "preview") {
    return null;
  }
  const folder = model.folders.find((item) => item.path === message.folder);
  const environment = folder && folder.environments.find((item) => item.name === message.environment);
  if (!folder || !environment) {
    return null;
  }
  for (const service of environment.services) {
    const playbook = service.playbooks.find((item) => item.file === message.playbook);
    if (playbook) {
      return { folder, environment, playbook };
    }
  }
  return null;
}

/**
 * @param {ModelFolder} folder
 * @param {string} file
 * @returns {boolean}
 */
function offersPlaybook(folder, file) {
  return folder.environments.some((environment) =>
    environment.services.some((service) => service.playbooks.some((item) => item.file === file)),
  );
}

/**
 * @param {DashboardModel} model
 * @param {string} folderPath
 * @returns {ModelFolder | null}
 */
function resolveFolderRequest(model, folderPath) {
  return model.folders.find((item) => item.path === folderPath) ?? null;
}

/**
 * @param {DashboardModel} model
 * @param {string} folderPath
 * @param {string} environmentName
 * @returns {{ folder: ModelFolder, environment: ModelEnvironment } | null}
 */
function resolveEnvironmentRequest(model, folderPath, environmentName) {
  const folder = resolveFolderRequest(model, folderPath);
  const environment = folder && folder.environments.find((item) => item.name === environmentName);
  return folder && environment ? { folder, environment } : null;
}

/**
 * @param {DashboardModel} model
 * @param {string} folderPath
 * @param {string} candidateName
 * @returns {{ folder: ModelFolder, candidate: { name: string, dir: string } } | null}
 */
function resolveCandidateRequest(model, folderPath, candidateName) {
  const folder = resolveFolderRequest(model, folderPath);
  const candidate = folder && folder.candidates.find((item) => item.name === candidateName);
  return folder && candidate ? { folder, candidate } : null;
}

/**
 * The service a vault message names, when the action fits it: edit needs a
 * vault that exists, create one that does not -- ansible-vault create on an
 * existing file is refused by ansible, edit on a missing one opens nothing.
 * The vault file itself always comes from the model, never the message.
 *
 * @param {DashboardModel} model
 * @param {WebviewMessage} message
 * @returns {{ folder: ModelFolder, environment: ModelEnvironment, service: ModelService } | null}
 */
function resolveVaultRequest(model, message) {
  if (message.type !== "vault") {
    return null;
  }
  const found = resolveEnvironmentRequest(model, message.folder, message.environment);
  const service = found && found.environment.services.find((item) => item.name === message.service);
  if (!found || !service || !service.vaultFile) {
    return null;
  }
  if ((message.action === "edit") !== service.hasVault) {
    return null;
  }
  return { ...found, service };
}

/**
 * The folder holding a playbook the model offered, matched by exact path, or
 * null -- the check before reading a playbook's outline for the webview.
 *
 * @param {DashboardModel} model
 * @param {string} folderPath
 * @param {string} playbookFile
 * @returns {ModelFolder | null}
 */
function findOfferedPlaybook(model, folderPath, playbookFile) {
  const folder = model.folders.find((item) => item.path === folderPath);
  return folder && offersPlaybook(folder, playbookFile) ? folder : null;
}

/**
 * The file and line an open message may open, or null. Allowed are a playbook
 * the model offered, an env file it offered, and a file that playbook's own
 * outline reached (a role's task file). Never a vault: those open through
 * ansible-vault in a terminal, not in an editor tab.
 *
 * @param {DashboardModel} model
 * @param {WebviewMessage} message
 * @param {(folderPath: string, playbookFile: string) => import("./tags").PlaybookOutline} outlineFor
 * @returns {{ file: string, line: number } | null}
 */
function resolveOpenRequest(model, message, outlineFor) {
  if (message.type !== "open") {
    return null;
  }
  const folder = model.folders.find((item) => item.path === message.folder);
  if (!folder) {
    return null;
  }
  const result = { file: message.file, line: message.line };

  if (offersPlaybook(folder, message.file)) {
    return result;
  }
  const isEnvFile = folder.environments.some((environment) =>
    environment.services.some((service) => service.envFile === message.file),
  );
  if (isEnvFile) {
    return result;
  }
  if (message.playbook && offersPlaybook(folder, message.playbook)) {
    const outline = outlineFor(folder.path, message.playbook);
    const reached = outline.plays.some((play) => play.tasks.some((task) => task.file === message.file));
    if (reached) {
      return result;
    }
  }
  return null;
}

/**
 * The argument vector of one playbook run. runner.js runs exactly this and
 * the dashboard previews exactly this, so the two cannot drift apart.
 *
 * @param {string} root
 * @param {import("./defaults").Settings} settings
 * @param {{ name: string, inventory: string }} environment
 * @param {string} playbookFile
 * @param {import("./command").RunOptions} options
 * @returns {string[]}
 */
function playbookArgv(root, settings, environment, playbookFile, options) {
  return buildPlaybookArgs({
    inventory: path.relative(root, environment.inventory),
    playbook: path.relative(root, playbookFile),
    vaultPasswordFile: resolveVaultPasswordFile(settings, environment.name, root),
    options,
  });
}

/**
 * What the dashboard's command line shows: the argv and the env a run with
 * these options would get, and why the run would be refused, if it would.
 *
 * @param {{ root: string, environment: { name: string, inventoryFile: string }, playbookFile: string, settings: import("./defaults").Settings, options: import("./command").RunOptions, outline: import("./tags").PlaybookOutline, pluginDir: string }} spec
 * @returns {{ argv: string[], env: Record<string, string>, error: string | null }}
 */
function buildPreview(spec) {
  return {
    argv: playbookArgv(
      spec.root,
      spec.settings,
      { name: spec.environment.name, inventory: spec.environment.inventoryFile },
      spec.playbookFile, spec.options),
    env: buildPlaybookEnv({
      options: spec.options,
      setupTags: spec.settings.setupTags,
      pluginDir: spec.pluginDir,
      statusFile: STATUS_FILE_PLACEHOLDER,
    }),
    error: validateTaskRange(spec.outline, spec.options),
  };
}

module.exports = {
  STATUS_FILE_PLACEHOLDER,
  buildDashboardModel,
  buildPreview,
  findOfferedPlaybook,
  parseWebviewMessage,
  playbookArgv,
  resolveCandidateRequest,
  resolveEnvironmentRequest,
  resolveFolderRequest,
  resolveOpenRequest,
  resolveRunRequest,
  resolveVaultRequest,
};
