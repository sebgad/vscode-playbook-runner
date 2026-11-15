/**
 * Laying out the folder skeleton of a new service.
 *
 * A service is `playbooks/<name>/` joined with `group_vars/<name>/` on the
 * directory name (see findServices in ./discovery.js), and the variables half
 * exists once per environment. Adding one by hand therefore means creating the
 * same directory in every environment and remembering the env file each time,
 * which is exactly the kind of thing that gets done in production and forgotten
 * in staging.
 *
 * Like discovery.js this imports no `vscode`: what ends up on disk is decided
 * here and exercised from plain node in test/scaffold.test.js.
 *
 * Only the structure is created -- directories and empty env files. The vault
 * is deliberately left out: a vault has to be written encrypted by
 * `ansible-vault create`, which is what the dashboard's Create vault button does once the
 * group_vars directory exists.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = require("./defaults");
const { validateEnvironmentName } = require("./environments");
const { findEnvironments, findPlaybooks, findVaultGroups, isDirectory, isFile } = require("./discovery");

/**
 * A service name is a directory name and an ansible group name at the same
 * time, so it stays in the character set both are happy with. Anything with a
 * separator, a leading dot or a space is rejected rather than quoted: this one
 * creates paths instead of arguments, and "../etc" is not a service.
 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @returns {import("./defaults").Settings}
 */
function withDefaults(settings) {
  return { ...DEFAULTS, ...(settings || {}) };
}

/**
 * The complaint about a proposed service name, or null when it is usable.
 * Returned as a message rather than a boolean because it is shown straight
 * back in the input box.
 *
 * @param {string} name
 * @returns {string | null}
 */
function validateServiceName(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) {
    return "Enter a service name.";
  }
  if (!NAME_PATTERN.test(trimmed)) {
    return "A service name is a directory and an inventory group: letters, digits, dot, dash and underscore, starting with a letter or digit.";
  }
  return null;
}

/**
 * Every service name the repository already knows, across all environments --
 * the union findServices takes per environment, flattened. Used to tell
 * someone they are about to extend a service rather than add one.
 *
 * @param {string} root workspace folder path
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @returns {string[]} sorted, without duplicates
 */
function existingServiceNames(root, settings) {
  const config = withDefaults(settings);
  /** @type {Set<string>} */
  const names = new Set();

  for (const group of findPlaybooks(root, config)) {
    names.add(group.name);
  }
  for (const environment of findEnvironments(root, config)) {
    for (const group of findVaultGroups(environment, config)) {
      names.add(group.name);
    }
  }

  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * @typedef {object} SkeletonEntry
 * @property {"directory" | "file"} type
 * @property {string} path      absolute
 * @property {string} relative  relative to the workspace folder, for messages
 * @property {boolean} exists   at the time the plan was made
 * @property {string} [content] what a file is created with; empty when absent
 */

/**
 * @typedef {object} SkeletonPlan
 * @property {string} name
 * @property {string[]} environments  the environments the plan covers
 * @property {string[]} unknownEnvironments  names in serviceEnvironments that
 *   are not an environment, and so were left out
 * @property {boolean} limited  serviceEnvironments narrowed the environments
 * @property {SkeletonEntry[]} entries
 */

/**
 * Narrow the discovered environments to the ones serviceEnvironments names,
 * in discovery order. An empty list is every environment. A name with no
 * environment behind it is reported rather than created: a directory without
 * an inventory file is not an environment, and laying out group_vars in one
 * would only make a folder discovery never shows.
 *
 * The setting is a hand-edited array, so anything in it that is not a
 * non-empty string is ignored rather than trusted.
 *
 * @template {{ name: string }} T
 * @param {T[]} environments
 * @param {unknown[]} wanted
 * @returns {{ selected: T[], unknown: string[], limited: boolean }}
 */
function selectEnvironments(environments, wanted) {
  const names = [
    ...new Set(
      wanted
        .filter((item) => typeof item === "string")
        .map((item) => /** @type {string} */ (item).trim())
        .filter(Boolean),
    ),
  ];
  if (!names.length) {
    return { selected: environments, unknown: [], limited: false };
  }
  const known = new Set(environments.map((item) => item.name));
  return {
    selected: environments.filter((item) => names.includes(item.name)),
    unknown: names.filter((name) => !known.has(name)),
    limited: true,
  };
}

/**
 * A playbook that does nothing but ping the service's group, tagged `hello`.
 * Enough to prove the connection and to have something to run and tag-select.
 *
 * @param {string} service a name validateServiceName accepted
 * @returns {string}
 */
function starterPlaybook(service) {
  return [
    `- name: ${service}`,
    `  hosts: ${service}`,
    "  gather_facts: false",
    "  tasks:",
    "    - name: Check the connection",
    "      ansible.builtin.ping:",
    "      tags: [hello]",
    "",
  ].join("\n");
}

/**
 * Whether an INI inventory lists anything in a group: a host under `[group]`,
 * or a child group under `[group:children]`. `[group:vars]` is not a host.
 * A line scan, not a parser -- it only has to tell "empty" from "not empty".
 *
 * @param {string} inventoryText
 * @param {string} group
 * @returns {boolean}
 */
function groupHasHosts(inventoryText, group) {
  let inside = false;
  for (const raw of inventoryText.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const section = header[1] || "";
      inside = section === group || section === `${group}:children`;
      continue;
    }
    if (inside && line && !line.startsWith("#") && !line.startsWith(";")) {
      return true;
    }
  }
  return false;
}

/**
 * An `add(type, target, content?)` that appends a SkeletonEntry to `entries`,
 * recording whether the target exists right now.
 *
 * @param {string} root workspace folder path
 * @param {SkeletonEntry[]} entries
 * @returns {(type: "directory" | "file", target: string, content?: string) => void}
 */
function entryAdder(root, entries) {
  return (type, target, content) => {
    /** @type {SkeletonEntry} */
    const entry = {
      type,
      path: target,
      relative: path.relative(root, target),
      exists: type === "directory" ? isDirectory(target) : isFile(target),
    };
    if (content) {
      entry.content = content;
    }
    entries.push(entry);
  };
}

/**
 * What a new service would consist of: the playbook folder once, and a
 * group_vars folder with an empty env file in each environment that exists
 * right now -- or in each one serviceEnvironments names, when it names any.
 * Nothing is written -- the plan is what the confirmation shows.
 *
 * With `opts.starter`, the playbook folder also gets `<name>.yml`, a ping on
 * the service's group, so the service runs and shows up in the dashboard.
 *
 * @param {string} root workspace folder path
 * @param {string} name
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @param {{ starter?: boolean }} [opts]
 * @returns {SkeletonPlan}
 */
function planService(root, name, settings, opts = {}) {
  const config = withDefaults(settings);
  const complaint = validateServiceName(name);
  if (complaint) {
    throw new Error(complaint);
  }
  const service = name.trim();

  /** @type {SkeletonEntry[]} */
  const entries = [];
  const add = entryAdder(root, entries);

  const playbookDir = path.join(root, config.playbooksDir, service);
  add("directory", playbookDir);
  if (opts.starter) {
    add("file", path.join(playbookDir, `${service}.yml`), starterPlaybook(service));
  }

  const { selected: environments, unknown, limited } = selectEnvironments(
    findEnvironments(root, config),
    Array.isArray(config.serviceEnvironments) ? config.serviceEnvironments : [],
  );
  for (const environment of environments) {
    const dir = path.join(environment.groupVarsDir, service);
    add("directory", dir);
    add("file", path.join(dir, config.envFileName));
  }

  return {
    name: service,
    environments: environments.map((item) => item.name),
    unknownEnvironments: unknown,
    limited,
    entries,
  };
}

/**
 * Everything an empty folder needs to run its first playbook: ansible.cfg,
 * the roles directory, one service with a starter playbook, and one
 * environment whose inventory is `localhost` over a local connection.
 * Refuses a folder that already has an environment. Nothing is written.
 *
 * @param {string} root workspace folder path
 * @param {{ environment: string, service: string }} names
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @returns {SkeletonPlan & { environment: string }}
 */
function planWorkspace(root, names, settings) {
  const config = withDefaults(settings);
  const complaint = validateEnvironmentName(names.environment) || validateServiceName(names.service);
  if (complaint) {
    throw new Error(complaint);
  }
  const environment = names.environment.trim();
  const service = names.service.trim();
  if (findEnvironments(root, config).length) {
    throw new Error(`${path.basename(root)} already has an environment.`);
  }

  /** @type {SkeletonEntry[]} */
  const entries = [];
  const add = entryAdder(root, entries);

  add("file", path.join(root, "ansible.cfg"), `[defaults]\nroles_path = ${config.rolesDir}\n`);
  add("directory", path.join(root, config.rolesDir));

  const playbookDir = path.join(root, config.playbooksDir, service);
  add("directory", playbookDir);
  add("file", path.join(playbookDir, `${service}.yml`), starterPlaybook(service));

  const inventoryDir = path.join(root, config.inventoriesDir, environment);
  add("directory", inventoryDir);
  const yaml = [".yml", ".yaml"].includes(path.extname(config.inventoryFile).toLowerCase());
  const local = yaml
    ? `all:\n  children:\n    ${service}:\n      hosts:\n        localhost:\n          ansible_connection: local\n          ansible_python_interpreter: "{{ ansible_playbook_python }}"\n`
    : `[${service}]\nlocalhost ansible_connection=local ansible_python_interpreter="{{ ansible_playbook_python }}"\n`;
  add("file", path.join(inventoryDir, config.inventoryFile), local);

  const groupVars = path.join(inventoryDir, config.groupVarsDir, service);
  add("directory", groupVars);
  add("file", path.join(groupVars, config.envFileName));

  return {
    name: service,
    environment,
    environments: [environment],
    unknownEnvironments: [],
    limited: false,
    entries,
  };
}

/**
 * @param {unknown} err
 * @param {string} code
 */
function isErrno(err, code) {
  return Boolean(
    err && typeof err === "object" && /** @type {{ code?: unknown }} */ (err).code === code,
  );
}

/**
 * Carry out a plan, reporting what was created and what was already there.
 *
 * Files are opened with "wx", so an env file that exists is left exactly as it
 * is: running this against a service that is only missing from one environment
 * fills the gap without touching the environments that have it.
 *
 * @param {{ entries: SkeletonEntry[] }} plan
 * @returns {{ created: SkeletonEntry[], skipped: SkeletonEntry[] }}
 */
function createSkeleton(plan) {
  /** @type {SkeletonEntry[]} */
  const created = [];
  /** @type {SkeletonEntry[]} */
  const skipped = [];

  for (const entry of plan.entries) {
    if (entry.type === "directory") {
      // mkdir -p names the first directory it made, and nothing at all when
      // there was nothing to make.
      const made = fs.mkdirSync(entry.path, { recursive: true });
      (made === undefined ? skipped : created).push(entry);
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(entry.path), { recursive: true });
      fs.writeFileSync(entry.path, entry.content || "", { flag: "wx" });
      created.push(entry);
    } catch (err) {
      if (!isErrno(err, "EEXIST")) {
        throw err;
      }
      skipped.push(entry);
    }
  }

  return { created, skipped };
}

module.exports = {
  createSkeleton,
  existingServiceNames,
  groupHasHosts,
  planService,
  planWorkspace,
  selectEnvironments,
  starterPlaybook,
  validateServiceName,
};
