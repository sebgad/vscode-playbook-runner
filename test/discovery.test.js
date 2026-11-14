/**
 * Tests for the discovery layer.
 *
 * Run with `npm test` (node --test). The fixture repository is built in a
 * temporary directory rather than committed, so the tree it describes stays
 * readable in one place.
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const {
  ROOT_GROUP,
  findEnvironments,
  findPlaybooks,
  findServices,
  findVaultGroups,
  listPlaybookFiles,
} = require("../src/discovery");
const { makeFixture, removeFixture, required } = require("./helpers");

/** The fixture, as paths relative to the repository root. */
const FIXTURE = [
  "inventories/production/hosts.ini",
  "inventories/production/group_vars/all/env.yml",
  "inventories/production/group_vars/authentik/env.yml",
  "inventories/production/group_vars/authentik/vault.yml",
  "inventories/production/group_vars/homepage/env.yml",
  "inventories/staging/hosts.ini",
  "inventories/staging/group_vars/authentik/vault.yml",
  // No hosts.ini -- must not count as an environment.
  "inventories/notes/README.md",
  "playbooks/authentik/authentik.yml",
  "playbooks/dns_servers/setup-bind9.yml",
  "playbooks/dns_servers/setup-dns-zones.yml",
  "playbooks/dns_servers/nested/extra.yaml",
  "playbooks/site.yml",
  "playbooks/empty/.gitkeep",
];

/** @type {string} */
let root = "";

/** @param {string} name */
const environment = (name) =>
  required(
    findEnvironments(root).find((item) => item.name === name),
    `environment ${name}`,
  );

before(() => {
  root = makeFixture(FIXTURE, { prefix: "playbook-runner-discovery-" });
});

after(() => {
  removeFixture(root);
});

describe("findEnvironments", () => {
  it("returns every directory holding the inventory file, sorted", () => {
    const names = findEnvironments(root).map((item) => item.name);
    assert.deepEqual(names, ["production", "staging"]);
  });

  it("resolves the inventory and group_vars paths", () => {
    const production = environment("production");
    assert.equal(production.inventory, path.join(root, "inventories/production/hosts.ini"));
    assert.equal(
      production.groupVarsDir,
      path.join(root, "inventories/production/group_vars"),
    );
  });

  it("honours a different layout without code changes", () => {
    const custom = findEnvironments(root, { inventoryFile: "README.md" });
    assert.deepEqual(
      custom.map((item) => item.name),
      ["notes"],
    );
  });

  it("returns nothing when the inventories directory is missing", () => {
    assert.deepEqual(findEnvironments(root, { inventoriesDir: "nope" }), []);
  });
});

describe("findPlaybooks", () => {
  it("groups by subfolder and collects loose playbooks under (root)", () => {
    const names = findPlaybooks(root).map((group) => group.name);
    assert.deepEqual(names, [ROOT_GROUP, "authentik", "dns_servers"]);
  });

  it("recurses into nested folders and accepts .yaml", () => {
    const dns = required(
      findPlaybooks(root).find((group) => group.name === "dns_servers"),
      "the dns_servers group",
    );
    assert.deepEqual(
      dns.playbooks.map((playbook) => playbook.name),
      [path.join("nested", "extra.yaml"), "setup-bind9.yml", "setup-dns-zones.yml"],
    );
  });

  it("does not recurse for the (root) group", () => {
    const loose = required(
      findPlaybooks(root).find((group) => group.name === ROOT_GROUP),
      "the (root) group",
    );
    assert.deepEqual(
      loose.playbooks.map((playbook) => playbook.name),
      ["site.yml"],
    );
  });

  it("leaves out folders without a playbook", () => {
    assert.equal(
      findPlaybooks(root).some((group) => group.name === "empty"),
      false,
    );
  });

  it("returns nothing when the playbooks directory is missing", () => {
    assert.deepEqual(findPlaybooks(root, { playbooksDir: "nope" }), []);
  });
});

describe("listPlaybookFiles", () => {
  it("follows a symlinked directory but stops at a cycle", (t) => {
    const repo = makeFixture(["a/one.yml", "a/deeper/two.yml"], {
      prefix: "playbook-runner-symlink-",
    });
    const elsewhere = makeFixture(["extra.yml"], { prefix: "playbook-runner-linked-" });
    t.after(() => {
      removeFixture(repo);
      removeFixture(elsewhere);
    });

    try {
      // shared -> a directory outside the walk, which is worth following, and
      // a/deeper/loop -> the walk root, which is where a naive walk never ends.
      fs.symlinkSync(elsewhere, path.join(repo, "shared"), "dir");
      fs.symlinkSync(repo, path.join(repo, "a/deeper/loop"), "dir");
    } catch {
      t.skip("symlinks are not available here");
      return;
    }

    assert.deepEqual(
      listPlaybookFiles(repo).map((playbook) => playbook.name),
      [
        path.join("a", "deeper", "two.yml"),
        path.join("a", "one.yml"),
        path.join("shared", "extra.yml"),
      ],
    );
  });
});

describe("findServices", () => {
  it("unions playbook folders and group_vars groups, (root) first", () => {
    const names = findServices(root, environment("production")).map((item) => item.name);
    assert.deepEqual(names, [ROOT_GROUP, "all", "authentik", "dns_servers", "homepage"]);
  });

  it("carries both halves for a service that has them", () => {
    const authentik = required(
      findServices(root, environment("production")).find(
        (service) => service.name === "authentik",
      ),
      "the authentik service",
    );

    assert.deepEqual(
      authentik.playbooks.map((playbook) => playbook.name),
      ["authentik.yml"],
    );
    assert.equal(authentik.playbooksDir, path.join(root, "playbooks/authentik"));
    assert.equal(required(authentik.vars, "authentik vars").hasEnv, true);
    assert.equal(required(authentik.vars, "authentik vars").hasVault, true);
  });

  it("keeps a service that only has variables", () => {
    const all = required(
      findServices(root, environment("production")).find((service) => service.name === "all"),
      "the all service",
    );
    assert.deepEqual(all.playbooks, []);
    assert.equal(all.playbooksDir, null);
    assert.equal(required(all.vars, "all vars").hasEnv, true);
    assert.equal(required(all.vars, "all vars").hasVault, false);
  });

  it("keeps a service that only has playbooks", () => {
    const dns = required(
      findServices(root, environment("production")).find(
        (service) => service.name === "dns_servers",
      ),
      "the dns_servers service",
    );
    assert.equal(dns.vars, null);
    assert.equal(dns.playbooks.length, 3);
  });

  it("reports a vault without an env file", () => {
    const authentik = required(
      findServices(root, environment("staging")).find(
        (service) => service.name === "authentik",
      ),
      "the authentik service",
    );
    assert.equal(required(authentik.vars, "authentik vars").hasEnv, false);
    assert.equal(required(authentik.vars, "authentik vars").hasVault, true);
  });

  it("sees a different set of vaults per environment", () => {
    const names = findServices(root, environment("staging")).map((service) => service.name);
    assert.deepEqual(names, [ROOT_GROUP, "authentik", "dns_servers"]);
  });

  it("falls back to the playbooks alone without an environment", () => {
    const names = findServices(root, undefined).map((service) => service.name);
    assert.deepEqual(names, [ROOT_GROUP, "authentik", "dns_servers"]);
  });
});

describe("findVaultGroups", () => {
  it("splits groups by whether a vault already exists", () => {
    const groups = findVaultGroups(environment("production"));

    assert.deepEqual(
      groups.map((group) => [group.name, group.hasVault]),
      [
        ["all", false],
        ["authentik", true],
        ["homepage", false],
      ],
    );
  });

  it("points at the vault path even when it does not exist yet", () => {
    const homepage = required(
      findVaultGroups(environment("production")).find((group) => group.name === "homepage"),
      "the homepage group",
    );
    assert.equal(
      homepage.vaultFile,
      path.join(root, "inventories/production/group_vars/homepage/vault.yml"),
    );
  });

  it("resolves the env file alongside the vault", () => {
    const authentik = required(
      findVaultGroups(environment("production")).find((group) => group.name === "authentik"),
      "the authentik group",
    );
    assert.equal(
      authentik.envFile,
      path.join(root, "inventories/production/group_vars/authentik/env.yml"),
    );
    assert.equal(authentik.hasEnv, true);

    const staging = required(
      findVaultGroups(environment("staging")).find((group) => group.name === "authentik"),
      "the staging authentik group",
    );
    assert.equal(staging.hasEnv, false);
  });

  it("honours a different env filename", () => {
    const groups = findVaultGroups(environment("production"), { envFileName: "nope.yml" });
    assert.equal(
      groups.every((group) => group.hasEnv === false),
      true,
    );
  });

  it("returns nothing for an environment without group_vars", () => {
    const notes = {
      name: "notes",
      dir: path.join(root, "inventories/notes"),
      inventory: path.join(root, "inventories/notes/README.md"),
      groupVarsDir: path.join(root, "inventories/notes/group_vars"),
    };
    assert.deepEqual(findVaultGroups(notes), []);
  });

  it("returns nothing without an environment at all", () => {
    assert.deepEqual(findVaultGroups(undefined), []);
  });
});
