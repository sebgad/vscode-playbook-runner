/**
 * Tests for the ansible argument vectors, checked against what the shell
 * scripts they replace produced.
 */

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  buildPlaybookArgs,
  buildVaultArgv,
  playbookLabel,
  sanitizeRunOptions,
  shellQuote,
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
