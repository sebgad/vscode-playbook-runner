/**
 * Tests for the service skeleton.
 *
 * These are the calls that write to disk, so the fixture is rebuilt for every
 * test rather than shared: what matters here is what a directory looked like
 * before and after one plan was carried out.
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { afterEach, beforeEach, describe, it } = require("node:test");

const {
  createSkeleton,
  existingServiceNames,
  planService,
  selectEnvironments,
  validateServiceName,
} = require("../src/scaffold");
const { makeFixture, removeFixture, required } = require("./helpers");

/** A repository with two environments that do not hold the same services. */
const FIXTURE = [
  "inventories/production/hosts.ini",
  "inventories/production/group_vars/all/env.yml",
  "inventories/production/group_vars/immich/env.yml",
  "inventories/production/group_vars/immich/vault.yml",
  "inventories/staging/hosts.ini",
  "inventories/staging/group_vars/all/env.yml",
  // No hosts.ini -- must not count as an environment.
  "inventories/notes/README.md",
  "playbooks/immich/immich.yml",
  "playbooks/site.yml",
];

/** @type {string} */
let root = "";

/**
 * @param {import("../src/scaffold").SkeletonPlan} plan
 * @param {string} relative
 */
const entry = (plan, relative) =>
  required(
    plan.entries.find((item) => item.relative === relative.split("/").join(path.sep)),
    `an entry for ${relative}`,
  );

/** @param {string} relative */
const exists = (relative) => fs.existsSync(path.join(root, relative));

beforeEach(() => {
  root = makeFixture(FIXTURE, { prefix: "playbook-runner-scaffold-" });
});

afterEach(() => {
  removeFixture(root);
});

describe("validateServiceName", () => {
  it("accepts a directory name", () => {
    assert.equal(validateServiceName("uptime-kuma"), null);
    assert.equal(validateServiceName("paperless_ngx"), null);
    assert.equal(validateServiceName("  immich  "), null);
  });

  it("rejects anything that is not one", () => {
    for (const name of ["", "   ", "../etc", "a/b", "a\\b", ".hidden", "-lead", "two words"]) {
      assert.equal(typeof validateServiceName(name), "string", `expected ${name} to be rejected`);
    }
  });
});

describe("existingServiceNames", () => {
  it("unions playbook folders and group_vars across environments", () => {
    assert.deepEqual(existingServiceNames(root), ["(root)", "all", "immich"]);
  });

  it("follows the configured directories", () => {
    assert.deepEqual(existingServiceNames(root, { playbooksDir: "nope" }), ["all", "immich"]);
  });
});

describe("planService", () => {
  it("covers the playbook folder once and every environment", () => {
    const plan = planService(root, "uptime-kuma");
    assert.deepEqual(plan.environments, ["production", "staging"]);
    assert.deepEqual(
      plan.entries.map((item) => item.relative.split(path.sep).join("/")),
      [
        "playbooks/uptime-kuma",
        "inventories/production/group_vars/uptime-kuma",
        "inventories/production/group_vars/uptime-kuma/env.yml",
        "inventories/staging/group_vars/uptime-kuma",
        "inventories/staging/group_vars/uptime-kuma/env.yml",
      ],
    );
    assert.deepEqual(
      plan.entries.map((item) => item.type),
      ["directory", "directory", "file", "directory", "file"],
    );
    assert.equal(
      plan.entries.every((item) => item.exists === false),
      true,
    );
  });

  it("plans no vault: that has to be written encrypted", () => {
    const plan = planService(root, "uptime-kuma");
    assert.equal(
      plan.entries.some((item) => item.relative.includes("vault")),
      false,
    );
  });

  it("marks what a half-existing service already has", () => {
    const plan = planService(root, "immich");
    assert.equal(entry(plan, "playbooks/immich").exists, true);
    assert.equal(entry(plan, "inventories/production/group_vars/immich/env.yml").exists, true);
    assert.equal(entry(plan, "inventories/staging/group_vars/immich").exists, false);
    assert.equal(entry(plan, "inventories/staging/group_vars/immich/env.yml").exists, false);
  });

  it("follows the configured layout", () => {
    const plan = planService(root, "uptime-kuma", {
      playbooksDir: "plays",
      envFileName: "vars.yaml",
      groupVarsDir: "group_vars",
    });
    assert.equal(entry(plan, "plays/uptime-kuma").type, "directory");
    assert.equal(
      entry(plan, "inventories/production/group_vars/uptime-kuma/vars.yaml").type,
      "file",
    );
  });

  it("plans the playbook folder alone when there is no environment", () => {
    const plan = planService(root, "uptime-kuma", { inventoriesDir: "nowhere" });
    assert.deepEqual(plan.environments, []);
    assert.equal(plan.entries.length, 1);
  });

  it("is limited to the environments serviceEnvironments names", () => {
    const plan = planService(root, "uptime-kuma", { serviceEnvironments: ["staging"] });
    assert.deepEqual(plan.environments, ["staging"]);
    assert.deepEqual(plan.unknownEnvironments, []);
    assert.equal(plan.limited, true);
    assert.deepEqual(
      plan.entries.map((item) => item.relative.split(path.sep).join("/")),
      [
        "playbooks/uptime-kuma",
        "inventories/staging/group_vars/uptime-kuma",
        "inventories/staging/group_vars/uptime-kuma/env.yml",
      ],
    );
  });

  it("covers every environment when serviceEnvironments is empty", () => {
    const plan = planService(root, "uptime-kuma", { serviceEnvironments: [] });
    assert.deepEqual(plan.environments, ["production", "staging"]);
    assert.equal(plan.limited, false);
  });

  it("reports a listed name that is not an environment instead of creating it", () => {
    // notes/ has no hosts.ini and lab/ does not exist at all.
    const plan = planService(root, "uptime-kuma", {
      serviceEnvironments: ["production", "notes", "lab"],
    });
    assert.deepEqual(plan.environments, ["production"]);
    assert.deepEqual(plan.unknownEnvironments, ["notes", "lab"]);
    assert.equal(
      plan.entries.some((item) => /notes|lab/.test(item.relative)),
      false,
    );

    createSkeleton(plan);
    assert.equal(exists("inventories/notes/group_vars"), false);
    assert.equal(exists("inventories/lab"), false);
  });

  it("plans the playbook folder alone when no listed environment exists", () => {
    const plan = planService(root, "uptime-kuma", { serviceEnvironments: ["lab"] });
    assert.deepEqual(plan.environments, []);
    assert.equal(plan.limited, true);
    assert.equal(plan.entries.length, 1);
  });

  it("refuses a name that is not a directory name", () => {
    assert.throws(() => planService(root, "../etc"), /service name/i);
    assert.equal(exists("../etc"), false);
  });
});

describe("selectEnvironments", () => {
  const environments = [{ name: "production" }, { name: "staging" }, { name: "lab" }];

  it("keeps discovery order, not the order of the setting", () => {
    const { selected } = selectEnvironments(environments, ["lab", "production"]);
    assert.deepEqual(
      selected.map((item) => item.name),
      ["production", "lab"],
    );
  });

  it("ignores entries that are not a non-empty string", () => {
    const { selected, unknown, limited } = selectEnvironments(environments, [42, null, "  ", {}]);
    assert.equal(selected.length, 3);
    assert.deepEqual(unknown, []);
    assert.equal(limited, false);
  });

  it("trims and de-duplicates the names", () => {
    const { selected, unknown } = selectEnvironments(environments, [" staging ", "staging", "qa", "qa"]);
    assert.deepEqual(
      selected.map((item) => item.name),
      ["staging"],
    );
    assert.deepEqual(unknown, ["qa"]);
  });
});

describe("createSkeleton", () => {
  it("creates the directories and empty env files", () => {
    const { created, skipped } = createSkeleton(planService(root, "uptime-kuma"));
    assert.equal(created.length, 5);
    assert.deepEqual(skipped, []);

    assert.equal(fs.statSync(path.join(root, "playbooks/uptime-kuma")).isDirectory(), true);
    for (const env of ["production", "staging"]) {
      const file = path.join(root, `inventories/${env}/group_vars/uptime-kuma/env.yml`);
      assert.equal(fs.readFileSync(file, "utf8"), "");
    }
  });

  it("fills in the environment a service is missing from, leaving the other alone", () => {
    const envFile = path.join(root, "inventories/production/group_vars/immich/env.yml");
    fs.writeFileSync(envFile, "immich_version: 1.2.3\n");

    const { created, skipped } = createSkeleton(planService(root, "immich"));

    assert.deepEqual(
      created.map((item) => item.relative.split(path.sep).join("/")),
      [
        "inventories/staging/group_vars/immich",
        "inventories/staging/group_vars/immich/env.yml",
      ],
    );
    assert.equal(skipped.length, 3);
    // The env file that was already there is untouched, not truncated.
    assert.equal(fs.readFileSync(envFile, "utf8"), "immich_version: 1.2.3\n");
    // And nothing was done to the vault next to it.
    assert.equal(exists("inventories/production/group_vars/immich/vault.yml"), true);
  });

  it("is safe to run twice", () => {
    const plan = planService(root, "uptime-kuma");
    createSkeleton(plan);
    const second = createSkeleton(planService(root, "uptime-kuma"));
    assert.deepEqual(second.created, []);
    assert.equal(second.skipped.length, 5);
  });
});
