/**
 * Tests for what the dashboard's Settings tab may write.
 *
 * Every value the page sends comes through validateSettingValue before it
 * reaches WorkspaceConfiguration.update, and every target through
 * settingTarget -- so these are the lines that keep a repository's settings
 * file from naming an executable, and a typo from switching the production
 * confirmation off.
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const DEFAULTS = require("../src/defaults");
const {
  MACHINE_SETTINGS,
  SETTING_GROUPS,
  moveSettingToUser,
  settingTarget,
  validateSettingValue,
} = require("../src/settingsEdit");
/** @type {{ contributes: { configuration: { properties: Record<string, { scope?: string }> } } }} */
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

describe("settings edit", () => {
  it("MACHINE_SETTINGS matches package.json", () => {
    const machine = Object.entries(packageJson.contributes.configuration.properties)
      .filter(([, spec]) => spec.scope === "machine")
      .map(([key]) => key.replace(/^playbookRunner\./, ""))
      .sort();
    assert.deepEqual([...MACHINE_SETTINGS].sort(), machine);
  });

  it("SETTING_GROUPS covers every setting exactly once", () => {
    const keys = SETTING_GROUPS.flatMap((group) => group.keys).sort();
    assert.deepEqual(keys, Object.keys(DEFAULTS).sort());
  });

  it("validateSettingValue accepts each type", () => {
    assert.deepEqual(validateSettingValue("playbooksDir", " plays "), { ok: true, value: "plays" });
    assert.deepEqual(validateSettingValue("confirmProduction", false), { ok: true, value: false });
    assert.deepEqual(validateSettingValue("setupTags", [" a ", "", "a", "b"]), { ok: true, value: ["a", "b"] });
    assert.deepEqual(validateSettingValue("vaultPasswordFiles", { staging: "~/s.pass" }), {
      ok: true,
      value: { staging: "~/s.pass" },
    });
    assert.deepEqual(validateSettingValue("productionPattern", ""), { ok: true, value: "" });
  });

  it("validateSettingValue rejects", () => {
    /** @type {[string, unknown][]} */
    const cases = [
      ["nope", "x"],
      ["python.defaultInterpreterPath", "x"],
      ["confirmProduction", "yes"],
      ["setupTags", "a,b"],
      ["setupTags", [1]],
      ["vaultPasswordFiles", { staging: "" }],
      ["vaultPasswordFiles", { "": "x" }],
      ["vaultPasswordFiles", ["x"]],
      ["productionPattern", "(prod"],
      ["playbooksDir", ""],
    ];
    for (const [key, value] of cases) {
      const result = validateSettingValue(key, value);
      assert.equal(result.ok, false, `${key} = ${JSON.stringify(value)} should be refused`);
      assert.ok(!result.ok && result.error.length > 0);
    }
    const regex = validateSettingValue("productionPattern", "(prod");
    assert.ok(!regex.ok && /unterminated|group|\(/i.test(regex.error), JSON.stringify(regex));
  });

  it("settingTarget forces user for machine settings", () => {
    assert.equal(settingTarget("ansiblePlaybookCommand", "workspace"), "user");
    assert.equal(settingTarget("playbooksDir", "workspace"), "workspace");
    assert.equal(settingTarget("playbooksDir", "user"), "user");
  });
});

describe("moveSettingToUser", () => {
  /** @returns {{ calls: [unknown, string][], update: (value: unknown, target: "workspace" | "user") => Promise<void> }} */
  const recorder = (failOn = "") => {
    /** @type {[unknown, string][]} */
    const calls = [];
    return {
      calls,
      update: async (value, target) => {
        if (target === failOn) {
          throw new Error(`cannot write ${target} settings`);
        }
        calls.push([value, target]);
      },
    };
  };

  it("saves to User first, then removes the workspace value", async () => {
    const r = recorder();
    assert.equal(await moveSettingToUser("setupTags", [" a "], r.update), null);
    assert.deepEqual(r.calls, [
      [["a"], "user"],
      [undefined, "workspace"],
    ]);
  });

  it("keeps the workspace value when the User write fails", async () => {
    const r = recorder("user");
    const error = await moveSettingToUser("playbooksDir", "plays", r.update);
    assert.match(String(error), /cannot write user/);
    assert.deepEqual(r.calls, []);
  });

  it("writes nothing for a workspace value that would not validate", async () => {
    const r = recorder();
    assert.match(String(await moveSettingToUser("productionPattern", "(prod", r.update)), /regular expression/);
    assert.match(String(await moveSettingToUser("playbooksDir", undefined, r.update)), /no workspace value/);
    assert.match(String(await moveSettingToUser("ansiblePlaybookCommand", "x", r.update)), /User/);
    assert.match(String(await moveSettingToUser("nope", "x", r.update)), /not a Playbook Runner setting/);
    assert.deepEqual(r.calls, []);
  });
});
