/**
 * The inventory writer against the real ansible-inventory: for each fixture,
 * `ansible-inventory --list` of the original text and of
 * `serializeInventory(parseInventory(text))` must be the same JSON. Fake hosts
 * in temp files only; nothing is connected to. Without an ansible-inventory
 * (this repository's .venv first, then PATH) the suite is skipped, not passed.
 */

"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const { MANUAL_BEGIN, MANUAL_END, parseInventory, serializeInventory } = require("../src/inventory");
const { makeFixture, removeFixture } = require("./helpers");

/** @returns {string | null} */
function findAnsibleInventory() {
  const venv = path.resolve(__dirname, "../.venv/bin/ansible-inventory");
  if (fs.existsSync(venv)) {
    return venv;
  }
  const which = spawnSync("sh", ["-c", "command -v ansible-inventory"], { encoding: "utf8" });
  return which.status === 0 && which.stdout.trim() ? which.stdout.trim() : null;
}

const ANSIBLE_INVENTORY = findAnsibleInventory();

const SSH = "ansible_ssh_common_args='-o StrictHostKeyChecking=accept-new'";

/** @type {{ name: string, text: string, merged?: boolean }[]} */
const FIXTURES = [
  {
    name: "homelab-like layout with a duplicate section",
    merged: true,
    text: [
      "# Example inventory",
      "[nfs_servers]",
      `nfs_server ansible_host=nfs.example.test ansible_user=nfsuser ${SSH}`,
      "",
      "[podman_servers]",
      `podman_server ansible_host=podman.example.test  ansible_user=podmanuser ${SSH}`,
      "",
      "[nfs_servers:vars]",
      "ansible_python_interpreter=/usr/bin/python3",
      "ansible_ssh_pass_auth=no",
      "",
      "[immich:children]",
      "nfs_servers",
      "podman_servers",
      "",
      "[nextcloud:children]",
      "nfs_servers",
      "",
      "[immich:children]",
      "nfs_servers",
      "",
      "[immich:vars]",
      "immich_domain=photos.example.test",
      "",
    ].join("\n"),
  },
  {
    name: "vars values Ansible evaluates itself",
    text: [
      "[g]",
      "h1",
      "[g:vars]",
      'mylist=["a", "b"]',
      "msg=hello # trailing",
      "semi=a ;b",
      'port="22"',
      "flag=True",
      "n=3",
      "name='web'",
      "eq=a=b",
      "",
    ].join("\n"),
  },
  {
    name: "host-line values",
    text: [
      "[g]",
      `h1 ansible_host=10.0.0.1 ansible_port=2222 ${SSH} p='8080' q="it's" r='say "x"' s=plain`,
      "h2 # a comment",
      "",
    ].join("\n"),
  },
  { name: "a group with vars but no hosts", text: "[empty_grp]\n\n[empty_grp:vars]\nk=v\n" },
  {
    name: "services with children, hosts and vars",
    text: [
      "[a]",
      "h1 ansible_host=a.example.test",
      "[b]",
      "h2",
      "[svc]",
      "h3",
      "[svc:children]",
      "a",
      "b",
      "[svc:vars]",
      "x=1",
      "[top:children]",
      "svc",
      "[all:vars]",
      "ansible_user=deploy",
      "",
    ].join("\n"),
  },
  {
    name: "a manual block",
    text: `[a]\nh1\n\n${MANUAL_BEGIN}\n[hand]\nbox  # kept\n[hand:vars]\nk=v\n${MANUAL_END}\n\n[s:children]\na\nhand\n`,
  },
];

/**
 * Children arrays sorted, for where merging duplicate sections may reorder them.
 *
 * @param {any} list
 */
function sortChildren(list) {
  for (const value of Object.values(list)) {
    if (value && typeof value === "object" && Array.isArray(value.children)) {
      value.children.sort();
    }
  }
  return list;
}

describe("serialized inventories read the same in ansible-inventory", {
  skip: ANSIBLE_INVENTORY ? false : "ansible-inventory not found",
}, () => {
  /** @type {string} */
  let root = "";

  before(() => {
    root = makeFixture(["empty/"], { prefix: "playbook-runner-inventory-" });
  });
  after(() => removeFixture(root));

  /** @param {string} file */
  const list = (file) => {
    const result = spawnSync(String(ANSIBLE_INVENTORY), ["-i", file, "--list"], {
      cwd: path.join(root, "empty"),
      encoding: "utf8",
      env: {
        ...process.env,
        ANSIBLE_CONFIG: path.join(root, "empty", "none.cfg"),
        ANSIBLE_INVENTORY_ENABLED: "ini",
        // A section Ansible cannot parse fails the run instead of being skipped with a warning.
        ANSIBLE_INVENTORY_UNPARSED_FAILED: "true",
        ANSIBLE_INVENTORY_ANY_UNPARSED_IS_FAILED: "true",
        ANSIBLE_NOCOLOR: "1",
      },
    });
    assert.equal(result.status, 0, `ansible-inventory failed on ${file}:\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };

  for (const [index, fixture] of FIXTURES.entries()) {
    it(fixture.name, () => {
      const original = path.join(root, `original-${index}.ini`);
      const written = path.join(root, `written-${index}.ini`);
      fs.writeFileSync(original, fixture.text);
      const parsed = parseInventory(fixture.text);
      assert.equal(parsed.error, null);
      fs.writeFileSync(written, serializeInventory(parsed));
      const before = list(original);
      const now = list(written);
      if (fixture.merged) {
        assert.deepEqual(sortChildren(now), sortChildren(before));
      } else {
        assert.deepEqual(now, before);
      }
    });
  }
});
