/**
 * Tests for the dashboard model and for what the webview may ask of the
 * extension. Every message from the webview is treated as untrusted: it is a
 * page that renders data, and nothing it sends is allowed to name a file or a
 * flag the extension did not already offer it.
 */

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const { buildPlaybookArgs, buildPlaybookEnv } = require("../src/command");
const DEFAULTS = require("../src/defaults");
const {
  buildDashboardModel,
  buildPreview,
  findOfferedPlaybook,
  parseWebviewMessage,
  resolveEnvironmentRequest,
  resolveFolderRequest,
  resolveVaultRequest,
  resolveOpenRequest,
  resolveRunRequest,
  STATUS_FILE_PLACEHOLDER,
} = require("../src/model");
const { resolveVaultPasswordFile } = require("../src/paths");
const { findPlaybookOutline } = require("../src/tags");
const { makeFixture, removeFixture, required } = require("./helpers");

/** @type {(string | [string, string])[]} */
const FIXTURE = [
  "inventories/staging/hosts.ini",
  "inventories/production/hosts.ini",
  "inventories/staging/group_vars/app/env.yml",
  "inventories/staging/group_vars/app/vault.yml",
  "inventories/staging/group_vars/all/env.yml",
  [
    "playbooks/app/app.yml",
    "- name: Deploy\n  hosts: all\n  tasks:\n    - name: first\n      ansible.builtin.import_role:\n        name: r\n    - name: last\n      debug: msg=x\n",
  ],
  ["roles/r/tasks/main.yml", "- name: in role\n  debug: msg=r\n"],
  ["playbooks/web/site.yml", "- hosts: all\n  tasks:\n    - name: one\n      debug: msg=1\n"],
];

describe("dashboard model", () => {
  /** @type {string} */
  let root;
  /** @type {ReturnType<typeof buildDashboardModel>} */
  let model;
  /** @type {string} */
  let appFile;

  const readSettingsFor = () => ({ ...DEFAULTS });

  before(() => {
    root = makeFixture(FIXTURE, { prefix: "playbook-runner-model-" });
    appFile = path.join(root, "playbooks/app/app.yml");
    model = buildDashboardModel([{ name: "repo", path: root }], readSettingsFor, [
      {
        id: "1",
        folder: root,
        environment: "staging",
        playbook: appFile,
        label: "app/app.yml",
        options: {},
        startedAt: 1,
        status: "passed",
      },
    ]);
  });

  after(() => removeFixture(root));

  /** @param {string} name */
  const environment = (name) =>
    required(model.folders[0]?.environments.find((item) => item.name === name), name);

  describe("buildDashboardModel", () => {
    it("lists every environment, marking production by the configured pattern", () => {
      assert.deepEqual(
        model.folders[0]?.environments.map((item) => [item.name, item.isProduction]),
        [
          ["production", true],
          ["staging", false],
        ],
      );
    });

    it("lists services in discovery order with their playbooks and vars", () => {
      const staging = environment("staging");
      assert.deepEqual(
        staging.services.map((service) => service.name),
        ["all", "app", "web"],
      );
      const app = required(staging.services.find((s) => s.name === "app"), "app");
      assert.equal(app.hasEnv, true);
      assert.equal(app.hasVault, true);
      assert.equal(app.envFile, path.join(root, "inventories/staging/group_vars/app/env.yml"));
      assert.equal(environment("production").services[0]?.hasEnv, false);
    });

    it("attaches the newest run of each playbook in that environment, and nothing elsewhere", () => {
      const app = required(
        environment("staging").services.find((s) => s.name === "app")?.playbooks[0],
        "app.yml",
      );
      assert.equal(app.label, "app/app.yml");
      assert.equal(app.latest?.id, "1");
      assert.equal(environment("production").services[0]?.playbooks[0]?.latest, null);
    });

    it("lists a vars-only service with its vault path, and no vault path without group_vars", () => {
      const all = required(environment("staging").services.find((s) => s.name === "all"), "all");
      assert.deepEqual(all.playbooks, []);
      assert.equal(all.hasVault, false);
      assert.equal(all.vaultFile, path.join(root, "inventories/staging/group_vars/all/vault.yml"));
      const prodApp = required(environment("production").services.find((s) => s.name === "app"), "app");
      assert.equal(prodApp.vaultFile, null);
    });

    it("carries no outlines -- those are asked for per playbook", () => {
      assert.ok(!JSON.stringify(model).includes("in role"));
    });
  });

  describe("parseWebviewMessage", () => {
    it("accepts each message type in its exact shape", () => {
      assert.deepEqual(parseWebviewMessage({ type: "ready" }), { type: "ready" });
      assert.deepEqual(parseWebviewMessage({ type: "outline", folder: "/f", playbook: "/p" }), {
        type: "outline",
        folder: "/f",
        playbook: "/p",
      });
      assert.deepEqual(
        parseWebviewMessage({
          type: "run",
          folder: "/f",
          environment: "staging",
          playbook: "/p",
          options: { check: true, fromTask: "a" },
          extra: "dropped",
        }),
        { type: "run", folder: "/f", environment: "staging", playbook: "/p", options: { check: true, fromTask: "a" } },
      );
      assert.deepEqual(parseWebviewMessage({ type: "open", folder: "/f", playbook: "/p", file: "/x", line: 3 }), {
        type: "open",
        folder: "/f",
        playbook: "/p",
        file: "/x",
        line: 3,
      });
    });

    it("rejects unknown types, missing or non-string fields and a bad line", () => {
      assert.equal(parseWebviewMessage(null), null);
      assert.equal(parseWebviewMessage({ type: "exec", command: "rm" }), null);
      assert.equal(parseWebviewMessage({ type: "outline", folder: 1, playbook: "/p" }), null);
      assert.equal(parseWebviewMessage({ type: "run", folder: "/f", playbook: "/p", options: {} }), null);
      assert.equal(parseWebviewMessage({ type: "open", folder: "/f", playbook: "", file: "/x", line: -1 }), null);
      assert.equal(parseWebviewMessage({ type: "open", folder: "/f", playbook: "", file: "/x", line: 1.5 }), null);
    });

    it("never lets the webview pass extraArgs", () => {
      const message = parseWebviewMessage({
        type: "preview",
        folder: "/f",
        environment: "staging",
        playbook: "/p",
        options: { extraArgs: ["--become-password-file", "/x"], tags: "t" },
      });
      assert.deepEqual(message && "options" in message ? message.options : null, { tags: "t" });
    });
  });

  describe("new action messages", () => {
    it("parseWebviewMessage accepts the new types and rejects a bad action", () => {
      const vault = { type: "vault", folder: "/f", environment: "staging", service: "app", action: "edit" };
      assert.deepEqual(parseWebviewMessage({ ...vault, extra: 1 }), vault);
      assert.deepEqual(parseWebviewMessage({ type: "rekey", folder: "/f", environment: "staging" }), {
        type: "rekey",
        folder: "/f",
        environment: "staging",
      });
      assert.deepEqual(parseWebviewMessage({ type: "createService", folder: "/f" }), {
        type: "createService",
        folder: "/f",
      });
      assert.deepEqual(parseWebviewMessage({ type: "rerunLast" }), { type: "rerunLast" });
      assert.deepEqual(parseWebviewMessage({ type: "openSettings" }), { type: "openSettings" });
      assert.equal(parseWebviewMessage({ ...vault, action: "delete" }), null);
      assert.equal(parseWebviewMessage({ ...vault, service: undefined }), null);
      assert.equal(parseWebviewMessage({ type: "rekey", folder: "/f" }), null);
      assert.equal(parseWebviewMessage({ type: "createService" }), null);
    });

    /** @param {Record<string, unknown>} fields */
    const vault = (fields) =>
      /** @type {import("../src/model").WebviewMessage} */ ({
        type: "vault",
        folder: root,
        environment: "staging",
        service: "app",
        action: "edit",
        ...fields,
      });

    it("parses setSetting and resetSetting, refusing another target or a non-string key", () => {
      assert.deepEqual(
        parseWebviewMessage({ type: "setSetting", key: "playbooksDir", value: ["x"], target: "user", extra: 1 }),
        { type: "setSetting", key: "playbooksDir", value: ["x"], target: "user" },
      );
      assert.deepEqual(parseWebviewMessage({ type: "resetSetting", key: "setupTags", target: "workspace" }), {
        type: "resetSetting",
        key: "setupTags",
        target: "workspace",
      });
      assert.equal(parseWebviewMessage({ type: "setSetting", key: "a", value: 1, target: "folder" }), null);
      assert.equal(parseWebviewMessage({ type: "resetSetting", key: 3, target: "user" }), null);
      assert.deepEqual(parseWebviewMessage({ type: "moveSetting", key: "setupTags", extra: 1 }), {
        type: "moveSetting",
        key: "setupTags",
      });
      assert.equal(parseWebviewMessage({ type: "moveSetting" }), null);
    });

    it("resolveVaultRequest resolves a service that has the vault the action needs", () => {
      const resolved = required(resolveVaultRequest(model, vault({})), "edit app");
      assert.equal(resolved.service.vaultFile, path.join(root, "inventories/staging/group_vars/app/vault.yml"));
      assert.equal(resolved.environment.name, "staging");
      assert.ok(resolveVaultRequest(model, vault({ service: "all", action: "create" })));
    });

    it("resolveVaultRequest rejects", () => {
      assert.equal(resolveVaultRequest(model, vault({ environment: "production" })), null);
      assert.equal(resolveVaultRequest(model, vault({ service: "nope" })), null);
      assert.equal(resolveVaultRequest(model, vault({ action: "create" })), null);
      assert.equal(resolveVaultRequest(model, vault({ service: "all", action: "edit" })), null);
      assert.equal(resolveVaultRequest(model, vault({ folder: "/elsewhere" })), null);
      assert.equal(resolveVaultRequest(model, vault({ service: "web" })), null);
    });

    it("resolveEnvironmentRequest and resolveFolderRequest accept only what is open", () => {
      assert.equal(resolveEnvironmentRequest(model, root, "staging")?.environment.name, "staging");
      assert.equal(resolveEnvironmentRequest(model, root, "lab"), null);
      assert.equal(resolveEnvironmentRequest(model, "/elsewhere", "staging"), null);
      assert.equal(resolveFolderRequest(model, root)?.path, root);
      assert.equal(resolveFolderRequest(model, "/elsewhere"), null);
    });
  });

  describe("resolveRunRequest", () => {
    /** @param {Record<string, unknown>} fields */
    const request = (fields) =>
      /** @type {import("../src/model").WebviewMessage} */ ({
        type: "run",
        folder: root,
        environment: "staging",
        playbook: appFile,
        options: {},
        ...fields,
      });

    it("resolves a playbook the model offered", () => {
      const resolved = required(resolveRunRequest(model, request({})), "resolved");
      assert.equal(resolved.folder.path, root);
      assert.equal(resolved.environment.name, "staging");
      assert.equal(resolved.playbook.file, appFile);
    });

    it("resolveRunRequest rejects anything it did not offer", () => {
      assert.equal(resolveRunRequest(model, request({ playbook: "/etc/passwd" })), null);
      assert.equal(
        resolveRunRequest(model, request({ playbook: `${root}/playbooks/app/../../x.yml` })),
        null,
      );
      assert.equal(
        resolveRunRequest(model, request({ playbook: `${root}/playbooks/web/../app/app.yml` })),
        null,
      );
      assert.equal(resolveRunRequest(model, request({ environment: "lab" })), null);
      assert.equal(resolveRunRequest(model, request({ folder: "/elsewhere" })), null);
    });
  });

  describe("findOfferedPlaybook", () => {
    it("finds a playbook the model offered in that folder, and nothing else", () => {
      assert.equal(findOfferedPlaybook(model, root, appFile)?.path, root);
      assert.equal(findOfferedPlaybook(model, root, "/etc/passwd"), null);
      assert.equal(findOfferedPlaybook(model, "/elsewhere", appFile), null);
      assert.equal(findOfferedPlaybook(model, root, `${root}/playbooks/web/../app/app.yml`), null);
    });
  });

  describe("resolveOpenRequest", () => {
    /** @param {string} folderPath @param {string} playbook */
    const outlineFor = (folderPath, playbook) => findPlaybookOutline(folderPath, playbook);
    /** @param {Record<string, unknown>} fields */
    const open = (fields) =>
      /** @type {import("../src/model").WebviewMessage} */ ({
        type: "open",
        folder: root,
        playbook: appFile,
        file: appFile,
        line: 1,
        ...fields,
      });

    it("opens a known playbook, an env file, and a task file from that playbook's outline", () => {
      assert.deepEqual(resolveOpenRequest(model, open({ line: 4 }), outlineFor), { file: appFile, line: 4 });
      const env = path.join(root, "inventories/staging/group_vars/app/env.yml");
      assert.deepEqual(resolveOpenRequest(model, open({ playbook: "", file: env }), outlineFor), {
        file: env,
        line: 1,
      });
      const roleFile = path.join(root, "roles/r/tasks/main.yml");
      assert.deepEqual(resolveOpenRequest(model, open({ file: roleFile }), outlineFor), {
        file: roleFile,
        line: 1,
      });
    });

    it("refuses a file outside what it offered, and a vault", () => {
      assert.equal(resolveOpenRequest(model, open({ file: "/etc/passwd" }), outlineFor), null);
      const vault = path.join(root, "inventories/staging/group_vars/app/vault.yml");
      assert.equal(resolveOpenRequest(model, open({ file: vault }), outlineFor), null);
      const roleFile = path.join(root, "roles/r/tasks/main.yml");
      const site = path.join(root, "playbooks/web/site.yml");
      assert.equal(resolveOpenRequest(model, open({ playbook: site, file: roleFile }), outlineFor), null);
    });
  });

  describe("buildPreview", () => {
    it("shows exactly the argv and env a run would get, with a placeholder status file", () => {
      const settings = { ...DEFAULTS };
      const staging = environment("staging");
      const options = { fromTask: "r : in role", check: true };
      const outline = findPlaybookOutline(root, appFile);
      const preview = buildPreview({
        root,
        environment: staging,
        playbookFile: appFile,
        settings,
        options,
        outline,
        pluginDir: "/ext/ansible/strategy",
      });
      assert.deepEqual(
        preview.argv,
        buildPlaybookArgs({
          inventory: "inventories/staging/hosts.ini",
          playbook: "playbooks/app/app.yml",
          vaultPasswordFile: resolveVaultPasswordFile(settings, "staging", root),
          options,
        }),
      );
      assert.deepEqual(
        preview.env,
        buildPlaybookEnv({
          options,
          setupTags: settings.setupTags,
          pluginDir: "/ext/ansible/strategy",
          statusFile: STATUS_FILE_PLACEHOLDER,
        }),
      );
      assert.equal(preview.error, null);
    });

    it("reports a range it would refuse, still showing the command", () => {
      const preview = buildPreview({
        root,
        environment: environment("staging"),
        playbookFile: appFile,
        settings: { ...DEFAULTS },
        options: { fromTask: "last", untilTask: "first" },
        outline: findPlaybookOutline(root, appFile),
        pluginDir: "/p",
      });
      assert.match(String(preview.error), /not found|before/);
      assert.ok(preview.argv.length > 0);
    });
  });
});
