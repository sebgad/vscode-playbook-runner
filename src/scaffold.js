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
 * What a new service would consist of: the playbook folder once, and a
 * group_vars folder with an empty env file in each environment that exists
 * right now -- or in each one serviceEnvironments names, when it names any.
 * Nothing is written -- the plan is what the confirmation shows.
 *
 * @param {string} root workspace folder path
 * @param {string} name
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @returns {SkeletonPlan}
 */
function planService(root, name, settings) {
  const config = withDefaults(settings);
  const complaint = validateServiceName(name);
  if (complaint) {
    throw new Error(complaint);
  }
  const service = name.trim();

  /** @type {SkeletonEntry[]} */
  const entries = [];

  /**
   * @param {"directory" | "file"} type
   * @param {string} target
   */
  const add = (type, target) => {
    entries.push({
      type,
      path: target,
      relative: path.relative(root, target),
      exists: type === "directory" ? isDirectory(target) : isFile(target),
    });
  };

  add("directory", path.join(root, config.playbooksDir, service));

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
  planService,
  selectEnvironments,
  validateServiceName,
};
