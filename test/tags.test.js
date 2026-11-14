/**
 * Tests for the tag scanner.
 *
 * The fixture below is a miniature of this repository's shape -- a play with
 * task-level tags, a `roles:` block, an import_role with a tasks_from, a site
 * playbook made of import_playbook lines -- plus the awkward spellings of
 * `tags:` that a line scanner has to survive. What it asserts is the list the
 * checkbox picker ends up showing, which is the only thing anything downstream
 * of here cares about.
 */

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const {
  buildTagChoices,
  findPlaybookOutline,
  findPlaybookTags,
  formatTagList,
  outlineTaskNames,
  parseTagList,
} = require("../src/tags");
const { makeFixture, removeFixture, required } = require("./helpers");

/** @type {(string | [string, string])[]} */
const FIXTURE = [
  [
    "playbooks/authentik/authentik.yml",
    `---
- name: Create the user
  hosts: podman_servers
  tasks:
    - name: Setup podman user   # a comment that is not a tag
      ansible.builtin.import_role:
        name: podman/user
      tags: ['podman-user-setup', "create-zfs-datasets"]

- name: Create the datasets
  hosts: nfs_servers
  roles:
    - role: storage/zfs-nfs
  tags: ["create-zfs-datasets"]

- name: Deploy
  hosts: podman_servers
  tasks:
    - name: Deploy it
      ansible.builtin.import_role:
        name: podman/deploy-app
        tasks_from: main
      tags:
        - deploy-app
        - "{{ templated_tag }}"
`,
  ],
  [
    "playbooks/authentik/site.yml",
    `---
- import_playbook: authentik.yml
- import_playbook: extras.yml
`,
  ],
  [
    "playbooks/authentik/extras.yml",
    `---
- name: Extras
  hosts: all
  tasks:
    - name: One
      ansible.builtin.debug: {}
      tags: impressum, default-server
`,
  ],
  [
    "playbooks/loose.yml",
    `---
- name: Bare role names, and a sequence flush against its key
  hosts: all
  roles:
    - storage/nfs
  tags:
  - flush
  - left
`,
  ],
  [
    "roles/podman/user/tasks/main.yml",
    `---
- name: Make the user
  ansible.builtin.user: {}
  tags: ['podman-user-setup']
`,
  ],
  [
    "roles/podman/deploy-app/tasks/main.yml",
    `---
- name: Render the manifest
  ansible.builtin.template: {}
  tags: ['k8s-manifest']

- name: The quadlet
  ansible.builtin.import_role:
    name: podman/kube-unit
  tags: ['podman-kube-unit']

- name: The rest
  ansible.builtin.include_tasks: start.yml
  tags: ['podman-kube-start']
`,
  ],
  [
    "roles/podman/deploy-app/tasks/start.yml",
    `---
- name: Start it
  ansible.builtin.systemd: {}
  tags: ['podman-kube-restart']
`,
  ],
  [
    "roles/podman/kube-unit/tasks/main.yml",
    `---
- name: The unit file
  ansible.builtin.template: {}
  tags: ['kube-unit-file']
`,
  ],
  [
    "roles/storage/zfs-nfs/tasks/main.yml",
    `---
- name: The dataset
  community.general.zfs: {}
  tags: ['create-zfs-datasets', 'zfs-only']
`,
  ],
  [
    "roles/storage/nfs/tasks/main.yml",
    `---
- name: The mount
  ansible.posix.mount: {}
  tags: ['create-nfs-mounts']
`,
  ],
  // A role that is never referenced: its tags must not turn up anywhere.
  [
    "roles/unattended-upgrades/tasks/main.yml",
    `---
- name: Never reached from any playbook here
  ansible.builtin.apt: {}
  tags: ['unattended-upgrades']
`,
  ],
];

describe("findPlaybookTags", () => {
  /** @type {string} */
  let root;

  before(() => {
    root = makeFixture(FIXTURE, { prefix: "playbook-runner-tags-" });
  });
  after(() => removeFixture(root));

  /** @param {string} relative */
  const tagsOf = (relative) => findPlaybookTags(root, path.join(root, relative));

  /** @param {string} relative */
  const namesOf = (relative) => tagsOf(relative).map((tag) => tag.name);

  it("collects the tags of the playbook and of every role it reaches", () => {
    assert.deepEqual(namesOf("playbooks/authentik/authentik.yml"), [
      "podman-user-setup",
      "create-zfs-datasets",
      "deploy-app",
      "zfs-only",
      "k8s-manifest",
      "podman-kube-unit",
      "podman-kube-start",
      "kube-unit-file",
      "podman-kube-restart",
    ]);
  });

  it("puts the play's own tags before the ones inside the roles it imports", () => {
    const names = namesOf("playbooks/authentik/authentik.yml");
    assert.ok(names.indexOf("podman-user-setup") < names.indexOf("deploy-app"));
    assert.ok(names.indexOf("deploy-app") < names.indexOf("k8s-manifest"));
    assert.ok(names.indexOf("podman-kube-unit") < names.indexOf("kube-unit-file"));
  });

  it("names the role a tag came from, and leaves the playbook's own unattributed", () => {
    const tags = tagsOf("playbooks/authentik/authentik.yml");
    assert.deepEqual(required(tags.find((tag) => tag.name === "deploy-app"), "deploy-app").sources, []);
    assert.deepEqual(
      required(tags.find((tag) => tag.name === "k8s-manifest"), "k8s-manifest").sources,
      ["podman/deploy-app"],
    );
    assert.deepEqual(
      required(tags.find((tag) => tag.name === "kube-unit-file"), "kube-unit-file").sources,
      ["podman/kube-unit"],
    );
  });

  it("attributes a tag written in two places to both", () => {
    const tags = tagsOf("playbooks/authentik/authentik.yml");
    assert.deepEqual(
      required(tags.find((tag) => tag.name === "create-zfs-datasets"), "create-zfs-datasets")
        .sources,
      ["storage/zfs-nfs"],
    );
  });

  it("skips a templated tag rather than offering the expression", () => {
    assert.ok(!namesOf("playbooks/authentik/authentik.yml").some((name) => name.includes("{{")));
  });

  it("leaves out roles nothing reaches", () => {
    assert.ok(!namesOf("playbooks/authentik/authentik.yml").includes("unattended-upgrades"));
  });

  it("follows import_playbook, naming the file each tag came from", () => {
    const tags = tagsOf("playbooks/authentik/site.yml");
    assert.deepEqual(
      required(tags.find((tag) => tag.name === "impressum"), "impressum").sources,
      ["authentik/extras.yml"],
    );
    assert.deepEqual(
      required(tags.find((tag) => tag.name === "deploy-app"), "deploy-app").sources,
      ["authentik/authentik.yml"],
    );
    assert.ok(tags.some((tag) => tag.name === "default-server"));
  });

  it("reads a bare role name, and a sequence flush against its key", () => {
    assert.deepEqual(namesOf("playbooks/loose.yml"), [
      "flush",
      "left",
      "create-nfs-mounts",
    ]);
  });

  it("returns nothing for a playbook with no tags, and for one that is not there", () => {
    assert.deepEqual(findPlaybookTags(root, path.join(root, "playbooks/nope.yml")), []);
    assert.deepEqual(
      findPlaybookTags(root, path.join(root, "roles/storage/nfs/tasks/main.yml"), {
        rolesDir: "elsewhere",
      }).map((tag) => tag.name),
      ["create-nfs-mounts"],
    );
  });

  it("honours a configured rolesDir", () => {
    assert.deepEqual(
      findPlaybookTags(root, path.join(root, "playbooks/loose.yml"), {
        rolesDir: "not-here",
      }).map((tag) => tag.name),
      ["flush", "left"],
    );
  });
});

describe("parseTagList", () => {
  it("splits, trims and de-duplicates", () => {
    assert.deepEqual(parseTagList(" a , b ,, a "), ["a", "b"]);
  });

  it("treats anything that is not a string as no tags at all", () => {
    assert.deepEqual(parseTagList(undefined), []);
    assert.deepEqual(parseTagList(["a"]), []);
  });

  it("round-trips through formatTagList", () => {
    assert.equal(formatTagList(["deploy-app", "deploy-app", " "]), "deploy-app");
    assert.equal(formatTagList([]), "");
  });

  it("turns the one tag of a tree row into a --tags value", () => {
    // What a tag row hands the run command, straight from the node.
    assert.equal(formatTagList(parseTagList("deploy-app")), "deploy-app");
    assert.equal(formatTagList(parseTagList(" deploy-app , deploy-app ")), "deploy-app");
    assert.equal(formatTagList(parseTagList(undefined)), "");
  });
});

describe("buildTagChoices", () => {
  const available = [
    { name: "deploy-app", sources: [] },
    { name: "podman-kube-start", sources: ["podman/deploy-app"] },
  ];

  it("ticks what was selected last time", () => {
    const choices = buildTagChoices(available, ["podman-kube-start"]);
    assert.deepEqual(
      choices.map((choice) => [choice.name, choice.picked]),
      [
        ["deploy-app", false],
        ["podman-kube-start", true],
      ],
    );
  });

  it("keeps a selected tag the scan did not find, and marks it", () => {
    const choices = buildTagChoices(available, ["hand-typed"]);
    const extra = required(choices.at(-1), "the carried-over tag");
    assert.equal(extra.name, "hand-typed");
    assert.equal(extra.known, false);
    assert.equal(extra.picked, true);
    assert.equal(choices.length, 3);
  });
});

/** @type {(string | [string, string])[]} */
const OUTLINE_FIXTURE = [
  [
    "playbooks/app/app.yml",
    `---
- name: Deploy the app
  hosts: podman_servers
  tags: [p]
  pre_tasks:
    - name: pre task
      ansible.builtin.debug: msg=pre
  roles:
    - role: podman/deploy-app
      tags: deploy-app
  tasks:
    - name: top task
      ansible.builtin.debug: msg=a
    - name: Pull in the setup
      ansible.builtin.import_role:
        name: podman/user
        tasks_from: setup
    - name: last task
      ansible.builtin.debug: msg=b
    - name: "Install {{ pkg }}"
      ansible.builtin.debug: msg=c
    - ansible.builtin.debug: msg=unnamed
    - name: A block
      tags: [b]
      block:
        - name: in block
          ansible.builtin.debug: msg=d
      rescue:
        - name: in rescue
          ansible.builtin.debug: msg=e
    - ansible.builtin.import_role:
        name: ../../roles/byPath
  handlers:
    - name: a handler
      ansible.builtin.debug: msg=h

- import_playbook: other.yml
`,
  ],
  [
    "playbooks/app/other.yml",
    `- name: Second play
  hosts: nfs_servers
  strategy: free
  serial: 1
  tasks:
    - name: other task
      ansible.builtin.debug: msg=o
`,
  ],
  [
    "roles/podman/deploy-app/tasks/main.yml",
    `---
# a comment line
- name: inner task
  ansible.builtin.debug: msg=x
- name: Load more
  ansible.builtin.import_tasks: more.yaml
`,
  ],
  ["roles/podman/deploy-app/tasks/more.yaml", "- name: from more\n  ansible.builtin.debug: msg=m\n"],
  ["roles/podman/user/tasks/setup.yml", "- name: setup task\n  ansible.builtin.debug: msg=s\n"],
  ["roles/byPath/tasks/main.yml", "- name: by path\n  ansible.builtin.debug: msg=p\n"],
  ["roles/podman/user/tasks/main.yml", "- name: not reached\n  ansible.builtin.debug: msg=n\n"],
  ["playbooks/loop/loop.yml", "- hosts: all\n  tasks:\n    - import_tasks: a.yml\n"],
  ["playbooks/loop/a.yml", "- name: in a\n  debug: msg=a\n- import_tasks: b.yml\n"],
  ["playbooks/loop/b.yml", "- name: in b\n  debug: msg=b\n- import_tasks: a.yml\n"],
];

describe("findPlaybookOutline", () => {
  /** @type {string} */
  let root;
  /** @type {import("../src/tags").PlaybookOutline} */
  let outline;

  before(() => {
    root = makeFixture(OUTLINE_FIXTURE, { prefix: "playbook-runner-outline-" });
    outline = findPlaybookOutline(root, path.join(root, "playbooks/app/app.yml"));
  });

  after(() => removeFixture(root));

  /** @param {string} name */
  const task = (name) =>
    required(
      outline.plays.flatMap((play) => play.tasks).find((item) => item.name === name),
      `task ${name}`,
    );

  it("lists the tasks in run order, with role tasks carrying the role prefix", () => {
    assert.deepEqual(outlineTaskNames(outline), [
      "pre task",
      "podman/deploy-app : inner task",
      "podman/deploy-app : from more",
      "top task",
      "podman/user : setup task",
      "last task",
      "Install {{ pkg }}",
      "in block",
      "../../roles/byPath : by path",
      "other task",
    ]);
  });

  it("keeps the bare name and the role apart", () => {
    const inner = task("podman/deploy-app : inner task");
    assert.equal(inner.bareName, "inner task");
    assert.equal(inner.role, "podman/deploy-app");
    assert.equal(task("top task").role, null);
  });

  it("keeps the role prefix through import_tasks inside a role, and reads .yaml", () => {
    assert.equal(task("podman/deploy-app : from more").role, "podman/deploy-app");
  });

  it("follows import_playbook into extra plays, keeping name and hosts", () => {
    assert.deepEqual(
      outline.plays.map((play) => [play.name, play.hosts]),
      [
        ["Deploy the app", "podman_servers"],
        ["Second play", "nfs_servers"],
      ],
    );
  });

  it("inherits play, role-reference and block tags", () => {
    assert.deepEqual(task("podman/deploy-app : inner task").tags, ["p", "deploy-app"]);
    assert.deepEqual(task("in block").tags, ["p", "b"]);
    assert.deepEqual(task("top task").tags, ["p"]);
  });

  it("skips unnamed tasks and counts them, but keeps a templated name raw -- that is what ansible matches", () => {
    assert.equal(outline.skipped, 1);
    assert.equal(task("Install {{ pkg }}").bareName, "Install {{ pkg }}");
  });

  it("finds a role referenced by a path relative to the playbook, named as written", () => {
    assert.equal(task("../../roles/byPath : by path").role, "../../roles/byPath");
  });

  it("does not list handlers, nor rescue and always tasks -- as --list-tasks does not", () => {
    assert.ok(!outlineTaskNames(outline).includes("a handler"));
    assert.ok(!outlineTaskNames(outline).includes("in rescue"));
  });

  it("reports a play-level serial", () => {
    assert.equal(outline.serial, "1");
    const loop = findPlaybookOutline(root, path.join(root, "playbooks/loop/loop.yml"));
    assert.equal(loop.serial, null);
  });

  it("reports a play-level strategy", () => {
    assert.equal(outline.strategy, "free");
    const plain = findPlaybookOutline(root, path.join(root, "playbooks/app/other.yml"));
    assert.equal(plain.strategy, "free");
    const loop = findPlaybookOutline(root, path.join(root, "playbooks/loop/loop.yml"));
    assert.equal(loop.strategy, null);
  });

  it("points each task at its file and its 1-based '- name:' line", () => {
    const top = task("top task");
    assert.equal(top.file, path.join(root, "playbooks/app/app.yml"));
    assert.equal(top.line, 12);
    const inner = task("podman/deploy-app : inner task");
    assert.equal(inner.file, path.join(root, "roles/podman/deploy-app/tasks/main.yml"));
    assert.equal(inner.line, 3);
  });

  it("terminates on an import cycle", () => {
    const loop = findPlaybookOutline(root, path.join(root, "playbooks/loop/loop.yml"));
    assert.deepEqual(outlineTaskNames(loop), ["in a", "in b"]);
  });

  it("returns an empty outline for a playbook that is not there", () => {
    assert.deepEqual(findPlaybookOutline(root, path.join(root, "playbooks/nope.yml")), {
      plays: [],
      strategy: null,
      serial: null,
      skipped: 0,
    });
  });
});
