/**
 * Tests for the ansible argument vectors, checked against what the shell
 * scripts they replace produced.
 */

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
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
} = require("../src/command");

describe("buildPlaybookArgs", () => {
  it("builds the bare command with no options set", () => {
    assert.deepEqual(
      buildPlaybookArgs({
        inventory: "inventories/production/hosts.ini",
        playbook: "playbooks/dns_servers/setup-bind9.yml",
      }),
      [
        "-i",
        "inventories/production/hosts.ini",
        "playbooks/dns_servers/setup-bind9.yml",
        "--ask-vault-password",
      ],
    );
  });

  it("uses the password file when one was resolved", () => {
    const args = buildPlaybookArgs({
      inventory: "inventories/staging/hosts.ini",
      playbook: "playbooks/immich/immich.yml",
      vaultPasswordFile: "/home/user/.ansible-vault/staging.pass",
    });
    assert.deepEqual(args.slice(3), [
      "--vault-password-file",
      "/home/user/.ansible-vault/staging.pass",
    ]);
    assert.equal(args.includes("--ask-vault-password"), false);
  });

  it("appends the options in a stable order", () => {
    assert.deepEqual(
      buildPlaybookArgs({
        inventory: "inv",
        playbook: "pb",
        vaultPasswordFile: "pass",
        options: {
          tags: "nginx,certs",
          limit: "podman_server",
          check: true,
          diff: true,
          verbosity: 3,
          extraArgs: ["--forks", "10"],
        },
      }),
      [
        "-i",
        "inv",
        "pb",
        "--vault-password-file",
        "pass",
        "--tags",
        "nginx,certs",
        "--limit",
        "podman_server",
        "--check",
        "--diff",
        "-vvv",
        "--forks",
        "10",
      ],
    );
  });

  it("leaves out options that were not set", () => {
    const args = buildPlaybookArgs({
      inventory: "inv",
      playbook: "pb",
      options: { tags: "", limit: "", check: false, diff: false, verbosity: 0 },
    });
    assert.deepEqual(args, ["-i", "inv", "pb", "--ask-vault-password"]);
  });
});

describe("verbosityFlag", () => {
  it("maps 1..4 the way the script's printf did", () => {
    assert.deepEqual(
      [1, 2, 3, 4].map(verbosityFlag),
      ["-v", "-vv", "-vvv", "-vvvv"],
    );
  });

  it("caps at -vvvv and ignores nothing-to-do values", () => {
    assert.equal(verbosityFlag(9), "-vvvv");
    for (const value of [0, -1, undefined, null, "", "loud"]) {
      assert.equal(verbosityFlag(value), null, `expected null for ${JSON.stringify(value)}`);
    }
  });
});

describe("vaultArgs", () => {
  it("falls back to prompting without a password file", () => {
    assert.deepEqual(vaultArgs(null), ["--ask-vault-password"]);
    assert.deepEqual(vaultArgs("/p"), ["--vault-password-file", "/p"]);
  });
});

describe("buildVaultArgv", () => {
  it("builds the edit and create commands", () => {
    assert.deepEqual(
      buildVaultArgv({
        vaultCommand: "ansible-vault",
        action: "edit",
        vaultFile: "inventories/production/group_vars/immich/vault.yml",
        vaultPasswordFile: null,
      }),
      [
        "ansible-vault",
        "edit",
        "inventories/production/group_vars/immich/vault.yml",
        "--ask-vault-password",
      ],
    );
    assert.deepEqual(
      buildVaultArgv({
        vaultCommand: "ansible-vault",
        action: "create",
        vaultFile: "v.yml",
        vaultPasswordFile: "/p",
      }),
      ["ansible-vault", "create", "v.yml", "--vault-password-file", "/p"],
    );
  });
});

describe("buildVaultRekeyArgv", () => {
  it("carries every vault in one invocation", () => {
    assert.deepEqual(
      buildVaultRekeyArgv({
        vaultCommand: "ansible-vault",
        vaultFiles: [
          "inventories/production/group_vars/authentik/vault.yml",
          "inventories/production/group_vars/immich/vault.yml",
        ],
        vaultPasswordFile: null,
      }),
      [
        "ansible-vault",
        "rekey",
        "inventories/production/group_vars/authentik/vault.yml",
        "inventories/production/group_vars/immich/vault.yml",
        "--ask-vault-password",
      ],
    );
  });

  it("passes the resolved password file as the *current* passphrase", () => {
    assert.deepEqual(
      buildVaultRekeyArgv({
        vaultCommand: "ansible-vault",
        vaultFiles: ["v.yml"],
        vaultPasswordFile: "/home/user/.ansible-vault/staging.pass",
      }),
      ["ansible-vault", "rekey", "v.yml", "--vault-password-file", "/home/user/.ansible-vault/staging.pass"],
    );
  });

  it("never puts the new passphrase on the command line", () => {
    // --new-vault-password-file is deliberately absent: ansible-vault prompts,
    // so the new passphrase never reaches the process table or shell history.
    const argv = buildVaultRekeyArgv({
      vaultCommand: "ansible-vault",
      vaultFiles: ["v.yml"],
      vaultPasswordFile: "/p",
    });
    assert.ok(!argv.some((arg) => arg.startsWith("--new-vault")));
  });

  it("honours a wrapper command", () => {
    const argv = buildVaultRekeyArgv({
      vaultCommand: "uv-run-ansible-vault",
      vaultFiles: ["v.yml"],
      vaultPasswordFile: null,
    });
    assert.equal(argv[0], "uv-run-ansible-vault");
    assert.equal(argv[1], "rekey");
  });
});

describe("shellQuote", () => {
  it("leaves ordinary paths alone", () => {
    assert.equal(shellQuote("playbooks/dns_servers/setup-bind9.yml"), "playbooks/dns_servers/setup-bind9.yml");
    assert.equal(shellQuote("--ask-vault-password"), "--ask-vault-password");
  });

  it("quotes spaces and embedded single quotes", () => {
    assert.equal(shellQuote("my playbooks/a.yml"), "'my playbooks/a.yml'");
    // Valid in POSIX sh and in fish, which concatenates the adjacent pieces.
    assert.equal(shellQuote("it's"), "'it'\\''s'");
    assert.equal(shellQuote("$(rm -rf /)"), "'$(rm -rf /)'");
  });
});

describe("sanitizeRunOptions", () => {
  it("keeps the options it knows", () => {
    assert.deepEqual(
      sanitizeRunOptions({
        tags: " nginx,certs ",
        limit: "podman_server",
        check: true,
        diff: true,
        verbosity: 2,
        extraArgs: ["--forks", "10"],
      }),
      {
        tags: "nginx,certs",
        limit: "podman_server",
        check: true,
        diff: true,
        verbosity: 2,
        extraArgs: ["--forks", "10"],
      },
    );
  });

  it("drops everything else, whatever workspace state hands back", () => {
    assert.deepEqual(sanitizeRunOptions(undefined), {});
    assert.deepEqual(sanitizeRunOptions("--become"), {});
    assert.deepEqual(
      sanitizeRunOptions({
        tags: "   ",
        limit: 7,
        check: "yes",
        diff: 1,
        verbosity: "loud",
        extraArgs: "--forks 10",
        become: true,
      }),
      {},
    );
  });

  it("keeps only the string members of extraArgs", () => {
    assert.deepEqual(sanitizeRunOptions({ extraArgs: ["--forks", 10, null] }), {
      extraArgs: ["--forks"],
    });
  });

  it("clamps verbosity to what ansible understands", () => {
    assert.equal(sanitizeRunOptions({ verbosity: 9 }).verbosity, 4);
    assert.equal(sanitizeRunOptions({ verbosity: 2.7 }).verbosity, 2);
    assert.equal(sanitizeRunOptions({ verbosity: -1 }).verbosity, undefined);
  });

  it("survives a round trip through JSON", () => {
    const options = { tags: "nginx", check: true, verbosity: 1 };
    assert.deepEqual(sanitizeRunOptions(JSON.parse(JSON.stringify(options))), options);
  });
});

describe("playbookLabel", () => {
  const settings = { playbooksDir: "playbooks" };

  it("names a playbook by folder and file", () => {
    assert.equal(
      playbookLabel("/repo", settings, path.join("/repo", "playbooks/dns_servers/setup-bind9.yml")),
      path.join("dns_servers", "setup-bind9.yml"),
    );
  });

  it("falls back to the workspace-relative path outside playbooks/", () => {
    assert.equal(
      playbookLabel("/repo", settings, path.join("/repo", "playbook.yml")),
      "playbook.yml",
    );
  });
});

describe("task-range run options", () => {
  it("sanitizeRunOptions keeps task range and step", () => {
    assert.deepEqual(sanitizeRunOptions({ fromTask: "  A ", untilTask: "B", step: true }), {
      fromTask: "A",
      untilTask: "B",
      step: true,
    });
    assert.deepEqual(sanitizeRunOptions({ fromTask: 3, untilTask: {}, step: "yes" }), {});
    assert.deepEqual(sanitizeRunOptions({ fromTask: "   " }), {});
  });

  it("buildPlaybookArgs adds --step before extraArgs and never carries the range", () => {
    const args = buildPlaybookArgs({
      inventory: "i.ini",
      playbook: "p.yml",
      vaultPasswordFile: "/v",
      options: { step: true, fromTask: "A", untilTask: "A", extraArgs: ["-e", "x=1"] },
    });
    assert.deepEqual(args.slice(-3), ["--step", "-e", "x=1"]);
    assert.ok(!args.includes("A"));
    assert.ok(!args.includes("--start-at-task"));
  });

  it("hasTaskRange is true for either edge only", () => {
    assert.equal(hasTaskRange({}), false);
    assert.equal(hasTaskRange({ tags: "x", step: true }), false);
    assert.equal(hasTaskRange({ fromTask: "A" }), true);
    assert.equal(hasTaskRange({ untilTask: "B" }), true);
  });
});

describe("buildPlaybookEnv", () => {
  const base = {
    setupTags: ["podman-user-setup"],
    pluginDir: "/ext/ansible/strategy",
    statusFile: "/s/run.json",
  };

  it("is empty without a range", () => {
    assert.deepEqual(buildPlaybookEnv({ ...base, options: { tags: "x", step: true } }), {});
  });

  it("enables the strategy for a from-only range", () => {
    assert.deepEqual(buildPlaybookEnv({ ...base, options: { fromTask: "A" } }), {
      ANSIBLE_STRATEGY_PLUGINS: "/ext/ansible/strategy",
      ANSIBLE_STRATEGY: "playbook_runner_range",
      PLAYBOOK_RUNNER_FROM_TASK: "A",
      PLAYBOOK_RUNNER_UNTIL_TASK: "",
      PLAYBOOK_RUNNER_SETUP_TAGS: '["podman-user-setup"]',
      PLAYBOOK_RUNNER_STATUS_FILE: "/s/run.json",
    });
    assert.equal(RANGE_STRATEGY, "playbook_runner_range");
  });

  it("leaves FROM_TASK empty for an until-only range", () => {
    const env = buildPlaybookEnv({ ...base, options: { untilTask: "B" } });
    assert.equal(env.PLAYBOOK_RUNNER_FROM_TASK, "");
    assert.equal(env.PLAYBOOK_RUNNER_UNTIL_TASK, "B");
  });

  it("carries both edges for a single task", () => {
    const env = buildPlaybookEnv({ ...base, options: { fromTask: "it's [x]", untilTask: "it's [x]" } });
    assert.equal(env.PLAYBOOK_RUNNER_FROM_TASK, "it's [x]");
    assert.equal(env.PLAYBOOK_RUNNER_UNTIL_TASK, "it's [x]");
  });

  it("keeps only string setup tags", () => {
    const setupTags = /** @type {string[]} */ (/** @type {unknown} */ ([1, "x", null]));
    const env = buildPlaybookEnv({ ...base, setupTags, options: { fromTask: "A" } });
    assert.equal(env.PLAYBOOK_RUNNER_SETUP_TAGS, '["x"]');
  });
});

describe("validateTaskRange", () => {
  /**
   * @param {string[]} names
   * @param {string | null} [strategy]
   * @param {string | null} [serial]
   * @returns {import("../src/tags").PlaybookOutline}
   */
  const outlineOf = (names, strategy = null, serial = null) => ({
    plays: [
      {
        name: "play",
        hosts: "all",
        tasks: names.map((name, index) => ({
          name,
          bareName: name,
          role: null,
          tags: [],
          file: "/p.yml",
          line: index + 1,
        })),
      },
    ],
    strategy,
    serial,
    skipped: 0,
  });
  const outline = outlineOf(["a", "r : b", "c"]);

  it("accepts no range and a known edge", () => {
    assert.equal(validateTaskRange(outline, {}), null);
    assert.equal(validateTaskRange(outline, { fromTask: "r : b" }), null);
    assert.equal(validateTaskRange(outline, { fromTask: "a", untilTask: "c" }), null);
    assert.equal(validateTaskRange(outline, { fromTask: "c", untilTask: "c" }), null);
  });

  it("refuses an unknown task, naming it", () => {
    const reason = validateTaskRange(outline, { fromTask: "zz" });
    assert.match(String(reason), /zz/);
    assert.match(String(reason), /not found/);
    assert.match(String(validateTaskRange(outline, { untilTask: "yy" })), /yy.*not found/);
  });

  it("refuses an until that comes before the from", () => {
    assert.match(String(validateTaskRange(outline, { fromTask: "c", untilTask: "a" })), /before/);
  });

  it("refuses any range on a playbook that sets strategy", () => {
    const free = outlineOf(["a"], "free");
    assert.match(String(validateTaskRange(free, { fromTask: "a" })), /strategy/);
    assert.equal(validateTaskRange(free, {}), null);
  });

  it("refuses any range on a playbook with a serial play", () => {
    const rolling = outlineOf(["a"], null, "1");
    assert.match(String(validateTaskRange(rolling, { untilTask: "a" })), /serial/);
    assert.equal(validateTaskRange(rolling, {}), null);
  });

  it("takes the first occurrence of until at or after from", () => {
    assert.equal(validateTaskRange(outlineOf(["x", "y", "x"]), { fromTask: "y", untilTask: "x" }), null);
  });
});

describe("describeRun", () => {
  it("names tags and the task range", () => {
    assert.equal(describeRun("p.yml", {}), "p.yml");
    assert.equal(describeRun("p.yml", { tags: "t", fromTask: "A", untilTask: "A" }), "p.yml --tags t only «A»");
    assert.equal(describeRun("p.yml", { fromTask: "A" }), "p.yml from «A»");
    assert.equal(describeRun("p.yml", { untilTask: "B" }), "p.yml until «B»");
    assert.equal(describeRun("p.yml", { fromTask: "A", untilTask: "B" }), "p.yml from «A» until «B»");
  });
});

describe("buildTerminalCommand", () => {
  it("runs in the workspace folder through env -C, with a leading space to stay out of shell history", () => {
    assert.equal(
      buildTerminalCommand({
        cwd: "/repo",
        command: "ansible-playbook",
        argv: ["-i", "inventories/staging/hosts.ini", "playbooks/app/app.yml", "--ask-vault-password"],
        env: {},
      }),
      " env -C /repo ansible-playbook -i inventories/staging/hosts.ini playbooks/app/app.yml --ask-vault-password",
    );
  });

  it("quotes the folder, every env assignment and every argument, but not the command", () => {
    assert.equal(
      buildTerminalCommand({
        cwd: "/home/me/my repo",
        command: "uv run ansible-playbook",
        argv: ["it's a test.yml", "--tags", "a,b"],
        env: { PLAYBOOK_RUNNER_FROM_TASK: "r : it's [x]", ANSIBLE_STRATEGY: "playbook_runner_range" },
      }),
      " env -C '/home/me/my repo' 'PLAYBOOK_RUNNER_FROM_TASK=r : it'\\''s [x]' ANSIBLE_STRATEGY=playbook_runner_range" +
        " uv run ansible-playbook 'it'\\''s a test.yml' --tags a,b",
    );
  });

  it("refuses an env name that is not a plain identifier", () => {
    assert.throws(
      () => buildTerminalCommand({ cwd: "/r", command: "x", argv: [], env: { "A B": "1" } }),
      /A B/,
    );
  });
});
