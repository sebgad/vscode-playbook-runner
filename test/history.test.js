/**
 * Tests for the run history -- what the tree, the status bar and the
 * dashboard show as the last result of each playbook.
 */

"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  HISTORY_KEY,
  MAX_ENTRIES,
  finishRun,
  latestFor,
  parseHistory,
  relativeTime,
  settleStale,
  startRun,
} = require("../src/history");

/**
 * @param {Partial<import("../src/history").RunEntry>} [fields]
 * @returns {import("../src/history").RunEntry}
 */
function entry(fields = {}) {
  return {
    id: "r1",
    folder: "/repo",
    environment: "staging",
    playbook: "/repo/playbooks/app/app.yml",
    label: "app/app.yml",
    options: {},
    startedAt: 1000,
    status: "running",
    ...fields,
  };
}

describe("parseHistory", () => {
  it("names its workspace-state key and cap", () => {
    assert.equal(HISTORY_KEY, "playbookRunner.runHistory");
    assert.equal(MAX_ENTRIES, 200);
  });

  it("treats anything but an array as no history", () => {
    assert.deepEqual(parseHistory(undefined), []);
    assert.deepEqual(parseHistory({ 0: entry() }), []);
    assert.deepEqual(parseHistory("x"), []);
  });

  it("drops entries without their identifying fields, a known status or a finite start", () => {
    const raw = [
      entry({ id: "ok", status: "passed", endedAt: 2000, exitCode: 0 }),
      { ...entry(), id: undefined },
      { ...entry(), folder: 3 },
      { ...entry(), environment: null },
      { ...entry(), playbook: {} },
      { ...entry(), status: "exploded" },
      { ...entry(), startedAt: Number.NaN },
      { ...entry(), startedAt: "1000" },
      null,
    ];
    assert.deepEqual(
      parseHistory(raw).map((item) => item.id),
      ["ok"],
    );
  });

  it("rebuilds options through sanitizeRunOptions and keeps only known fields", () => {
    const [parsed] = parseHistory([
      { ...entry(), options: { extraArgs: [1, "-e"], tags: 5 }, injected: "x", message: 4 },
    ]);
    assert.ok(parsed);
    assert.deepEqual(parsed.options, { extraArgs: ["-e"] });
    assert.equal(/** @type {Record<string, unknown>} */ (parsed).injected, undefined);
    assert.equal(parsed.message, undefined);
  });

  it("caps what it reads at MAX_ENTRIES", () => {
    const raw = Array.from({ length: 250 }, (_, index) => entry({ id: `r${index}` }));
    assert.equal(parseHistory(raw).length, 200);
  });
});

describe("startRun", () => {
  it("prepends, and drops the oldest past the cap", () => {
    let history = /** @type {import("../src/history").RunEntry[]} */ ([]);
    for (let index = 0; index < 201; index += 1) {
      history = startRun(history, entry({ id: `r${index}` }));
    }
    assert.equal(history.length, 200);
    assert.equal(history[0]?.id, "r200");
    assert.equal(history[199]?.id, "r1");
  });
});

describe("finishRun", () => {
  const history = [entry({ id: "a" }), entry({ id: "b", status: "passed" })];

  /**
   * @param {Parameters<typeof finishRun>[2]} result
   * @param {import("../src/history").RunEntry[]} [base]
   */
  const finish = (result, base = history) =>
    /** @type {import("../src/history").RunEntry} */ (finishRun(base, "a", result)[0]);

  it("records a run whose exit code could not be tracked as unknown", () => {
    const result = finish({ exitCode: null, endedAt: 5, rangeStatus: null });
    assert.equal(result.status, "unknown");
    assert.equal(result.exitCode, undefined);
  });

  it("maps exit codes to passed, failed and cancelled", () => {
    assert.equal(finish({ exitCode: 0, endedAt: 5, rangeStatus: null }).status, "passed");
    assert.equal(finish({ exitCode: 2, endedAt: 5, rangeStatus: null }).status, "failed");
    const cancelled = finish({ exitCode: undefined, endedAt: 5, rangeStatus: null });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.endedAt, 5);
  });

  it("fails a range run whose from never matched, whatever the exit code", () => {
    const result = finish(
      { exitCode: 0, endedAt: 5, rangeStatus: { fromMatched: false, untilMatched: false } },
      [entry({ id: "a", options: { fromTask: "x" } })],
    );
    assert.equal(result.status, "failed");
    assert.equal(result.message, "from-task never matched, nothing in the range ran");
  });

  it("fails a range run whose until never matched", () => {
    const result = finish(
      { exitCode: 0, endedAt: 5, rangeStatus: { fromMatched: true, untilMatched: false } },
      [entry({ id: "a", options: { untilTask: "y" } })],
    );
    assert.equal(result.status, "failed");
    assert.equal(result.message, "until-task never matched, the run went to the end");
  });

  it("does not hold an unmatched until against a from-only run", () => {
    const result = finish(
      { exitCode: 0, endedAt: 5, rangeStatus: { fromMatched: true, untilMatched: false } },
      [entry({ id: "a", options: { fromTask: "x" } })],
    );
    assert.equal(result.status, "passed");
    assert.equal(result.message, undefined);
  });

  it("leaves the history alone for an unknown id", () => {
    assert.deepEqual(finishRun(history, "nope", { exitCode: 0, endedAt: 5, rangeStatus: null }), history);
  });
});

describe("settleStale", () => {
  it("turns runs left running by a closed window into unknown, and nothing else", () => {
    const settled = settleStale([entry({ id: "a" }), entry({ id: "b", status: "failed" })]);
    assert.deepEqual(
      settled.map((item) => item.status),
      ["unknown", "failed"],
    );
  });
});

describe("latestFor", () => {
  it("returns the newest entry of that folder, environment and playbook", () => {
    const history = [
      entry({ id: "other-env", environment: "production" }),
      entry({ id: "newest" }),
      entry({ id: "older" }),
    ];
    assert.equal(latestFor(history, "/repo", "staging", "/repo/playbooks/app/app.yml")?.id, "newest");
    assert.equal(latestFor(history, "/repo", "staging", "/repo/playbooks/x.yml"), null);
  });
});

describe("relativeTime", () => {
  const now = 10_000_000_000;
  it("rounds down to the largest unit", () => {
    assert.equal(relativeTime(now - 30_000, now), "just now");
    assert.equal(relativeTime(now - 3 * 60_000, now), "3 min ago");
    assert.equal(relativeTime(now - 5 * 3_600_000, now), "5 h ago");
    assert.equal(relativeTime(now - 2 * 86_400_000, now), "2 d ago");
  });

  it("says just now for a clock that went backwards", () => {
    assert.equal(relativeTime(now + 60_000, now), "just now");
  });
});
