/**
 * Turning settings into concrete paths and patterns.
 *
 * Split out of settings.js for the same reason command.js was split out of
 * runner.js: no `vscode` import, so the rules that decide which file ansible is
 * handed as a password -- and what counts as production -- are exercised by the
 * plain-node tests in test/paths.test.js.
 */

"use strict";

const os = require("os");
const path = require("path");

const { isFile } = require("./discovery");

/**
 * Expand the variables allowed in path settings.
 *
 * @param {string} template
 * @param {{ env?: string, folderPath?: string }} [vars]
 * @returns {string}
 */
function expandPath(template, vars = {}) {
  if (!template) {
    return "";
  }
  let out = template
    .replace(/\$\{userHome\}/g, os.homedir())
    .replace(/\$\{workspaceFolder\}/g, vars.folderPath || "")
    .replace(/\$\{env(?:ironment)?\}/g, vars.env || "");
  if (out === "~") {
    out = os.homedir();
  } else if (out.startsWith("~/")) {
    out = path.join(os.homedir(), out.slice(2));
  }
  return out;
}

/**
 * The --vault-password-file for an environment, or null to fall back to
 * --ask-vault-password. An explicit entry in playbookRunner.vaultPasswordFiles wins
 * over the pattern; either way a path that does not exist means "prompt",
 * which is what production does today.
 *
 * Both settings are `machine` scope in package.json, so only the user can say
 * which file this is: ansible *executes* a password file that happens to be
 * executable, which is not a decision a repository gets to make.
 *
 * @param {import("./defaults").Settings} settings
 * @param {string} environmentName
 * @param {string} folderPath
 * @returns {string | null}
 */
function resolveVaultPasswordFile(settings, environmentName, folderPath) {
  const explicit = settings.vaultPasswordFiles
    ? settings.vaultPasswordFiles[environmentName]
    : undefined;
  const template = typeof explicit === "string" && explicit ? explicit : settings.vaultPasswordFilePattern;
  if (!template) {
    return null;
  }

  const expanded = expandPath(template, { env: environmentName, folderPath });
  if (!expanded) {
    return null;
  }
  const resolved = path.resolve(folderPath, expanded);
  return isFile(resolved) ? resolved : null;
}

/**
 * Compile playbookRunner.productionPattern. An empty setting switches the whole
 * production treatment off; a pattern that does not compile is reported rather
 * than silently ignored, because "no match" here means "no confirmation".
 *
 * @param {string} raw
 * @returns {{ pattern: RegExp | null, error: string | null }}
 */
function compileProductionPattern(raw) {
  if (!raw) {
    return { pattern: null, error: null };
  }
  try {
    return { pattern: new RegExp(raw, "i"), error: null };
  } catch (err) {
    return { pattern: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Whether an environment gets the production treatment: red icons and, unless
 * switched off, a confirmation before anything runs.
 *
 * @param {import("./defaults").Settings} settings
 * @param {string} environmentName
 * @returns {boolean}
 */
function isProductionName(settings, environmentName) {
  const { pattern } = compileProductionPattern(settings.productionPattern);
  return Boolean(pattern && pattern.test(environmentName));
}

module.exports = {
  compileProductionPattern,
  expandPath,
  isProductionName,
  resolveVaultPasswordFile,
};
