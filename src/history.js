/**
 * The run history: one entry per playbook run, newest first, kept in
 * workspace state. It is what the dashboard's "✓ 3 min ago", the status bar item
 * and the dashboard read.
 *
 * Like the other modules that decide things, this one imports `vscode`
 * nowhere -- extension.js does the reading and writing of workspace state and
 * hands plain arrays in and out.
 */

"use strict";

const { sanitizeRunOptions } = require("./command");

const HISTORY_KEY = "playbookRunner.runHistory";
const MAX_ENTRIES = 200;

/** @typedef {"running" | "passed" | "failed" | "cancelled" | "unknown"} RunStatus */

/** @type {ReadonlySet<string>} */
const STATUSES = new Set(["running", "passed", "failed", "cancelled", "unknown"]);

/**
 * @typedef {object} RunEntry
 * @property {string} id
 * @property {string} folder       workspace folder path
 * @property {string} environment
 * @property {string} playbook     absolute path
 * @property {string} label        e.g. "dns_servers/setup-bind9.yml"
 * @property {import("./command").RunOptions} options
 * @property {number} startedAt    ms since the epoch
 * @property {number} [endedAt]
 * @property {number} [exitCode]
 * @property {RunStatus} status
 * @property {string} [message]    why a run that exited 0 still counts as failed
 */

/**
 * @typedef {object} RangeStatus
 * @property {boolean} fromMatched
 * @property {boolean} untilMatched
 */

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The history as workspace state gave it back. It survives restarts and
 * upgrades, and its options reach a command line through Re-run, so each
 * entry is rebuilt field by field rather than trusted.
 *
 * @param {unknown} value
 * @returns {RunEntry[]}
 */
function parseHistory(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  /** @type {RunEntry[]} */
  const history = [];
  for (const item of value) {
    if (history.length >= MAX_ENTRIES) {
      break;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const raw = /** @type {Record<string, unknown>} */ (item);
    if (
      typeof raw.id !== "string" ||
      typeof raw.folder !== "string" ||
      typeof raw.environment !== "string" ||
      typeof raw.playbook !== "string" ||
      typeof raw.status !== "string" ||
      !STATUSES.has(raw.status) ||
      !isFiniteNumber(raw.startedAt)
    ) {
      continue;
    }
    /** @type {RunEntry} */
    const entry = {
      id: raw.id,
      folder: raw.folder,
      environment: raw.environment,
      playbook: raw.playbook,
      label: typeof raw.label === "string" ? raw.label : raw.playbook,
      options: sanitizeRunOptions(raw.options),
      startedAt: raw.startedAt,
      status: /** @type {RunStatus} */ (raw.status),
    };
    if (isFiniteNumber(raw.endedAt)) {
      entry.endedAt = raw.endedAt;
    }
    if (isFiniteNumber(raw.exitCode)) {
      entry.exitCode = raw.exitCode;
    }
    if (typeof raw.message === "string" && raw.message) {
      entry.message = raw.message;
    }
    history.push(entry);
  }
  return history;
}

/**
 * @param {RunEntry[]} history
 * @param {RunEntry} entry
 * @returns {RunEntry[]}
 */
function startRun(history, entry) {
  return [entry, ...history].slice(0, MAX_ENTRIES);
}

/**
 * The history after an environment was renamed: its runs follow the name, so
 * the dashboard keeps showing what last happened to each playbook.
 *
 * @param {RunEntry[]} history
 * @param {string} folder
 * @param {string} from
 * @param {string} to
 * @returns {RunEntry[]}
 */
function renameEnvironment(history, folder, from, to) {
  return history.map((entry) =>
    entry.folder === folder && entry.environment === from ? { ...entry, environment: to } : entry,
  );
}

/**
 * Why a range run counts as failed although ansible may have exited 0, or
 * null. Only an edge the run actually had is held against it.
 *
 * @param {import("./command").RunOptions} options
 * @param {RangeStatus | null} rangeStatus
 * @returns {string | null}
 */
function rangeVerdict(options, rangeStatus) {
  if (!rangeStatus) {
    return null;
  }
  if (options.fromTask && !rangeStatus.fromMatched) {
    return "from-task never matched, nothing in the range ran";
  }
  if (options.untilTask && !rangeStatus.untilMatched) {
    return "until-task never matched, the run went to the end";
  }
  return null;
}

/**
 * @param {RunEntry[]} history
 * @param {string} id
 * `exitCode` is undefined for a run that was stopped, null for one whose
 * result could not be tracked (a terminal without shell integration).
 *
 * @param {{ exitCode: number | undefined | null, endedAt: number, rangeStatus: RangeStatus | null }} result
 * @returns {RunEntry[]}
 */
function finishRun(history, id, result) {
  if (!history.some((entry) => entry.id === id)) {
    return history;
  }
  return history.map((entry) => {
    if (entry.id !== id) {
      return entry;
    }
    /** @type {RunEntry} */
    const finished = { ...entry, endedAt: result.endedAt };
    if (result.exitCode === null) {
      finished.status = "unknown";
      return finished;
    }
    if (result.exitCode === undefined) {
      finished.status = "cancelled";
      return finished;
    }
    finished.exitCode = result.exitCode;
    const message = rangeVerdict(entry.options, result.rangeStatus);
    if (message) {
      finished.status = "failed";
      finished.message = message;
    } else {
      finished.status = result.exitCode === 0 ? "passed" : "failed";
    }
    return finished;
  });
}

/**
 * Runs still marked running when the extension starts belong to a window that
 * went away. Their task terminal may well have outlived it and finished, so
 * the honest answer is "unknown", not "cancelled".
 *
 * @param {RunEntry[]} history
 * @returns {RunEntry[]}
 */
function settleStale(history) {
  return history.map((entry) =>
    entry.status === "running" ? { ...entry, status: /** @type {RunStatus} */ ("unknown") } : entry,
  );
}

/**
 * @param {RunEntry[]} history
 * @param {string} folder
 * @param {string} environment
 * @param {string} playbook
 * @returns {RunEntry | null}
 */
function latestFor(history, folder, environment, playbook) {
  return (
    history.find(
      (entry) =>
        entry.folder === folder && entry.environment === environment && entry.playbook === playbook,
    ) ?? null
  );
}

/**
 * @param {number} ms   the moment
 * @param {number} now
 * @returns {string}
 */
function relativeTime(ms, now) {
  const elapsed = now - ms;
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  return `${Math.floor(hours / 24)} d ago`;
}

module.exports = {
  HISTORY_KEY,
  MAX_ENTRIES,
  finishRun,
  latestFor,
  parseHistory,
  relativeTime,
  renameEnvironment,
  settleStale,
  startRun,
};
