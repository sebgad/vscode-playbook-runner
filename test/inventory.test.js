/**
 * Tests for parsing and writing the INI inventory.
 */

"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  MANUAL_BEGIN,
  MANUAL_END,
  describeChanges,
  inventoryHash,
  mergeEdits,
  newInventoryText,
  parseInventory,
  serializeInventory,
  validateGroupName,
  validateInventory,
  applyGroupRename,
  planGroupDelete,
  planGroupRename,
  playbooksNamingGroup,
} = require("../src/inventory");
const fs = require("node:fs");
const path = require("node:path");
const { DEFAULTS, findEnvironments } = require("../src/discovery");
const { makeFixture, removeFixture, required } = require("./helpers");

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
    const text = '[g:vars]\nport="22"\nflag=\'True\'\nlist="[1]"\nname="web"\n';
    const parsed = parseInventory(text);
    // Vars sections are verbatim: Ansible literal_evals the rest of the line.
    assert.deepEqual(parsed.serverGroups[0]?.vars, [
      ["port", '"22"'],
      ["flag", "'True'"],
      ["list", '"[1]"'],
      ["name", '"web"'],
    ]);
    assert.equal(serializeInventory(parsed), `[g]\n\n${text}`);
    const host = parseInventory("[g]\nh p='8080' k='-o A=b -o C=d'\n").serverGroups[0]?.hosts[0];
    assert.deepEqual(host?.vars, [
      ["p", "'8080'"],
      ["k", "-o A=b -o C=d"],
    ]);
  });

  describe("vars sections are verbatim", () => {
    it("keeps a list value as written", () => {
      const parsed = parseInventory('[g]\nh\n[g:vars]\nmylist=["a", "b"]\n');
      assert.deepEqual(parsed.serverGroups[0]?.vars, [["mylist", '["a", "b"]']]);
      assert.match(serializeInventory(parsed), /^mylist=\["a", "b"\]$/m);
    });

    it("keeps a trailing # and ; as part of the value", () => {
      const parsed = parseInventory("[g]\nh\n[g:vars]\nmsg=hello # trailing\nsemi=a ;b\n");
      assert.deepEqual(parsed.serverGroups[0]?.vars, [
        ["msg", "hello # trailing"],
        ["semi", "a ;b"],
      ]);
      assert.deepEqual(parsed.warnings, []);
      assert.match(serializeInventory(parsed), /^msg=hello # trailing\nsemi=a ;b$/m);
    });

    it("splits on the first = only and never quotes", () => {
      const parsed = parseInventory("[g]\nh\n[g:vars]\nk = a=b c\n# whole-line comment\n; another\n");
      assert.deepEqual(parsed.serverGroups[0]?.vars, [["k", "a=b c"]]);
      assert.deepEqual(parsed.warnings, ["2 comment line(s) outside manual blocks will be removed"]);
      assert.match(serializeInventory(parsed), /^k=a=b c$/m);
    });
  });

  describe("a group with vars but no hosts", () => {
    it("keeps the [g] header on a round-trip", () => {
      assert.equal(serializeInventory(parseInventory("[e]\n[e:vars]\nk=v\n")), "[e]\n\n[e:vars]\nk=v\n");
    });

    it("keeps the [g] header when its only host is removed", () => {
      const parsed = parseInventory("[e]\nh1\n[e:vars]\nk=v\n");
      const group = parsed.serverGroups[0];
      assert.ok(group);
      group.hosts = [];
      assert.equal(serializeInventory(parsed), "[e]\n\n[e:vars]\nk=v\n");
    });

    it("writes the header of a new group with only vars", () => {
      const parsed = parseInventory("");
      parsed.serverGroups.push({ name: "n", hosts: [], vars: [["k", "v"]], readOnly: false });
      assert.equal(serializeInventory(parsed), "[n]\n\n[n:vars]\nk=v\n");
    });
  });

  it("keeps a UTF-8 byte order mark", () => {
    const parsed = parseInventory("\uFEFF[a]\nh1\n");
    assert.equal(parsed.bom, true);
    assert.equal(parsed.serverGroups[0]?.name, "a");
    assert.equal(serializeInventory(parsed), "\uFEFF[a]\nh1\n");
    assert.equal(parseInventory("[a]\nh1\n").bom, false);
    assert.equal(serializeInventory(parseInventory("[a]\nh1\n")), "[a]\nh1\n");
    const merged = mergeEdits(parsed, { serverGroups: parseInventory("[a]\nh2\n").serverGroups, services: [] });
    assert.equal(merged.bom, true);
    assert.equal(serializeInventory(merged), "\uFEFF[a]\nh2\n");
  });

  it("keeps CRLF", () => {
    const parsed = parseInventory("[a]\r\nh1\r\n[a:vars]\r\nk=v\r\n");
    assert.equal(parsed.eol, "\r\n");
    const text = serializeInventory(parsed);
    assert.equal(text, "[a]\r\nh1\r\n\r\n[a:vars]\r\nk=v\r\n");
    assert.ok(!/(?<!\r)\n/.test(text));
  });
});

describe("validateInventory", () => {
  /** @param {string} text */
  const errors = (text) => validateInventory(parseInventory(text));

  it("accepts host ranges and ports", () => {
    assert.deepEqual(errors("[web]\nweb[01:10].example\ndb.example:2222 ansible_port=22\n"), []);
  });

  it("refuses password variables", () => {
    const found = errors("[web]\nh1 ansible_password=x\n");
    assert.equal(found.length, 1);
    assert.match(found[0] ?? "", /vault/);
    assert.match(found[0] ?? "", /web/);
  });

  it("refuses a child that does not exist", () => {
    const found = errors("[web]\nh1\n[svc:children]\nghost\n");
    assert.equal(found.length, 1);
    assert.match(found[0] ?? "", /"ghost".*no such group/);
    assert.deepEqual(errors("[web]\nh1\n[svc:children]\nweb\n"), []);
  });

  it("refuses a service cycle", () => {
    const found = errors("[a:children]\nb\n[b:children]\na\n");
    assert.equal(found.length, 1);
    assert.match(found[0] ?? "", /cycle/);
  });

  it("refuses a group name used twice", () => {
    const inventory = parseInventory("[web]\nh1\n[svc:children]\nweb\n");
    const service = inventory.services[0];
    assert.ok(service);
    service.name = "web";
    service.children = [];
    const found = validateInventory(inventory);
    assert.equal(found.length, 1);
    assert.match(found[0] ?? "", /"web" is used more than once/);
  });

  it("refuses a duplicate variable key", () => {
    const inventory = parseInventory("[web]\nh1 ansible_host=a\n[web:vars]\nk=1\n");
    inventory.serverGroups[0]?.hosts[0]?.vars.push(["ansible_host", "b"]);
    inventory.serverGroups[0]?.vars.push(["k", "2"]);
    const found = validateInventory(inventory);
    assert.equal(found.length, 2);
    assert.match(found[0] ?? "", /^Group web: k is set more than once/);
    assert.match(found[1] ?? "", /^Host h1 in web: ansible_host is set more than once/);
  });

  it("refuses a newline in a value", () => {
    const inventory = parseInventory("[web]\nh1\n");
    inventory.serverGroups[0]?.hosts[0]?.vars.push(["k", "a\nb"]);
    const found = validateInventory(inventory);
    assert.equal(found.length, 1);
    assert.match(found[0] ?? "", /line break/);
  });

  it("refuses a dash in a group name", () => {
    const found = errors("[my-group]\nh1\n");
    assert.equal(found.length, 1);
    assert.match(found[0] ?? "", /letters, digits and _/);
  });

  it("accepts a manual-only group as a child", () => {
    const text = `[svc:children]\nm\n\n${MANUAL_BEGIN}\n[m]\nhm\n${MANUAL_END}\n`;
    assert.deepEqual(errors(text), []);
  });

  it("does not check read-only groups", () => {
    const text = `[m-x]\nh-1 ansible_password=x\n\n${MANUAL_BEGIN}\n[m-x:vars]\nk=v\n${MANUAL_END}\n`;
    const parsed = parseInventory(text);
    assert.equal(parsed.serverGroups[0]?.readOnly, true);
    assert.deepEqual(validateInventory(parsed), []);
  });

  it("does not name a path in the password message", () => {
    assert.doesNotMatch(errors("[web]\nh1 ansible_password=x\n")[0] ?? "", /group_vars/);
  });

  it("accepts quoted non-string values", () => {
    assert.deepEqual(errors("[web]\nh1 ansible_port='22'\n"), []);
  });

  it("refuses a host with vars in more than one group", () => {
    assert.equal(errors("[a]\nh1 k=1\n[b]\nh1 k=2\n").length, 1);
    assert.deepEqual(errors("[a]\nh1 k=1\n[b]\nh1\n"), []);
  });

  it("refuses a host value with both quote kinds, naming host and key", () => {
    const inventory = parseInventory("[web]\nh1\n");
    inventory.serverGroups[0]?.hosts[0]?.vars.push(["k", `it's "x"`]);
    const found = validateInventory(inventory);
    assert.equal(found.length, 1);
    assert.match(found[0] ?? "", /h1/);
    assert.match(found[0] ?? "", /\bk\b/);
    assert.match(found[0] ?? "", /quote/);
    // One kind only, or a value kept wrapped from the file, is written as is.
    assert.deepEqual(errors(`[web]\nh1 a="it's" b='say "x"' c="[1, 'a']"\n`), []);
    // Group vars are written verbatim, so both kinds are fine there.
    assert.deepEqual(errors(`[web]\nh1\n[web:vars]\nk=it's "x"\n`), []);
  });

  it("reports the parse error", () => {
    assert.equal(errors(`${MANUAL_BEGIN}\n[a]\n`).length, 1);
  });
});

describe("validateGroupName", () => {
  it("accepts letters, digits and underscores not starting with a digit", () => {
    assert.equal(validateGroupName("podman_servers"), null);
    assert.equal(validateGroupName("_x1"), null);
  });

  it("refuses anything else, with the same message validateInventory gives", () => {
    for (const name of ["", "1st", "a-b", "a b", "a:b", "ä"]) {
      const reason = validateGroupName(name);
      assert.ok(reason, name);
      const inventory = parseInventory("[ok]\nhost1\n");
      const group = inventory.serverGroups[0];
      assert.ok(group);
      group.name = name;
      assert.ok(validateInventory(inventory).includes(reason), name);
    }
  });
});

describe("mergeEdits", () => {
  const text = [
    "[a]",
    "h1",
    "",
    "[m]",
    "hm",
    MANUAL_BEGIN,
    "[m:vars]",
    "k=v",
    MANUAL_END,
    "",
    "[b]",
    "h2",
    "",
  ].join("\n");

  it("keeps read-only groups from disk whatever the edit says", () => {
    const disk = parseInventory(text);
    const edited = parseInventory(text);
    const readOnly = edited.serverGroups.find((group) => group.name === "m");
    assert.ok(readOnly);
    readOnly.vars.push(["x", "1"]);
    edited.serverGroups.find((group) => group.name === "b")?.hosts.push({ name: "h3", vars: [] });
    const merged = mergeEdits(disk, edited);
    assert.deepEqual(
      merged.serverGroups.map((group) => group.name),
      disk.serverGroups.map((group) => group.name),
    );
    assert.deepEqual(merged.serverGroups.find((group) => group.name === "m")?.vars, []);
    assert.equal(merged.serverGroups.find((group) => group.name === "b")?.hosts.length, 2);
    assert.deepEqual(merged.manual, disk.manual);
    assert.deepEqual(merged.manualGroups, disk.manualGroups);
  });

  it("ignores edited entries named in manualGroups", () => {
    const disk = parseInventory(text);
    const edited = parseInventory(text);
    const copy = edited.serverGroups.find((group) => group.name === "m");
    assert.ok(copy);
    copy.readOnly = false;
    const merged = mergeEdits(disk, edited);
    assert.equal(merged.serverGroups.filter((group) => group.name === "m").length, 1);
  });
});

describe("mergeEdits placement", () => {
  const text = `[a]\nh\n\n[m]\nh\n${MANUAL_BEGIN}\n[m:vars]\nk=v\n${MANUAL_END}\n\n[b]\nh\n`;
  /** @param {import("../src/inventory").Inventory} inv */
  const names = (inv) => mergeEdits(parseInventory(text), inv).serverGroups.map((g) => g.name);

  it("keeps a read-only group after its surviving neighbour", () => {
    const edited = parseInventory(text);
    edited.serverGroups = edited.serverGroups.filter((g) => g.name !== "a");
    assert.deepEqual(names(edited), ["m", "b"]);
  });

  it("puts new groups last", () => {
    const edited = parseInventory(text);
    edited.serverGroups.push({ name: "c", hosts: [], vars: [], readOnly: false });
    assert.deepEqual(names(edited), ["a", "m", "b", "c"]);
  });
});

describe("describeChanges", () => {
  const base = "[podman_servers]\nh1 ansible_user=a\n[dns_servers]\nd1\n[immich:children]\npodman_servers\n";

  it("describes host and child changes", () => {
    const before = parseInventory(base);
    const after = parseInventory(base);
    after.serverGroups.find((group) => group.name === "podman_servers")?.hosts.push({ name: "h2", vars: [] });
    after.services.find((service) => service.name === "immich")?.children.push("dns_servers");
    assert.deepEqual(describeChanges(before, after), ["podman_servers: + host h2", "immich: + dns_servers"]);
  });

  it("describes added and removed things", () => {
    const before = parseInventory("[g]\nh1\nh2\n[s:children]\ng\nx\n[x]\nhx\n");
    const after = parseInventory("[g]\nh1\nh3\n[s:children]\ng\n[y]\n[t:children]\ng\n");
    assert.deepEqual(describeChanges(before, after), [
      "+ server group y",
      "g: + host h3",
      "g: \u2212 host h2",
      "\u2212 server group x",
      "+ service t",
      "s: \u2212 x",
    ]);
  });

  it("describes reordering", () => {
    const before = parseInventory("[g]\nh1 a=1 b=2\nh2\n[h]\nh3\n[s:children]\ng\nh\n");
    const after = parseInventory("[h]\nh3\n[g]\nh2\nh1 b=2 a=1\n[s:children]\nh\ng\n");
    assert.deepEqual(describeChanges(before, after), [
      "g: h1 changed (order)",
      "g: hosts reordered",
      "s: children reordered",
      "groups reordered",
    ]);
  });

  it("compares duplicate keys by every value", () => {
    const before = parseInventory("[g]\nh1 a=1\n");
    const after = parseInventory("[g]\nh1 a=2\n");
    assert.deepEqual(describeChanges(before, after), ["g: h1 changed (a)"]);
  });

  it("describes removals, changed vars and whole groups", () => {
    const before = parseInventory(base);
    const after = parseInventory(base);
    const podman = after.serverGroups.find((group) => group.name === "podman_servers");
    podman?.hosts[0]?.vars.splice(0, 1, ["ansible_user", "b"]);
    podman?.vars.push(["k", "v"]);
    after.serverGroups = after.serverGroups.filter((group) => group.name !== "dns_servers");
    after.services = [];
    assert.deepEqual(describeChanges(before, after), [
      "podman_servers: h1 changed (ansible_user)",
      "podman_servers:vars changed",
      "\u2212 server group dns_servers",
      "\u2212 service immich",
    ]);
  });
});

describe("inventoryHash and newInventoryText", () => {
  it("hash differs for different text and matches for equal text", () => {
    assert.equal(inventoryHash("a"), inventoryHash("a"));
    assert.notEqual(inventoryHash("a"), inventoryHash("b"));
    assert.match(inventoryHash("a"), /^[0-9a-f]{64}$/);
  });

  it("new inventory text parses to an empty inventory with one manual block", () => {
    const parsed = parseInventory(newInventoryText());
    assert.deepEqual(parsed.serverGroups, []);
    assert.deepEqual(parsed.services, []);
    assert.equal(parsed.manual.length, 1);
    assert.equal(parsed.error, null);
    assert.equal(
      newInventoryText(),
      `# Edited by Playbook Runner. Text between these two marker lines is kept as written:\n${MANUAL_BEGIN}\n${MANUAL_END}\n`,
    );
  });
});

describe("group rename and delete plans", () => {
  const HOSTS = [
    "[podman_servers]",
    "podman_server ansible_host=podman.example.test",
    "",
    "[nfs_servers]",
    "nfs_server ansible_host=nfs.example.test",
    "",
    "[immich:children]",
    "podman_servers",
    "",
    "[nextcloud:children]",
    "podman_servers",
    "",
    "[solo:children]",
    "nfs_servers",
    "",
  ].join("\n");

  /** @param {string} text @param {string[]} [extra] */
  const setup = (text, extra = []) => {
    const root = makeFixture([
      ["inventories/production/hosts.ini", text],
      ["inventories/production/group_vars/podman_servers/env.yml", "a: 1\n"],
      ["inventories/staging/hosts.ini", "[podman_servers]\nx\n"],
      ["playbooks/immich.yml", "- hosts: immich\n"],
      ...extra.map((file) => /** @type {[string, string]} */ ([file, ""])),
    ]);
    const environment = required(
      findEnvironments(root).find((item) => item.name === "production"),
      "production",
    );
    return { root, environment };
  };

  it("finds playbooks whose hosts line names the group", () => {
    const root = makeFixture([
      ["playbooks/a.yml", "- hosts: immich\n"],
      ["playbooks/b.yml", '- name: x\n  hosts: "a:immich"\n'],
      ["playbooks/c.yml", "- hosts: '!immich'\n"],
      ["playbooks/d.yml", "- hosts: immich_x\n"],
    ]);
    try {
      assert.deepEqual(playbooksNamingGroup(root, DEFAULTS, "immich"), [
        path.join("playbooks", "a.yml"),
        path.join("playbooks", "b.yml"),
        path.join("playbooks", "c.yml"),
      ]);
    } finally {
      removeFixture(root);
    }
  });

  it("rename plan renames children and group_vars", () => {
    const { root, environment } = setup(HOSTS);
    try {
      const plan = planGroupRename(root, DEFAULTS, environment, HOSTS, "podman_servers", "podman");
      assert.match(plan.text, /\[podman\]/);
      assert.match(plan.text, /\[immich:children\]\npodman\n/);
      assert.ok(plan.groupVarsFrom && plan.groupVarsFrom.endsWith(path.join("group_vars", "podman_servers")));
      assert.deepEqual(plan.services, ["immich", "nextcloud"]);
      assert.deepEqual(plan.otherEnvironments, ["staging"]);
      applyGroupRename(plan, environment.inventory);
      assert.ok(fs.existsSync(path.join(environment.groupVarsDir, "podman", "env.yml")));
      assert.ok(!fs.existsSync(path.join(environment.groupVarsDir, "podman_servers")));
      assert.match(fs.readFileSync(environment.inventory, "utf8"), /\[podman\]/);
    } finally {
      removeFixture(root);
    }
  });

  it("rename refuses a taken name, a manual group and an existing group_vars target", () => {
    const manual = `${HOSTS}\n${MANUAL_BEGIN}\n[hand]\nbox\n${MANUAL_END}\n`;
    const { root, environment } = setup(manual, ["inventories/production/group_vars/free/env.yml"]);
    try {
      assert.throws(() => planGroupRename(root, DEFAULTS, environment, manual, "podman_servers", "nfs_servers"));
      assert.throws(() => planGroupRename(root, DEFAULTS, environment, manual, "hand", "other"));
      assert.throws(() => planGroupRename(root, DEFAULTS, environment, manual, "podman_servers", "free"));
      assert.throws(() => planGroupRename(root, DEFAULTS, environment, manual, "podman_servers", "bad name"));
      assert.throws(() => planGroupRename(root, DEFAULTS, environment, manual, "missing", "other"));
    } finally {
      removeFixture(root);
    }
  });

  it("delete plan removes the group from every service and lists emptied ones", () => {
    const { root, environment } = setup(HOSTS);
    try {
      const plan = planGroupDelete(root, DEFAULTS, environment, HOSTS, "nfs_servers");
      assert.deepEqual(plan.services, ["solo"]);
      assert.deepEqual(plan.emptied, ["solo"]);
      assert.equal(plan.groupVars, null);
      assert.doesNotMatch(plan.text, /nfs_servers/);
      const withVars = planGroupDelete(root, DEFAULTS, environment, HOSTS, "podman_servers");
      assert.deepEqual(withVars.services, ["immich", "nextcloud"]);
      assert.deepEqual(withVars.emptied, ["immich", "nextcloud"]);
      assert.deepEqual(withVars.playbooks, []);
      assert.ok(withVars.groupVars);
      assert.throws(() => planGroupDelete(root, DEFAULTS, environment, HOSTS, "nope"));
    } finally {
      removeFixture(root);
    }
  });

  describe("fix round 1", () => {
    const WITH_MANUAL = `${HOSTS}\n${MANUAL_BEGIN}\n[hand:children]\npodman_servers\n# podman_servers in a comment\n${MANUAL_END}\n`;

    it("renames and deletes a service", () => {
      const { root, environment } = setup(HOSTS, ["inventories/production/group_vars/immich/env.yml"]);
      try {
        const plan = planGroupRename(root, DEFAULTS, environment, HOSTS, "immich", "photos");
        assert.match(plan.text, /\[photos:children\]/);
        assert.doesNotMatch(plan.text, /immich/);
        assert.ok(plan.groupVarsFrom && plan.groupVarsFrom.endsWith("immich"));
        const del = planGroupDelete(root, DEFAULTS, environment, HOSTS, "immich");
        assert.doesNotMatch(del.text, /immich/);
        const parent = `${HOSTS}\n[all_apps:children]\nimmich\n`;
        const nested = planGroupRename(root, DEFAULTS, environment, parent, "immich", "photos");
        assert.match(nested.text, /\[all_apps:children\]\nphotos\n/);
        assert.deepEqual(nested.services, ["all_apps"]);
        const gone = planGroupDelete(root, DEFAULTS, environment, parent, "immich");
        assert.deepEqual(gone.services, ["all_apps"]);
        assert.deepEqual(gone.emptied, ["all_apps"]);
      } finally {
        removeFixture(root);
      }
    });

    it("reports manual references and keeps manual blocks in place", () => {
      const { root, environment } = setup(WITH_MANUAL);
      try {
        const plan = planGroupRename(root, DEFAULTS, environment, WITH_MANUAL, "podman_servers", "podman");
        assert.equal(plan.manualReferences.length, 1);
        assert.ok(plan.text.includes("[hand:children]\npodman_servers\n"));
        const del = planGroupDelete(root, DEFAULTS, environment, WITH_MANUAL, "podman_servers");
        assert.equal(del.manualReferences.length, 1);
        const anchored = `[podman_servers]\nbox\n\n${MANUAL_BEGIN}\n# x\n${MANUAL_END}\n\n[nfs_servers]\nnfs\n`;
        const moved = planGroupRename(root, DEFAULTS, environment, anchored, "podman_servers", "podman");
        assert.ok(moved.text.indexOf("[podman]") < moved.text.indexOf(MANUAL_BEGIN));
        assert.ok(moved.text.indexOf(MANUAL_BEGIN) < moved.text.indexOf("[nfs_servers]"));
      } finally {
        removeFixture(root);
      }
    });

    it("refuses an unchanged name and a file-form group_vars target, and reports file-form sources", () => {
      const { root, environment } = setup(HOSTS, [
        "inventories/production/group_vars/taken.yaml",
        "inventories/production/group_vars/podman_servers.yml",
      ]);
      try {
        assert.throws(() => planGroupRename(root, DEFAULTS, environment, HOSTS, "nfs_servers", "nfs_servers"), /unchanged/);
        assert.throws(() => planGroupRename(root, DEFAULTS, environment, HOSTS, "nfs_servers", "taken"));
        const plan = planGroupRename(root, DEFAULTS, environment, HOSTS, "podman_servers", "podman");
        assert.deepEqual(plan.groupVarsFiles, [path.join(environment.groupVarsDir, "podman_servers.yml")]);
        assert.equal(planGroupDelete(root, DEFAULTS, environment, HOSTS, "podman_servers").groupVarsFiles.length, 1);
      } finally {
        removeFixture(root);
      }
    });

    it("apply refuses when the target appeared after planning, writing nothing", () => {
      const { root, environment } = setup(HOSTS);
      try {
        const plan = planGroupRename(root, DEFAULTS, environment, HOSTS, "podman_servers", "podman");
        fs.mkdirSync(plan.groupVarsTo, { recursive: true });
        assert.throws(() => applyGroupRename(plan, environment.inventory));
        assert.equal(fs.readFileSync(environment.inventory, "utf8"), HOSTS);
      } finally {
        removeFixture(root);
      }
    });

    it("reads a hosts list with brackets and a trailing comment", () => {
      const root = makeFixture([["playbooks/a.yml", "- hosts: [a, immich]  # why\n"]]);
      try {
        assert.equal(playbooksNamingGroup(root, DEFAULTS, "immich").length, 1);
      } finally {
        removeFixture(root);
      }
    });
  });
});
