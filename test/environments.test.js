/**
 * Tests for adding, renaming and removing an environment.
 *
 * Like the scaffold tests these write to disk, so the fixture is rebuilt for
 * every test: what matters is the tree before and after one plan.
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { afterEach, beforeEach, describe, it } = require("node:test");

const {
  inventoryGroupSkeleton,
  planDelete,
  planEnvironment,
  planRename,
  renameEnvironment,
  renameInSetting,
  validateEnvironmentName,
} = require("../src/environments");
const { findEnvironments } = require("../src/discovery");
const history = require("../src/history");
const { createSkeleton } = require("../src/scaffold");
const { makeFixture, removeFixture, required } = require("./helpers");

const INVENTORY = [
  "# production hosts",
  "lonely.example.org",
  "",
  "[podman_servers]",
  "podman.example.org ansible_user=root",
  "",
  "[immich:children]",
  "podman_servers  # all of them",
  "",
  "[immich:vars]",
  "immich_domain=photos.example.org",
  "",
  "[nfs_servers] ; storage",
  "10.0.0.5",
  "",
].join("\n");

/** @type {(string | [string, string])[]} */
const FIXTURE = [
  ["inventories/production/hosts.ini", INVENTORY],
  ["inventories/production/group_vars/all/env.yml", "domain: example.org\n"],
  ["inventories/production/group_vars/immich/env.yml", "immich_port: 2283\n"],
  ["inventories/production/group_vars/immich/vault.yml", "$ANSIBLE_VAULT;1.1;AES256\n"],
  "inventories/staging/hosts.ini",
  "inventories/staging/group_vars/all/env.yml",
  // No hosts.ini -- not an environment, but the name is taken on disk.
  "inventories/notes/README.md",
  "playbooks/immich/immich.yml",
];

/** @type {string} */
let root = "";

/** @param {string} relative */
const at = (relative) => path.join(root, ...relative.split("/"));

/** @param {string} relative */
const read = (relative) => fs.readFileSync(at(relative), "utf8");

const names = () => findEnvironments(root).map((item) => item.name);

beforeEach(() => {
  root = makeFixture(FIXTURE);
});

afterEach(() => {
  removeFixture(root);
});

describe("validateEnvironmentName", () => {
  it("accepts directory names and refuses anything that is a path", () => {
    for (const name of ["lab", "staging-2", "eu.west_1"]) {
      assert.equal(validateEnvironmentName(name), null);
    }
    for (const name of ["", "  ", "../lab", "a/b", ".hidden", "with space", "-dash", "it's"]) {
      assert.ok(validateEnvironmentName(name), `${JSON.stringify(name)} should be refused`);
    }
  });
});

describe("inventoryGroupSkeleton", () => {
  it("keeps the groups and their children, and no host, variable or comment", () => {
    const skeleton = inventoryGroupSkeleton(INVENTORY);
    assert.equal(skeleton, "[podman_servers]\n\n[immich:children]\npodman_servers\n\n[nfs_servers]\n\n");
    for (const gone of ["example.org", "10.0.0.5", "ansible_user", "immich_domain", "#", ";"]) {
      assert.ok(!skeleton.includes(gone), `${gone} must not be copied`);
    }
  });

  it("lists a group once however often its header appears", () => {
    assert.equal(inventoryGroupSkeleton("[a]\nh1\n[b]\n[a]\nh2\n"), "[a]\n\n[b]\n\n");
  });

  it("is empty for an inventory without groups", () => {
    assert.equal(inventoryGroupSkeleton("host1\nhost2\n"), "");
    assert.equal(inventoryGroupSkeleton(""), "");
  });
});

describe("planEnvironment", () => {
  it("plans an empty environment: directory, inventory, group_vars", () => {
    const plan = planEnvironment(root, " lab ", undefined);
    assert.equal(plan.name, "lab");
    assert.equal(plan.from, null);
    assert.deepEqual(
      plan.entries.map((entry) => [entry.type, entry.relative.split(path.sep).join("/")]),
      [
        ["directory", "inventories/lab"],
        ["file", "inventories/lab/hosts.ini"],
        ["directory", "inventories/lab/group_vars"],
      ],
    );
    assert.ok(plan.entries.every((entry) => !entry.exists));
  });

  it("modelled on an environment, takes its groups and nothing they hold", () => {
    const plan = planEnvironment(root, "lab", undefined, { from: "production" });
    assert.equal(plan.groupsCopied, true);
    createSkeleton(plan);

    assert.deepEqual(names(), ["lab", "production", "staging"]);
    assert.equal(read("inventories/lab/hosts.ini"), inventoryGroupSkeleton(INVENTORY));
    assert.equal(read("inventories/lab/group_vars/all/env.yml"), "");
    assert.equal(read("inventories/lab/group_vars/immich/env.yml"), "");
    assert.equal(fs.existsSync(at("inventories/lab/group_vars/immich/vault.yml")), false);
    // The source is untouched.
    assert.equal(read("inventories/production/hosts.ini"), INVENTORY);
    assert.equal(read("inventories/production/group_vars/immich/env.yml"), "immich_port: 2283\n");
  });

  it("fills in a directory that is there but is not an environment yet", () => {
    const plan = planEnvironment(root, "notes", undefined);
    assert.equal(required(plan.entries[0], "the directory entry").exists, true);
    createSkeleton(plan);
    assert.ok(names().includes("notes"));
    assert.ok(fs.existsSync(at("inventories/notes/README.md")));
  });

  it("does not read groups out of a YAML inventory", () => {
    fs.writeFileSync(at("inventories/production/hosts.yml"), "all:\n  children:\n    web:\n");
    const plan = planEnvironment(root, "lab", { inventoryFile: "hosts.yml" }, { from: "production" });
    assert.equal(plan.groupsCopied, false);
    assert.equal(required(plan.entries[1], "the inventory entry").content, undefined);
  });

  it("refuses an existing environment, a bad name and an unknown source", () => {
    assert.throws(() => planEnvironment(root, "staging", undefined), /already an environment/);
    assert.throws(() => planEnvironment(root, "../lab", undefined), /directory/);
    assert.throws(() => planEnvironment(root, "lab", undefined, { from: "notes" }), /not an environment/);
  });

  it("follows the configured directory and file names", () => {
    const plan = planEnvironment(root, "lab", { inventoriesDir: "inv", inventoryFile: "inventory", groupVarsDir: "gv" });
    assert.deepEqual(
      plan.entries.map((entry) => entry.relative.split(path.sep).join("/")),
      ["inv/lab", "inv/lab/inventory", "inv/lab/gv"],
    );
  });
});

describe("planRename and renameEnvironment", () => {
  it("moves the directory with everything in it", () => {
    const plan = planRename(root, "staging", " lab ", undefined);
    assert.equal(plan.to, "lab");
    renameEnvironment(plan);
    assert.deepEqual(names(), ["lab", "production"]);
    assert.ok(fs.existsSync(at("inventories/lab/group_vars/all/env.yml")));
    assert.equal(fs.existsSync(at("inventories/staging")), false);
  });

  it("refuses a name that is taken, even by a directory that is no environment", () => {
    assert.throws(() => planRename(root, "staging", "production", undefined), /already exists/);
    assert.throws(() => planRename(root, "staging", "notes", undefined), /already exists/);
    assert.throws(() => planRename(root, "staging", "staging", undefined), /already called/);
    assert.throws(() => planRename(root, "staging", "a/b", undefined), /directory/);
    assert.throws(() => planRename(root, "notes", "lab", undefined), /not an environment/);
  });

  it("refuses at the last moment when the target has appeared since the plan", () => {
    const plan = planRename(root, "staging", "lab", undefined);
    fs.mkdirSync(at("inventories/lab"));
    assert.throws(() => renameEnvironment(plan), /already exists/);
    assert.ok(names().includes("staging"));
  });

  it("says when the new name gains or loses the production treatment", () => {
    // No password file pattern: the default one looks into the real home.
    const settings = { productionPattern: "^prod", vaultPasswordFilePattern: "" };
    assert.match(
      required(planRename(root, "production", "live", settings).notes[0], "a note"),
      /no longer ask for confirmation/,
    );
    assert.match(
      required(planRename(root, "staging", "prod-2", settings).notes[0], "a note"),
      /will ask for confirmation/,
    );
    assert.deepEqual(planRename(root, "staging", "lab", settings).notes, []);
  });

  it("says when a password file found through the pattern stops matching", () => {
    fs.writeFileSync(at(".vault-pass-staging"), "x");
    const settings = { vaultPasswordFilePattern: "${workspaceFolder}/.vault-pass-${env}" };
    const notes = planRename(root, "staging", "lab", settings).notes;
    assert.equal(notes.length, 1);
    assert.match(required(notes[0], "a note"), /vaultPasswordFilePattern/);

    // An explicit entry moves with the name, so there is nothing to warn about.
    const explicit = { ...settings, vaultPasswordFiles: { staging: "${workspaceFolder}/.vault-pass-staging" } };
    assert.deepEqual(planRename(root, "staging", "lab", explicit).notes, []);
  });
});

describe("renameInSetting", () => {
  it("renames the key of a map and keeps its place", () => {
    assert.deepEqual(
      Object.entries(/** @type {object} */ (renameInSetting({ a: "1", staging: "2", z: "3" }, "staging", "lab"))),
      [["a", "1"], ["lab", "2"], ["z", "3"]],
    );
  });

  it("lets the renamed entry replace one already under the new name", () => {
    assert.deepEqual(renameInSetting({ lab: "old", staging: "new" }, "staging", "lab"), { lab: "new" });
  });

  it("renames in a list without leaving a duplicate", () => {
    assert.deepEqual(renameInSetting(["production", "staging"], "staging", "lab"), ["production", "lab"]);
    assert.deepEqual(renameInSetting(["lab", "staging"], "staging", "lab"), ["lab"]);
  });

  it("returns undefined when the value does not mention the environment", () => {
    assert.equal(renameInSetting({ production: "x" }, "staging", "lab"), undefined);
    assert.equal(renameInSetting(["production"], "staging", "lab"), undefined);
    assert.equal(renameInSetting(undefined, "staging", "lab"), undefined);
    assert.equal(renameInSetting("staging", "staging", "lab"), undefined);
  });
});

describe("planDelete", () => {
  it("counts what goes, vaults separately", () => {
    const plan = planDelete(root, "production", { productionPattern: "^prod" });
    assert.equal(plan.relative.split(path.sep).join("/"), "inventories/production");
    assert.equal(plan.files, 4);
    assert.equal(plan.vaults, 1);
    assert.equal(plan.isProduction, true);
    assert.equal(plan.isLast, false);
    assert.equal(plan.isLink, false);
    // A plan removes nothing.
    assert.deepEqual(names(), ["production", "staging"]);
  });

  it("flags the last environment and a symlinked one", () => {
    fs.rmSync(at("inventories/production"), { recursive: true });
    assert.equal(planDelete(root, "staging", undefined).isLast, true);

    fs.symlinkSync(at("inventories/staging"), at("inventories/alias"), "dir");
    assert.equal(planDelete(root, "alias", undefined).isLink, true);
  });

  it("refuses what is not an environment", () => {
    assert.throws(() => planDelete(root, "notes", undefined), /not an environment/);
    assert.throws(() => planDelete(root, "../playbooks", undefined), /not an environment/);
  });
});

describe("history.renameEnvironment", () => {
  it("moves the runs of that folder's environment and no others", () => {
    /** @type {import("../src/history").RunEntry[]} */
    const entries = [
      { id: "1", folder: "/a", environment: "staging", playbook: "/a/p.yml", label: "p", options: {}, startedAt: 1, status: "passed" },
      { id: "2", folder: "/a", environment: "production", playbook: "/a/p.yml", label: "p", options: {}, startedAt: 2, status: "passed" },
      { id: "3", folder: "/b", environment: "staging", playbook: "/b/p.yml", label: "p", options: {}, startedAt: 3, status: "failed" },
    ];
    assert.deepEqual(
      history.renameEnvironment(entries, "/a", "staging", "lab").map((entry) => entry.environment),
      ["lab", "production", "staging"],
    );
  });
});
