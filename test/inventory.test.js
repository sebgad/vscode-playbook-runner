/**
 * Tests for parsing and writing the INI inventory.
 */

"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { MANUAL_BEGIN, MANUAL_END, parseInventory, serializeInventory } = require("../src/inventory");

const SSH = "ansible_ssh_common_args='-o StrictHostKeyChecking=accept-new'";

const HOMELAB = [
  "# Example Ansible Inventory",
  "[nfs_servers]",
  `nfs_server ansible_host=nfs.example.test ansible_user=nfsuser ${SSH}`,
  "",
  "[podman_servers]",
  `podman_server ansible_host=podman.example.test  ansible_user=podmanuser ${SSH}`,
  "",
  "",
  "[nfs_servers:vars]",
  "ansible_python_interpreter=/usr/bin/python3",
  "ansible_ssh_pass_auth=no",
  "",
  "[podman_servers:vars]",
  "ansible_python_interpreter=/usr/bin/python3",
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
].join("\n");

/** @param {import("../src/inventory").Inventory} inventory */
const withoutWarnings = (inventory) => ({ ...inventory, warnings: [] });

describe("parseInventory / serializeInventory", () => {
  it("round-trips the homelab production layout", () => {
    const parsed = parseInventory(HOMELAB);
    assert.equal(parsed.error, null);
    assert.deepEqual(withoutWarnings(parseInventory(serializeInventory(parsed))), withoutWarnings(parsed));

    const immich = parsed.services.find((service) => service.name === "immich");
    assert.deepEqual(immich?.children, ["nfs_servers", "podman_servers"]);
    const podman = parsed.serverGroups.find((group) => group.name === "podman_servers")?.hosts[0];
    assert.deepEqual(
      podman?.vars.find((entry) => entry[0] === "ansible_ssh_common_args"),
      ["ansible_ssh_common_args", "-o StrictHostKeyChecking=accept-new"],
    );
    assert.ok(parsed.warnings.includes("1 comment line(s) outside manual blocks will be removed"));
    assert.ok(parsed.warnings.includes("1 duplicate section(s) will be merged"));
  });

  it("serializes in the homelab layout", () => {
    const text = "[b:children]\na\n[a]\nh1 ansible_host=x\n[a:vars]\nk=v\n";
    assert.equal(serializeInventory(parseInventory(text)), "[a]\nh1 ansible_host=x\n\n[a:vars]\nk=v\n\n[b:children]\na\n");
  });

  it("keeps = and spaces inside quoted values", () => {
    const parsed = parseInventory("[g]\nh k='-o A=b -o C=d'\n");
    assert.deepEqual(parsed.serverGroups[0]?.hosts[0]?.vars, [["k", "-o A=b -o C=d"]]);
    assert.match(serializeInventory(parsed), /^h k='-o A=b -o C=d'$/m);
  });

  it("quotes with double quotes when the value contains a single quote", () => {
    const parsed = parseInventory('[g]\nh k="it\'s"\n');
    assert.deepEqual(parsed.serverGroups[0]?.hosts[0]?.vars, [["k", "it's"]]);
    assert.match(serializeInventory(parsed), /^h k="it's"$/m);
  });

  it("drops and counts inline comments", () => {
    const parsed = parseInventory("[g] # x\nh a=b ; c\n# lone\n");
    assert.deepEqual(parsed.serverGroups[0]?.hosts[0]?.vars, [["a", "b"]]);
    assert.deepEqual(parsed.warnings, ["3 comment line(s) outside manual blocks will be removed"]);
  });

  it("merges a duplicate host's vars with the later key winning", () => {
    const parsed = parseInventory("[g]\nh a=1 b=2\nh b=3 c=4\n");
    assert.deepEqual(parsed.serverGroups[0]?.hosts, [
      {
        name: "h",
        vars: [
          ["a", "1"],
          ["b", "3"],
          ["c", "4"],
        ],
      },
    ]);
  });

  it("keeps ungrouped hosts and all:vars", () => {
    const parsed = parseInventory("h1\n[all:vars]\nx=1\n");
    assert.deepEqual(
      parsed.serverGroups.map((group) => [group.name, group.hosts.map((host) => host.name), group.vars]),
      [
        ["ungrouped", ["h1"], []],
        ["all", [], [["x", "1"]]],
      ],
    );
    const text = serializeInventory(parsed);
    assert.ok(text.includes("[all:vars]"));
    assert.ok(!text.includes("[all]\n"));
  });

  describe("manual blocks", () => {
    const BLOCK = [MANUAL_BEGIN, "[odd]", "  weird   line # kept", MANUAL_END].join("\n");
    const WITH_BLOCK = `[a]\nh1\n\n[b]\nh2\n\n[a:vars]\nk=v\n\n${BLOCK}\n`;

    it("writes manual blocks back verbatim after their anchor", () => {
      const parsed = parseInventory(WITH_BLOCK);
      assert.equal(parsed.error, null);
      assert.equal(parsed.manual[0]?.text, BLOCK);
      assert.equal(parsed.manual[0]?.line, 10);
      assert.deepEqual(parsed.manual[0]?.anchors, ["a:vars", "b", "a"]);
      assert.equal(serializeInventory(parsed), WITH_BLOCK);
    });

    it("moves a block to the nearest surviving anchor, or the top", () => {
      const noVars = parseInventory(WITH_BLOCK);
      const a = noVars.serverGroups.find((group) => group.name === "a");
      assert.ok(a);
      a.vars = [];
      assert.equal(serializeInventory(noVars), `[a]\nh1\n\n[b]\nh2\n\n${BLOCK}\n`);

      const none = parseInventory(WITH_BLOCK);
      none.serverGroups = [];
      assert.equal(serializeInventory(none), `${BLOCK}\n`);
    });

    it("marks groups touched by a manual block read-only", () => {
      const parsed = parseInventory(`${MANUAL_BEGIN}\n[p]\nx\n${MANUAL_END}\n[p:vars]\nk=v\n`);
      assert.deepEqual(parsed.manualGroups, ["p"]);
      const group = parsed.serverGroups.find((item) => item.name === "p");
      assert.equal(group?.readOnly, true);
      assert.deepEqual(group?.vars, [["k", "v"]]);
    });

    it("reports an unclosed manual block", () => {
      const parsed = parseInventory(`[a]\nh\n${MANUAL_BEGIN}\nfoo\n`);
      assert.match(parsed.error || "", /never closed/);
      assert.match(parsed.error || "", /line 3/);
      assert.equal(parsed.serverGroups[0]?.name, "a");
    });

    it("reports an end without begin and a nested begin", () => {
      assert.match(parseInventory(`${MANUAL_END}\n`).error || "", /no matching begin/);
      assert.match(parseInventory(`${MANUAL_BEGIN}\n${MANUAL_BEGIN}\n${MANUAL_END}\n`).error || "", /nested/);
    });
  });

  it("rejects header-less lines after a block that opened a section", () => {
    const parsed = parseInventory(`[a]\nh1\n${MANUAL_BEGIN}\n[odd]\nx1\n${MANUAL_END}\nh2\n`);
    assert.match(parsed.error || "", /Line 7 follows a manual block/);
    assert.equal(parseInventory(`[a]\nh1\n${MANUAL_BEGIN}\n[odd]\n${MANUAL_END}\n[b]\nh2\n`).error, null);
  });

  it("keeps hosts under [all] but never writes an empty [all]", () => {
    const parsed = parseInventory("[all]\nh1\n[all:vars]\nk=v\n");
    assert.equal(serializeInventory(parsed), "[all]\nh1\n\n[all:vars]\nk=v\n");
    assert.ok(!serializeInventory(parseInventory("[all:vars]\nk=v\n")).includes("[all]\n"));
  });

  it("warns about unreadable and duplicate entries", () => {
    const unreadable = parseInventory("[g]\nh1 stray k=v\n[g:vars]\nnoequals\n[s:children]\na b\n");
    assert.deepEqual(unreadable.warnings, ["3 unreadable entries will be removed"]);
    assert.deepEqual(parseInventory("[g]\nh1 stray\n").warnings, ["1 unreadable entry will be removed"]);

    const duplicate = parseInventory("[g]\nh a=1 a=2\nh\n[g:vars]\nk=1\nk=2\n[s:children]\ng\ng\n");
    assert.deepEqual(duplicate.warnings, ["4 duplicate entries will be merged"]);
    assert.deepEqual(parseInventory("[g]\nh\nh\n").warnings, ["1 duplicate entry will be merged"]);
  });

  it("keeps quotes that stop a string from becoming another type", () => {
    const parsed = parseInventory('[g:vars]\nport="22"\nflag=\'True\'\nlist="[1]"\nname="web"\n');
    assert.deepEqual(parsed.serverGroups[0]?.vars, [
      ["port", '"22"'],
      ["flag", "'True'"],
      ["list", '"[1]"'],
      ["name", "web"],
    ]);
    assert.equal(serializeInventory(parsed), '[g:vars]\nport="22"\nflag=\'True\'\nlist="[1]"\nname=web\n');
    const host = parseInventory("[g]\nh p='8080' k='-o A=b -o C=d'\n").serverGroups[0]?.hosts[0];
    assert.deepEqual(host?.vars, [
      ["p", "'8080'"],
      ["k", "-o A=b -o C=d"],
    ]);
  });

  it("keeps CRLF", () => {
    const parsed = parseInventory("[a]\r\nh1\r\n[a:vars]\r\nk=v\r\n");
    assert.equal(parsed.eol, "\r\n");
    const text = serializeInventory(parsed);
    assert.equal(text, "[a]\r\nh1\r\n\r\n[a:vars]\r\nk=v\r\n");
    assert.ok(!/(?<!\r)\n/.test(text));
  });
});
