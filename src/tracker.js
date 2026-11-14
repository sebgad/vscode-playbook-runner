/**
 * Records every playbook run in the history (src/history.js) and reads back
 * what the range plugin reported.
 *
 * Editor surface: it listens to VS Code's task events and owns the
 * workspace-state key. What a result *means* -- passed, failed, cancelled, a
 * range edge that never matched -- is decided in history.js.
 */

"use strict";

const fs = require("fs");
const vscode = require("vscode");

const history = require("./history");

/** The task type every playbook run is started with, see runner.js. */
const TASK_TYPE = "playbook-runner";

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

    this.disposables = [
      this._onDidChange,
      vscode.tasks.onDidEndTaskProcess((event) =>
        this.end(event.execution.task.definition, event.exitCode),
      ),
    ];
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
   * @param {vscode.TaskDefinition} definition
   * @param {number | undefined} exitCode
   */
  async end(definition, exitCode) {
    if (definition.type !== TASK_TYPE || typeof definition.runId !== "string") {
      return;
    }
    const id = definition.runId;
    // Only a run this window started and still has running. A replay of an
    // old task (VS Code's Rerun Last Task) or a terminal that outlived a
    // reload must not overwrite a finished or "unknown" entry with a result
    // that lacks the range verdict.
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

module.exports = { RunTracker, TASK_TYPE };
