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

const path = require("path");

const {
  buildPlaybookArgs,
  buildPlaybookEnv,
  playbookLabel,
  sanitizeRunOptions,
  validateTaskRange,
} = require("./command");
const { findEnvironments, findServices } = require("./discovery");
const { latestFor } = require("./history");
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
 * @property {string | null} envFile
 */

/**
 * @typedef {object} ModelEnvironment
 * @property {string} name
 * @property {string} inventory
 * @property {boolean} isProduction
 * @property {ModelService[]} services
 */

/**
 * @typedef {object} ModelFolder
 * @property {string} name
 * @property {string} path
 * @property {ModelEnvironment[]} environments
 */

/**
 * @typedef {object} DashboardModel
 * @property {ModelFolder[]} folders
 */

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
        environments: findEnvironments(folder.path, settings).map((environment) => ({
          name: environment.name,
          inventory: environment.inventory,
          isProduction: isProductionName(settings, environment.name),
          services: findServices(folder.path, environment, settings).map((service) => ({
            name: service.name,
            playbooks: service.playbooks.map((playbook) => ({
              file: playbook.file,
              name: playbook.name,
              label: playbookLabel(folder.path, settings, playbook.file),
              latest: latestFor(history, folder.path, environment.name, playbook.file),
            })),
            hasEnv: Boolean(service.vars && service.vars.hasEnv),
            hasVault: Boolean(service.vars && service.vars.hasVault),
            envFile: service.vars && service.vars.hasEnv ? service.vars.envFile : null,
          })),
        })),
      };
    }),
  };
}

/**
 * @typedef {{ type: "ready" }
 *   | { type: "outline", folder: string, playbook: string }
 *   | { type: "preview" | "run", folder: string, environment: string, playbook: string, options: import("./command").RunOptions }
 *   | { type: "open", folder: string, playbook: string, file: string, line: number }} WebviewMessage
 */

/**
 * @param {Record<string, unknown>} raw
 * @param {string[]} keys
 * @returns {boolean}
 */
function allStrings(raw, keys) {
  return keys.every((key) => typeof raw[key] === "string");
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
 * @param {{ root: string, environment: { name: string, inventory: string }, playbookFile: string, settings: import("./defaults").Settings, options: import("./command").RunOptions, outline: import("./tags").PlaybookOutline, pluginDir: string }} spec
 * @returns {{ argv: string[], env: Record<string, string>, error: string | null }}
 */
function buildPreview(spec) {
  return {
    argv: playbookArgv(spec.root, spec.settings, spec.environment, spec.playbookFile, spec.options),
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
  resolveOpenRequest,
  resolveRunRequest,
};
