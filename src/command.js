/**
 * Building the ansible argument vectors.
 *
 * Split out of runner.js so it stays free of `vscode` and can be tested from
 * plain node -- these are the lines that decide what ansible actually gets run
 * with, so they are the ones worth asserting on.
 */

"use strict";

const path = require("path");

/**
 * @param {string | null} vaultPasswordFile
 * @returns {string[]}
 */
function vaultArgs(vaultPasswordFile) {
  return vaultPasswordFile
    ? ["--vault-password-file", vaultPasswordFile]
    : ["--ask-vault-password"];
}

/** The most -v ansible has a meaning for. */
const MAX_VERBOSITY = 4;

/**
 * 0 or unset means no flag; anything else becomes -v .. -vvvv.
 *
 * @param {unknown} level
 * @returns {string | null}
 */
function verbosityFlag(level) {
  const n = Number(level);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return `-${"v".repeat(Math.min(Math.floor(n), MAX_VERBOSITY))}`;
}

/**
 * @typedef {object} RunOptions
 * @property {string} [tags]
 * @property {string} [limit]
 * @property {boolean} [check]
 * @property {boolean} [diff]
 * @property {number} [verbosity]
 * @property {string[]} [extraArgs]
 */

/**
 * Keep only the options this module knows, in the shape it expects.
 *
 * The last run is remembered in workspace state, so what comes back after a
 * restart is JSON that VS Code stored for us rather than something we just
 * built -- and every field of it ends up in an ansible command line. Rebuilding
 * the object field by field is what keeps that honest.
 *
 * @param {unknown} value
 * @returns {RunOptions}
 */
function sanitizeRunOptions(value) {
  /** @type {RunOptions} */
  const options = {};
  if (!value || typeof value !== "object") {
    return options;
  }
  const raw = /** @type {Record<string, unknown>} */ (value);

  if (typeof raw.tags === "string" && raw.tags.trim()) {
    options.tags = raw.tags.trim();
  }
  if (typeof raw.limit === "string" && raw.limit.trim()) {
    options.limit = raw.limit.trim();
  }
  if (raw.check === true) {
    options.check = true;
  }
  if (raw.diff === true) {
    options.diff = true;
  }
  const verbosity = Number(raw.verbosity);
  if (Number.isFinite(verbosity) && verbosity > 0) {
    options.verbosity = Math.min(Math.floor(verbosity), MAX_VERBOSITY);
  }
  if (Array.isArray(raw.extraArgs)) {
    const extra = raw.extraArgs.filter((item) => typeof item === "string");
    if (extra.length) {
      options.extraArgs = extra;
    }
  }

  return options;
}

/**
 * The argument vector for one playbook run.
 *
 * @param {{ inventory: string, playbook: string, vaultPasswordFile?: string | null, options?: RunOptions }} spec
 * @returns {string[]}
 */
function buildPlaybookArgs(spec) {
  const options = spec.options || {};
  const args = [
    "-i",
    spec.inventory,
    spec.playbook,
    ...vaultArgs(spec.vaultPasswordFile || null),
  ];

  if (options.tags) {
    args.push("--tags", options.tags);
  }
  if (options.limit) {
    args.push("--limit", options.limit);
  }
  if (options.check) {
    args.push("--check");
  }
  if (options.diff) {
    args.push("--diff");
  }
  const verbose = verbosityFlag(options.verbosity);
  if (verbose) {
    args.push(verbose);
  }
  if (Array.isArray(options.extraArgs)) {
    args.push(...options.extraArgs);
  }

  return args;
}

/**
 * @param {{ vaultCommand: string, action: "edit" | "create", vaultFile: string, vaultPasswordFile?: string | null }} spec
 * @returns {string[]}
 */
function buildVaultArgv(spec) {
  return [
    spec.vaultCommand,
    spec.action,
    spec.vaultFile,
    ...vaultArgs(spec.vaultPasswordFile || null),
  ];
}

/**
 * Rotating the passphrase of every vault in one environment.
 *
 * The *new* passphrase is never an argument. Without --new-vault-password-file
 * ansible-vault prompts for it, and that is the point: a passphrase on a command
 * line is readable from the process table by anyone on the box for as long as
 * the command runs, and would end up in shell history besides.
 *
 * One invocation carrying every file rather than one per vault, so the old and
 * the new passphrase are each typed once instead of once per group.
 *
 * @param {{ vaultCommand: string, vaultFiles: string[], vaultPasswordFile?: string | null }} spec
 * @returns {string[]}
 */
function buildVaultRekeyArgv(spec) {
  return [
    spec.vaultCommand,
    "rekey",
    ...spec.vaultFiles,
    ...vaultArgs(spec.vaultPasswordFile || null),
  ];
}

/**
 * POSIX quoting, also correct in fish: 'it'\''s' concatenates there too.
 *
 * @param {string} value
 * @returns {string}
 */
function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text)
    ? text
    : `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * A short label for a playbook, e.g. "dns_servers/setup-bind9.yml".
 *
 * @param {string} root
 * @param {{ playbooksDir: string }} settings
 * @param {string} playbookFile
 * @returns {string}
 */
function playbookLabel(root, settings, playbookFile) {
  const base = path.join(root, settings.playbooksDir);
  const relative = path.relative(base, playbookFile);
  return relative.startsWith("..") ? path.relative(root, playbookFile) : relative;
}

module.exports = {
  MAX_VERBOSITY,
  buildPlaybookArgs,
  buildVaultArgv,
  buildVaultRekeyArgv,
  playbookLabel,
  sanitizeRunOptions,
  shellQuote,
  vaultArgs,
  verbosityFlag,
};
