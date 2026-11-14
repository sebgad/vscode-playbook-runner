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
 * @property {string} [fromTask]   task range, run by the range strategy plugin
 * @property {string} [untilTask]  from = until is a single task
 * @property {boolean} [step]      --step: confirm every task
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
  if (typeof raw.fromTask === "string" && raw.fromTask.trim()) {
    options.fromTask = raw.fromTask.trim();
  }
  if (typeof raw.untilTask === "string" && raw.untilTask.trim()) {
    options.untilTask = raw.untilTask.trim();
  }
  if (raw.step === true) {
    options.step = true;
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
  // The task range is deliberately not here: there is no ansible flag for
  // "until", so it travels as env to the range strategy -- see
  // buildPlaybookEnv.
  if (options.step) {
    args.push("--step");
  }
  if (Array.isArray(options.extraArgs)) {
    args.push(...options.extraArgs);
  }

  return args;
}

/** The strategy plugin shipped in ansible/strategy/, by its file name. */
const RANGE_STRATEGY = "playbook_runner_range";

/**
 * @param {RunOptions} options
 * @returns {boolean}
 */
function hasTaskRange(options) {
  return Boolean(options.fromTask || options.untilTask);
}

/**
 * The environment a task-range run needs on top of the user's own: the range
 * strategy, where to find it, the two edges, the tags that still run before
 * the start, and where the plugin reports whether each edge matched. Empty
 * for every other run, so nothing changes for a run without a range.
 *
 * @param {{ options: RunOptions, setupTags: string[], pluginDir: string, statusFile: string }} spec
 * @returns {Record<string, string>}
 */
function buildPlaybookEnv(spec) {
  const options = spec.options || {};
  if (!hasTaskRange(options)) {
    return {};
  }
  const setupTags = Array.isArray(spec.setupTags)
    ? spec.setupTags.filter((tag) => typeof tag === "string")
    : [];
  return {
    ANSIBLE_STRATEGY_PLUGINS: spec.pluginDir,
    ANSIBLE_STRATEGY: RANGE_STRATEGY,
    PLAYBOOK_RUNNER_FROM_TASK: options.fromTask || "",
    PLAYBOOK_RUNNER_UNTIL_TASK: options.untilTask || "",
    PLAYBOOK_RUNNER_SETUP_TAGS: JSON.stringify(setupTags),
    PLAYBOOK_RUNNER_STATUS_FILE: spec.statusFile,
  };
}

/**
 * Why a task range cannot run against this outline, or null when it can.
 *
 * This is the guard that keeps a range run from quietly becoming a whole run:
 * an edge the plugin would never match -- a renamed task in a remembered last
 * run, an until before the from -- is refused before anything starts. So is a
 * playbook that sets `strategy:` itself, because a play keyword beats
 * ANSIBLE_STRATEGY and the plugin would never be loaded, and one with a
 * `serial:` play, whose later batches the plugin would not range again.
 *
 * @param {import("./tags").PlaybookOutline} outline
 * @param {RunOptions} options
 * @returns {string | null}
 */
function validateTaskRange(outline, options) {
  if (!hasTaskRange(options)) {
    return null;
  }
  if (outline.strategy) {
    return `this playbook sets "strategy: ${outline.strategy}", which would bypass the task-range plugin`;
  }
  if (outline.serial) {
    return `this playbook sets "serial: ${outline.serial}"; each batch of hosts would need the range again, which the task-range plugin does not do`;
  }
  const names = outline.plays.flatMap((play) => play.tasks.map((task) => task.name));
  let start = 0;
  if (options.fromTask) {
    start = names.indexOf(options.fromTask);
    if (start < 0) {
      return `task "${options.fromTask}" was not found in this playbook`;
    }
  }
  if (options.untilTask) {
    if (!names.includes(options.untilTask)) {
      return `task "${options.untilTask}" was not found in this playbook`;
    }
    if (names.indexOf(options.untilTask, start) < 0) {
      return `"${options.untilTask}" comes before "${options.fromTask}", so the range is empty`;
    }
  }
  return null;
}

/**
 * How a run is named in the production confirmation and in messages.
 *
 * @param {string} label
 * @param {RunOptions} options
 * @returns {string}
 */
function describeRun(label, options) {
  const parts = [label];
  if (options.tags) {
    parts.push(`--tags ${options.tags}`);
  }
  if (options.fromTask && options.fromTask === options.untilTask) {
    parts.push(`only «${options.fromTask}»`);
  } else {
    if (options.fromTask) {
      parts.push(`from «${options.fromTask}»`);
    }
    if (options.untilTask) {
      parts.push(`until «${options.untilTask}»`);
    }
  }
  return parts.join(" ");
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
 * The line typed into the runner terminal for one playbook run.
 *
 * `env -C <folder>` runs it in the workspace folder -- ansible.cfg is only read
 * from the cwd -- without moving the interactive shell, and carries the
 * task-range variables without exporting them into that shell. The leading
 * space keeps the line out of bash and fish history, so pressing ↑ cannot
 * replay a range run past the extension's checks. Everything is quoted except
 * the configured command, which may be a wrapper such as
 * `uv run ansible-playbook` and is a `machine` setting a workspace cannot set.
 *
 * @param {{ cwd: string, command: string, argv: string[], env: Record<string, string> }} spec
 * @returns {string}
 */
function buildTerminalCommand(spec) {
  const assignments = Object.entries(spec.env).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`not an environment variable name: ${name}`);
    }
    return shellQuote(`${name}=${value}`);
  });
  return ` ${["env", "-C", shellQuote(spec.cwd), ...assignments, spec.command, ...spec.argv.map(shellQuote)].join(" ")}`;
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
  RANGE_STRATEGY,
  buildPlaybookArgs,
  buildPlaybookEnv,
  buildTerminalCommand,
  buildVaultArgv,
  buildVaultRekeyArgv,
  describeRun,
  hasTaskRange,
  playbookLabel,
  sanitizeRunOptions,
  shellQuote,
  validateTaskRange,
  vaultArgs,
  verbosityFlag,
};
