/**
 * End-to-end tests for the task-range strategy plugin.
 *
 * These run the real ansible-playbook -- the repository's .venv first, then
 * PATH -- with the env buildPlaybookEnv produces, against throwaway playbooks
 * on `localhost,` with `connection: local` whose every task is a `debug`. No
 * repository inventory, no vault, no host is touched. Without an
 * ansible-playbook the whole suite is skipped rather than failed: the plugin
 * is the part of this extension that depends on ansible-core internals, and
 * these tests are what pins it to the installed version.
 */

"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const { buildPlaybookEnv } = require("../src/command");
const { makeFixture, removeFixture } = require("./helpers");

const PLUGIN_DIR = path.resolve(__dirname, "../ansible/strategy");

/** @returns {string | null} */
function findAnsiblePlaybook() {
  const venv = path.resolve(__dirname, "../../../.venv/bin/ansible-playbook");
  if (fs.existsSync(venv)) {
    return venv;
  }
  const which = spawnSync("sh", ["-c", "command -v ansible-playbook"], { encoding: "utf8" });
  return which.status === 0 && which.stdout.trim() ? which.stdout.trim() : null;
}

const ANSIBLE = findAnsiblePlaybook();

/**
 * @param {string} name
 * @param {string} id
 * @param {string} [extra]  further lines, indented to sit under the task
 */
function task(name, id, extra = "") {
  return `    - name: ${JSON.stringify(name)}\n      ansible.builtin.debug:\n        msg: "RAN:${id}"\n${extra}`;
}

/**
 * @param {string} name
 * @param {string} body  the tasks
 * @param {string} [extra]  further play keys
 */
function play(name, body, extra = "") {
  return `- name: ${name}\n  hosts: localhost\n  connection: local\n  gather_facts: false\n${extra}  tasks:\n${body}`;
}

/** @type {(string | [string, string])[]} */
const FIXTURE = [
  ["ansible.cfg", "[defaults]\n"],
  [
    "basic.yml",
    play(
      "basic",
      task("s1", "s1", "      tags: [podman-user-setup]\n") +
        task("a", "a") +
        task("b", "b", "      changed_when: true\n      notify: h\n") +
        task("c", "c"),
      "  handlers:\n    - name: h\n      ansible.builtin.debug:\n        msg: \"RAN:h\"\n",
    ),
  ],
  [
    "multi.yml",
    `${play("one", task("x", "x1") + task("y", "y"))}\n${play("two", task("x", "x2") + task("z", "z"))}`,
  ],
  [
    "roles.yml",
    play(
      "roles",
      "    - name: setup through a role\n      ansible.builtin.import_role:\n        name: u\n      tags: [podman-user-setup]\n" +
        task("a", "a") +
        "    - ansible.builtin.import_role:\n        name: r\n" +
        task("c", "c"),
    ),
  ],
  ["roles/u/tasks/main.yml", '- name: u1\n  ansible.builtin.debug:\n    msg: "RAN:u1"\n'],
  ["roles/r/tasks/main.yml", '- name: t\n  ansible.builtin.debug:\n    msg: "RAN:t"\n'],
  [
    "collision.yml",
    play(
      "collision",
      "    - ansible.builtin.import_role:\n        name: cr\n" + task("middle", "middle") + task("Create user", "play_create") + task("last", "last"),
    ),
  ],
  ["roles/cr/tasks/main.yml", '- name: Create user\n  ansible.builtin.debug:\n    msg: "RAN:role_create"\n'],
  [
    "serial.yml",
    `- name: rolling\n  hosts: all\n  connection: local\n  gather_facts: false\n  serial: 1\n  tasks:\n${task("a", "a")}${task("b", "b")}`,
  ],
  [
    "names.yml",
    play(
      "names",
      task("Install [extras]", "brackets") +
        task("Installe", "installe") +
        task("it's *done*", "quote") +
        task("Deploy {{ app }}", "templated"),
      "  vars:\n    app: thing\n",
    ),
  ],
];

/**
 * @typedef {object} RunResult
 * @property {string[]} ran  the RAN: ids, in order
 * @property {string} stdout
 * @property {{ fromMatched: boolean, untilMatched: boolean } | null} status
 * @property {number | null} code
 */

describe("range strategy plugin", { skip: ANSIBLE ? false : "ansible-playbook not found", concurrency: true }, () => {
  /** @type {string} */
  let root;
  let counter = 0;

  before(() => {
    root = makeFixture(FIXTURE, { prefix: "playbook-runner-plugin-" });
  });

  after(() => removeFixture(root));

  /**
   * @param {string} playbook
   * @param {import("../src/command").RunOptions} options
   * @param {string[]} [setupTags]
   * @param {{ arm?: boolean, inventory?: string }} [opts]  arm: write the one-shot token the extension writes
   * @returns {Promise<RunResult>}
   */
  const run = (playbook, options, setupTags = ["podman-user-setup"], opts = {}) => {
    counter += 1;
    const statusFile = path.join(root, `status-${counter}.json`);
    if (opts.arm !== false) {
      fs.writeFileSync(statusFile, JSON.stringify({ armed: true }));
    }
    const env = {
      ...process.env,
      ...buildPlaybookEnv({ options, setupTags, pluginDir: PLUGIN_DIR, statusFile }),
      ANSIBLE_CONFIG: path.join(root, "ansible.cfg"),
      ANSIBLE_NOCOLOR: "1",
      ANSIBLE_LOCALHOST_WARNING: "false",
      ANSIBLE_INVENTORY_UNPARSED_WARNING: "false",
    };
    return new Promise((resolve, reject) => {
      const child = spawn(String(ANSIBLE), ["-i", opts.inventory || "localhost,", playbook], { cwd: root, env });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stdout += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        const ran = [...stdout.matchAll(/"msg": "RAN:(\w+)"/g)].map((match) => String(match[1]));
        /** @type {RunResult["status"]} */
        let status = null;
        try {
          status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
        } catch {
          status = null;
        }
        resolve({ ran, stdout, status, code });
      });
    });
  };

  it("from: runs setup-tagged tasks, then everything from the start task", async () => {
    const result = await run("basic.yml", { fromTask: "b" });
    assert.deepEqual(result.ran, ["s1", "b", "c", "h"], result.stdout);
    assert.deepEqual(result.status, { fromMatched: true, untilMatched: false });
    assert.equal(result.code, 0, result.stdout);
  });

  it("until: stops after the stop task", async () => {
    const result = await run("basic.yml", { untilTask: "a" });
    assert.deepEqual(result.ran, ["s1", "a"], result.stdout);
    assert.deepEqual(result.status, { fromMatched: true, untilMatched: true });
  });

  it("only: runs the one task, plus setup", async () => {
    const result = await run("basic.yml", { fromTask: "a", untilTask: "a" });
    assert.deepEqual(result.ran, ["s1", "a"], result.stdout);
  });

  it("with no setup tags, from behaves like --start-at-task", async () => {
    const result = await run("basic.yml", { fromTask: "c" }, []);
    assert.deepEqual(result.ran, ["c"], result.stdout);
  });

  it("still fires handlers notified inside the range after until", async () => {
    const result = await run("basic.yml", { untilTask: "b" });
    assert.deepEqual(result.ran, ["s1", "a", "b", "h"], result.stdout);
  });

  it("skips every later play after until", async () => {
    const result = await run("multi.yml", { untilTask: "y" });
    assert.deepEqual(result.ran, ["x1", "y"], result.stdout);
  });

  it("takes the first occurrence of until at or after from, across plays", async () => {
    const result = await run("multi.yml", { fromTask: "y", untilTask: "x" });
    assert.deepEqual(result.ran, ["y", "x2"], result.stdout);
  });

  it("matches a role task by its prefixed name, and inherits setup tags from the role reference", async () => {
    const result = await run("roles.yml", { fromTask: "r : t" });
    assert.deepEqual(result.ran, ["u1", "t", "c"], result.stdout);
  });

  it("matches names exactly, glob characters and quotes included", async () => {
    const brackets = await run("names.yml", { fromTask: "Install [extras]", untilTask: "Install [extras]" });
    assert.deepEqual(brackets.ran, ["brackets"], brackets.stdout);
    const quote = await run("names.yml", { fromTask: "it's *done*", untilTask: "it's *done*" });
    assert.deepEqual(quote.ran, ["quote"], quote.stdout);
  });

  it("matches a templated name as written", async () => {
    const result = await run("names.yml", { fromTask: "Deploy {{ app }}" });
    assert.deepEqual(result.ran, ["templated"], result.stdout);
  });

  it("reports an until that never matched, after running to the end", async () => {
    const result = await run("basic.yml", { untilTask: "nope" });
    assert.deepEqual(result.ran, ["s1", "a", "b", "c", "h"], result.stdout);
    assert.deepEqual(result.status, { fromMatched: true, untilMatched: false });
  });

  it("runs only setup tasks when from never matched, and reports it", async () => {
    const result = await run("basic.yml", { fromTask: "nope" });
    assert.deepEqual(result.ran, ["s1"], result.stdout);
    assert.deepEqual(result.status, { fromMatched: false, untilMatched: false });
  });

  it("matches the role-prefixed name only, never a role task that shares the bare name", async () => {
    const only = await run("collision.yml", { fromTask: "Create user", untilTask: "Create user" });
    assert.deepEqual(only.ran, ["play_create"], only.stdout);
    const from = await run("collision.yml", { fromTask: "Create user" });
    assert.deepEqual(from.ran, ["play_create", "last"], from.stdout);
    const role = await run("collision.yml", { fromTask: "cr : Create user", untilTask: "cr : Create user" });
    assert.deepEqual(role.ran, ["role_create"], role.stdout);
  });

  it("refuses a serial play before any task runs", async () => {
    const result = await run("serial.yml", { fromTask: "b" }, [], { inventory: "h1,h2," });
    assert.deepEqual(result.ran, [], result.stdout);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /serial/);
  });

  it("refuses a run whose status file was not armed -- a replayed task", async () => {
    const result = await run("basic.yml", { untilTask: "a" }, undefined, { arm: false });
    assert.deepEqual(result.ran, [], result.stdout);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /Playbook Runner/);
  });

  it("refuses an ansible-core it was not tested against", () => {
    const python = path.join(path.dirname(String(ANSIBLE)), "python3");
    /** @param {string} version */
    const check = (version) =>
      spawnSync(
        fs.existsSync(python) ? python : "python3",
        ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(PLUGIN_DIR)}); import playbook_runner_range as p; p.check_compatible(${JSON.stringify(version)})`],
        { encoding: "utf8" },
      );
    assert.equal(check("2.22.0").status, 0, check("2.22.0").stderr);
    const newer = check("2.23.0");
    assert.notEqual(newer.status, 0);
    assert.match(newer.stderr, /2\.23\.0/);
  });

  it("announces itself", async () => {
    const result = await run("basic.yml", { fromTask: "b", untilTask: "c" });
    assert.match(result.stdout, /Playbook Runner: running from «b» until «c»/);
    const open = await run("basic.yml", { untilTask: "a" });
    assert.match(open.stdout, /Playbook Runner: running from the start until «a»/);
  });
});
