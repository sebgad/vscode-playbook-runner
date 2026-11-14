/**
 * What the dashboard's Settings tab may write, and where.
 *
 * The page edits values; this module decides whether a value may be saved.
 * Every value goes through validateSettingValue in the extension before it
 * reaches WorkspaceConfiguration.update -- the page's own checks are display
 * only -- and every target through settingTarget, which keeps the settings
 * that name something to execute out of a repository's settings file. Like
 * the other modules that decide things, this one imports `vscode` nowhere.
 */

"use strict";

const DEFAULTS = require("./defaults");
const { compileProductionPattern } = require("./paths");

/**
 * Settings that name an executable or a password file ansible may execute.
 * `"scope": "machine"` in package.json, so VS Code reads them from User
 * settings only; test/settingsEdit.test.js keeps the two lists equal.
 */
const MACHINE_SETTINGS = [
  "vaultPasswordFilePattern",
  "vaultPasswordFiles",
  "ansiblePlaybookCommand",
  "ansibleVaultCommand",
];

/** How the Settings tab groups them, in order. */
const SETTING_GROUPS = [
  {
    title: "Repository layout",
    keys: [
      "playbooksDir",
      "rolesDir",
      "inventoriesDir",
      "inventoryFile",
      "groupVarsDir",
      "envFileName",
      "vaultFileName",
    ],
  },
  {
    title: "Running",
    keys: ["ansiblePlaybookCommand", "productionPattern", "confirmProduction", "setupTags"],
  },
  {
    title: "Vaults",
    keys: ["ansibleVaultCommand", "vaultPasswordFilePattern", "vaultPasswordFiles"],
  },
  {
    title: "Services",
    keys: ["serviceEnvironments"],
  },
];

/** Strings that may be empty: an empty production pattern turns the treatment off. */
const MAY_BE_EMPTY = new Set(["productionPattern", "vaultPasswordFilePattern"]);

/**
 * @typedef {{ ok: true, value: unknown } | { ok: false, error: string }} Validated
 */

/**
 * Whether `value` may be saved as playbookRunner.<key>, and in what cleaned-up
 * form. The runtime type must match the default's -- the same rule
 * settings.js applies when reading -- so a value saved here is one the
 * extension will actually use.
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {Validated}
 */
function validateSettingValue(key, value) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
    return { ok: false, error: `"${key}" is not a Playbook Runner setting` };
  }
  const fallback = /** @type {Record<string, unknown>} */ (DEFAULTS)[key];

  if (typeof fallback === "boolean") {
    return typeof value === "boolean" ? { ok: true, value } : { ok: false, error: "must be true or false" };
  }

  if (typeof fallback === "string") {
    if (typeof value !== "string") {
      return { ok: false, error: "must be text" };
    }
    const text = value.trim();
    if (!text && !MAY_BE_EMPTY.has(key)) {
      return { ok: false, error: "must not be empty" };
    }
    if (key === "productionPattern") {
      const { error } = compileProductionPattern(text);
      if (error) {
        return { ok: false, error: `not a valid regular expression: ${error}` };
      }
    }
    return { ok: true, value: text };
  }

  if (Array.isArray(fallback)) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      return { ok: false, error: "must be a list of text entries" };
    }
    const items = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
    return { ok: true, value: items };
  }

  // The one object setting: environment name -> password file.
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "must be a map of environment names to paths" };
  }
  /** @type {Record<string, string>} */
  const map = {};
  for (const [name, path] of Object.entries(value)) {
    const environment = name.trim();
    if (!environment) {
      return { ok: false, error: "an environment name is empty" };
    }
    if (typeof path !== "string" || !path.trim()) {
      return { ok: false, error: `the path for "${environment}" is empty` };
    }
    map[environment] = path.trim();
  }
  return { ok: true, value: map };
}

/**
 * Where a setting is saved: a machine setting always in User settings,
 * whatever the page asked for.
 *
 * @param {string} key
 * @param {"workspace" | "user"} requested
 * @returns {"workspace" | "user"}
 */
function settingTarget(key, requested) {
  return MACHINE_SETTINGS.includes(key) ? "user" : requested;
}

module.exports = { MACHINE_SETTINGS, SETTING_GROUPS, settingTarget, validateSettingValue };
