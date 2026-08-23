/**
 * Tests for the path and pattern rules.
 *
 * These decide which file ansible is handed as a vault password -- and which
 * environments get a confirmation before anything runs -- so they are worth
 * pinning down away from vscode.
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const DEFAULTS = require("../src/defaults");
const {
  compileProductionPattern,
  expandPath,
  isProductionName,
  resolveVaultPasswordFile,
} = require("../src/paths");
const { makeFixture, removeFixture } = require("./helpers");

/** @type {string} */
let root = "";

/** @param {Partial<import("../src/defaults").Settings>} overrides */
const settingsWith = (overrides) => ({ ...DEFAULTS, ...overrides });

before(() => {
  root = makeFixture(["secrets/production.pass", "hosts.ini"], { prefix: "homelab-paths-" });
});

after(() => {
  removeFixture(root);
});

describe("expandPath", () => {
  it("expands the three supported variables", () => {
    assert.equal(
      expandPath("${workspaceFolder}/${env}.pass", { folderPath: "/repo", env: "staging" }),
      "/repo/staging.pass",
    );
    assert.equal(expandPath("${userHome}/x"), path.join(os.homedir(), "x"));
  });

  it("accepts ${environment} as a spelling of ${env}", () => {
    assert.equal(expandPath("${environment}.pass", { env: "production" }), "production.pass");
  });

  it("expands a leading tilde, and only a leading one", () => {
    assert.equal(expandPath("~"), os.homedir());
    assert.equal(expandPath("~/.ansible-vault/x.pass"), path.join(os.homedir(), ".ansible-vault/x.pass"));
    assert.equal(expandPath("/tmp/~/x"), "/tmp/~/x");
  });

  it("substitutes an empty string for variables it was given no value for", () => {
    assert.equal(expandPath("${workspaceFolder}/${env}"), "/");
  });

  it("returns an empty string for an empty template", () => {
    assert.equal(expandPath(""), "");
  });
});

describe("resolveVaultPasswordFile", () => {
  it("uses the pattern when the file it names exists", () => {
    const settings = settingsWith({
      vaultPasswordFilePattern: "${workspaceFolder}/secrets/${env}.pass",
    });
    assert.equal(
      resolveVaultPasswordFile(settings, "production", root),
      path.join(root, "secrets/production.pass"),
    );
  });

  it("falls back to prompting when the file does not exist", () => {
    const settings = settingsWith({
      vaultPasswordFilePattern: "${workspaceFolder}/secrets/${env}.pass",
    });
    assert.equal(resolveVaultPasswordFile(settings, "staging", root), null);
  });

  it("prefers an explicit per-environment entry over the pattern", () => {
    const settings = settingsWith({
      vaultPasswordFilePattern: "${workspaceFolder}/secrets/nothing.pass",
      vaultPasswordFiles: { staging: "${workspaceFolder}/secrets/production.pass" },
    });
    assert.equal(
      resolveVaultPasswordFile(settings, "staging", root),
      path.join(root, "secrets/production.pass"),
    );
  });

  it("ignores an entry that is not a string, and an empty pattern", () => {
    const broken = settingsWith({
      vaultPasswordFilePattern: "${workspaceFolder}/secrets/${env}.pass",
      vaultPasswordFiles: /** @type {any} */ ({ production: 42 }),
    });
    assert.equal(
      resolveVaultPasswordFile(broken, "production", root),
      path.join(root, "secrets/production.pass"),
    );
    assert.equal(
      resolveVaultPasswordFile(settingsWith({ vaultPasswordFilePattern: "" }), "production", root),
      null,
    );
  });

  it("resolves a relative pattern against the workspace folder", () => {
    const settings = settingsWith({ vaultPasswordFilePattern: "secrets/${env}.pass" });
    assert.equal(
      resolveVaultPasswordFile(settings, "production", root),
      path.join(root, "secrets/production.pass"),
    );
  });

  it("does not accept a directory as a password file", () => {
    const settings = settingsWith({ vaultPasswordFilePattern: "secrets" });
    assert.equal(resolveVaultPasswordFile(settings, "production", root), null);
    assert.equal(fs.existsSync(path.join(root, "secrets")), true);
  });
});

describe("compileProductionPattern", () => {
  it("matches case-insensitively", () => {
    const { pattern } = compileProductionPattern("production");
    assert.equal(Boolean(pattern && pattern.test("PRODUCTION")), true);
    assert.equal(Boolean(pattern && pattern.test("staging")), false);
  });

  it("switches the treatment off for an empty pattern, without an error", () => {
    assert.deepEqual(compileProductionPattern(""), { pattern: null, error: null });
  });

  it("reports a pattern that does not compile instead of throwing", () => {
    const { pattern, error } = compileProductionPattern("prod(");
    assert.equal(pattern, null);
    assert.equal(typeof error, "string");
  });
});

describe("isProductionName", () => {
  it("follows the configured pattern", () => {
    assert.equal(isProductionName(DEFAULTS, "production"), true);
    assert.equal(isProductionName(DEFAULTS, "staging"), false);
    assert.equal(isProductionName(settingsWith({ productionPattern: "^live" }), "live-1"), true);
  });

  it("treats nothing as production when the pattern is broken or empty", () => {
    assert.equal(isProductionName(settingsWith({ productionPattern: "prod(" }), "production"), false);
    assert.equal(isProductionName(settingsWith({ productionPattern: "" }), "production"), false);
  });
});
