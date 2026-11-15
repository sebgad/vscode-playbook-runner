/**
 * Records every playbook run in the history (src/history.js) and reads back
 * what the range plugin reported.
 *
 * Editor surface: runner.js tells it when a run ends, and it owns the
 * workspace-state key. What a result *means* -- passed, failed, cancelled, a
 * range edge that never matched -- is decided in history.js.
 */

"use strict";

const fs = require("fs");
const vscode = require("vscode");

const history = require("./history");

/**
 * The plugin's status file, if it wrote one. Read once, then removed.
 *
 * @param {string | undefined} file
 * @returns {import("./history").RangeStatus | null}
 */
function takeRangeStatus(file) {
  if (!file) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.rmSync(file, { force: true });
    if (raw && typeof raw === "object") {
      return { fromMatched: raw.fromMatched === true, untilMatched: raw.untilMatched === true };
    }
  } catch {
    // No file: the plugin never ran. That is a range run that did nothing,
    // which the unmatched-from verdict below names.
  }
  return { fromMatched: false, untilMatched: false };
}

class RunTracker {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.context = context;
    /** @type {Map<string, string>} runId -> status file, for range runs */
    this.statusFiles = new Map();
    this._onDidChange = new vscode.EventEmitter();
    /** Fired after every change to the history. */
    this.onDidChange = this._onDidChange.event;

    this._history = history.settleStale(
      history.parseHistory(context.workspaceState.get(history.HISTORY_KEY)),
    );
    void this.save();

    this.disposables = [this._onDidChange];
  }

  /** @returns {import("./history").RunEntry[]} */
  get history() {
    return this._history;
  }

  /**
   * @param {import("./history").RunEntry} entry
   * @param {string | null} statusFile  set for a range run
   */
  async begin(entry, statusFile) {
    if (statusFile) {
      this.statusFiles.set(entry.id, statusFile);
    }
    this._history = history.startRun(this._history, entry);
    await this.save();
  }

  /**
   * A run that never got as far as a task, e.g. executeTask rejected.
   *
   * @param {string} id
   */
  async abandon(id) {
    this.statusFiles.delete(id);
    this._history = history.finishRun(this._history, id, {
      exitCode: undefined,
      endedAt: Date.now(),
      rangeStatus: null,
    });
    await this.save();
  }

  /**
   * @param {string} id
   * @param {number | undefined | null} exitCode  null: the result could not be tracked
   */
  async end(id, exitCode) {
    // Only a run this window started and still has running: a reload settles
    // the rest as "unknown", and nothing may overwrite that afterwards.
    const before = this._history.find((entry) => entry.id === id);
    if (!before || before.status !== "running") {
      return;
    }
    const statusFile = this.statusFiles.get(id);
    this.statusFiles.delete(id);
    const rangeStatus = statusFile ? takeRangeStatus(statusFile) : null;

    this._history = history.finishRun(this._history, id, {
      exitCode,
      endedAt: Date.now(),
      rangeStatus,
    });
    await this.save();

    const after = this._history.find((entry) => entry.id === id);
    if (after && after.message) {
      vscode.window.showErrorMessage(`Playbook Runner: ${after.label}: ${after.message}`);
    }
  }

  /**
   * @param {string} folder @param {string} environment
   * @returns {boolean} a playbook is running against that environment
   */
  isRunning(folder, environment) {
    return this._history.some(
      (entry) => entry.status === "running" && entry.folder === folder && entry.environment === environment,
    );
  }

  /** @param {string} folder @param {string} from @param {string} to */
  async renameEnvironment(folder, from, to) {
    this._history = history.renameEnvironment(this._history, folder, from, to);
    await this.save();
  }

  async save() {
    await this.context.workspaceState.update(history.HISTORY_KEY, this._history);
    this._onDidChange.fire(undefined);
  }

  dispose() {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

module.exports = { RunTracker };
