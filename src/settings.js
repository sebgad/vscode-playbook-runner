/**
 * Reading the homelab.* settings.
 *
 * Everything here is the `vscode` side: getting values out of the workspace
 * configuration and telling the user when one of them is unusable. The path
 * and pattern logic those values feed lives in ./paths.js.
 */

"use strict";

const vscode = require("vscode");

const DEFAULTS = require("./defaults");
const paths = require("./paths");

const SECTION = "homelab";
const LEGACY_SECTION = "homelabTasks";

/**
 * True when a setting was written by the user somewhere, rather than just
 * carrying its contributed default.
 *
 * @param {{ globalValue?: unknown, workspaceValue?: unknown, workspaceFolderValue?: unknown } | undefined} inspected
 */
function hasExplicitValue(inspected) {
  return Boolean(
    inspected &&
      (inspected.globalValue !== undefined ||
        inspected.workspaceValue !== undefined ||
        inspected.workspaceFolderValue !== undefined),
  );
}

/**
 * Whether a configured value can stand in for the default. VS Code validates
 * against the contributed schema, but settings.json is a text file a user edits
 * by hand and these values become command line arguments, so the type is
 * checked here rather than assumed.
 *
 * @param {unknown} value
 * @param {unknown} fallback
 */
function matchesShape(value, fallback) {
  if (value === undefined || value === null) {
    return false;
  }
  return (
    typeof value === typeof fallback && Array.isArray(value) === Array.isArray(fallback)
  );
}

/**
 * @param {vscode.WorkspaceFolder} [folder]
 * @returns {import("./defaults").Settings}
 */
function readSettings(folder) {
  const scope = folder ? folder.uri : undefined;
  const config = vscode.workspace.getConfiguration(SECTION, scope);

  /** @type {Record<string, unknown>} */
  const settings = { ...DEFAULTS };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = config.get(key);
    settings[key] = matchesShape(value, fallback) ? value : fallback;
  }

  // homelabTasks.productionPattern was the 0.1 name. Honour it as long as the
  // new setting has not been given a value of its own.
  const legacy = vscode.workspace
    .getConfiguration(LEGACY_SECTION, scope)
    .inspect("productionPattern");
  if (!hasExplicitValue(config.inspect("productionPattern")) && hasExplicitValue(legacy)) {
    const value = legacy?.workspaceFolderValue ?? legacy?.workspaceValue ?? legacy?.globalValue;
    if (typeof value === "string") {
      settings.productionPattern = value;
    }
  }

  return /** @type {import("./defaults").Settings} */ (settings);
}

/**
 * The regular expression that decides what counts as production, or null when
 * the grouping is switched off or the pattern does not compile. A broken
 * pattern is worth a warning: it means nothing is treated as production, and
 * that is the direction that runs without asking.
 *
 * @param {import("./defaults").Settings} settings
 * @returns {RegExp | null}
 */
function productionPattern(settings) {
  const { pattern, error } = paths.compileProductionPattern(settings.productionPattern);
  if (error) {
    vscode.window.showWarningMessage(
      `Ansible Runner: homelab.productionPattern is not a valid regular expression (${error}). No environment will be treated as production.`,
    );
  }
  return pattern;
}

module.exports = {
  DEFAULTS,
  expandPath: paths.expandPath,
  productionPattern,
  readSettings,
  resolveVaultPasswordFile: paths.resolveVaultPasswordFile,
};
