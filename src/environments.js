/**
 * Adding, renaming and removing an environment.
 *
 * An environment is a directory under `inventories/` that holds an inventory
 * file (see findEnvironments in ./discovery.js), so all three are operations
 * on one directory -- and all three are planned here before anything touches
 * the disk, so the confirmation shows exactly what will happen.
 *
 * Like scaffold.js this imports no `vscode`: which paths are created, moved
 * or removed is decided here and exercised in test/environments.test.js. The
 * one thing left to the editor is the removal itself, because only VS Code
 * can move a directory to the trash.
 *
 * A new environment gets structure only. The inventory names the groups of
 * the environment it was modelled on and none of its hosts -- a copied host
 * list would make the new environment deploy to the old one's machines -- the
 * env files are empty, and no vault is copied: each environment has a
 * passphrase of its own.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = require("./defaults");
const { findEnvironments, findVaultGroups, isDirectory, isFile } = require("./discovery");
const { isProductionName, resolveVaultPasswordFile } = require("./paths");

/**
 * An environment name is a directory name, an inventory path and a key in
 * settings; it stays in the same character set a service name does. A
 * separator or a leading dot is refused, not quoted: this creates, moves and
 * removes paths.
 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Inventory formats whose groups cannot be read as INI sections. */
const STRUCTURED_INVENTORY = new Set([".yml", ".yaml", ".json", ".toml"]);

/**
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @returns {import("./defaults").Settings}
 */
function withDefaults(settings) {
  return { ...DEFAULTS, ...(settings || {}) };
}

/**
 * The complaint about a proposed environment name, or null when it is usable.
 *
 * @param {string} name
 * @returns {string | null}
 */
function validateEnvironmentName(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) {
    return "Enter an environment name.";
  }
  if (!NAME_PATTERN.test(trimmed)) {
    return "An environment name is a directory: letters, digits, dot, dash and underscore, starting with a letter or digit.";
  }
  return null;
}

/**
 * The group structure of an INI inventory, without a single host: every
 * `[group]` header, and `[group:children]` with its members, which are group
 * names. Host lines, `[group:vars]` sections and comments are dropped.
 *
 * @param {string} text
 * @returns {string}
 */
function inventoryGroupSkeleton(text) {
  /** @type {{ header: string, children: string[] }[]} */
  const sections = [];
  /** @type {{ header: string, children: string[] } | null} */
  let childrenOf = null;

  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    const header = /^\[([^\]\s]+)\]\s*(?:[#;].*)?$/.exec(trimmed);
    if (!header) {
      if (childrenOf) {
        const member = /** @type {string} */ (trimmed.split(/\s+/)[0]);
        if (NAME_PATTERN.test(member) && !childrenOf.children.includes(member)) {
          childrenOf.children.push(member);
        }
      }
      continue;
    }
    const name = /** @type {string} */ (header[1]);
    childrenOf = null;
    if (name.endsWith(":vars")) {
      continue;
    }
    let section = sections.find((item) => item.header === name);
    if (!section) {
      section = { header: name, children: [] };
      sections.push(section);
    }
    if (name.endsWith(":children")) {
      childrenOf = section;
    }
  }

  return sections.map((section) => [`[${section.header}]`, ...section.children, "", ""].join("\n")).join("");
}

/**
 * @typedef {import("./scaffold").SkeletonEntry & { content?: string }} EnvironmentEntry
 */

/**
 * @typedef {object} EnvironmentPlan
 * @property {string} name
 * @property {string | null} from  the environment it is modelled on
 * @property {boolean} groupsCopied  the inventory names the source's groups
 * @property {EnvironmentEntry[]} entries
 */

/**
 * What a new environment would consist of: its directory, an inventory file
 * and group_vars/ -- and, modelled on another environment, that one's groups
 * in the inventory and a group_vars/<group>/ with an empty env file for each
 * of its groups. Nothing is written.
 *
 * @param {string} root workspace folder path
 * @param {string} name
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @param {{ from?: string | null }} [opts]
 * @returns {EnvironmentPlan}
 */
function planEnvironment(root, name, settings, opts = {}) {
  const config = withDefaults(settings);
  const complaint = validateEnvironmentName(name);
  if (complaint) {
    throw new Error(complaint);
  }
  const environment = name.trim();
  const dir = path.join(root, config.inventoriesDir, environment);
  const inventory = path.join(dir, config.inventoryFile);
  if (isFile(inventory)) {
    throw new Error(`${environment} is already an environment.`);
  }

  const existing = findEnvironments(root, config);
  const source = opts.from ? existing.find((item) => item.name === opts.from) : undefined;
  if (opts.from && !source) {
    throw new Error(`${opts.from} is not an environment.`);
  }

  let content = "";
  let groupsCopied = false;
  if (source && !STRUCTURED_INVENTORY.has(path.extname(config.inventoryFile).toLowerCase())) {
    try {
      content = inventoryGroupSkeleton(fs.readFileSync(source.inventory, "utf8"));
      groupsCopied = content !== "";
    } catch {
      content = "";
    }
  }

  /** @type {EnvironmentEntry[]} */
  const entries = [];
  /**
   * @param {"directory" | "file"} type
   * @param {string} target
   * @param {string} [fileContent]
   */
  const add = (type, target, fileContent) => {
    /** @type {EnvironmentEntry} */
    const entry = {
      type,
      path: target,
      relative: path.relative(root, target),
      exists: type === "directory" ? isDirectory(target) : isFile(target),
    };
    if (fileContent) {
      entry.content = fileContent;
    }
    entries.push(entry);
  };

  add("directory", dir);
  add("file", inventory, content);
  const groupVarsDir = path.join(dir, config.groupVarsDir);
  add("directory", groupVarsDir);
  for (const group of findVaultGroups(source, config)) {
    const groupDir = path.join(groupVarsDir, group.name);
    add("directory", groupDir);
    add("file", path.join(groupDir, config.envFileName));
  }

  return { name: environment, from: source ? source.name : null, groupsCopied, entries };
}

/**
 * @typedef {object} RenamePlan
 * @property {string} from
 * @property {string} to
 * @property {string} fromDir
 * @property {string} toDir
 * @property {string} relativeFrom
 * @property {string} relativeTo
 * @property {string[]} notes  what changes besides the directory name
 */

/**
 * Whether anything at all is at a path -- a dangling symlink included, which
 * a rename would otherwise replace.
 *
 * @param {string} target
 */
function occupied(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The move a rename comes down to, and what follows from the new name: the
 * production treatment and the vault password file both hang on it.
 *
 * @param {string} root
 * @param {string} from
 * @param {string} to
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @returns {RenamePlan}
 */
function planRename(root, from, to, settings) {
  const config = withDefaults(settings);
  const source = findEnvironments(root, config).find((item) => item.name === from);
  if (!source) {
    throw new Error(`${from} is not an environment.`);
  }
  const complaint = validateEnvironmentName(to);
  if (complaint) {
    throw new Error(complaint);
  }
  const name = to.trim();
  if (name === from) {
    throw new Error(`${from} is already called that.`);
  }
  const toDir = path.join(root, config.inventoriesDir, name);
  if (occupied(toDir)) {
    throw new Error(`${path.relative(root, toDir)} already exists.`);
  }

  /** @type {string[]} */
  const notes = [];
  const wasProduction = isProductionName(config, from);
  const isProduction = isProductionName(config, name);
  if (wasProduction && !isProduction) {
    notes.push(
      `${name} does not match playbookRunner.productionPattern: runs against it will no longer ask for confirmation.`,
    );
  } else if (!wasProduction && isProduction) {
    notes.push(`${name} matches playbookRunner.productionPattern: runs against it will ask for confirmation.`);
  }

  // The explicit entry moves with the name (renameInSettings); a file found
  // through the pattern does not, because the pattern has the name in it.
  const explicit = Boolean(config.vaultPasswordFiles && config.vaultPasswordFiles[from]);
  const before = resolveVaultPasswordFile(config, from, root);
  if (before && !explicit && !resolveVaultPasswordFile(config, name, root)) {
    notes.push(
      `The vault password file ${before} is found through playbookRunner.vaultPasswordFilePattern and will no longer match: runs will ask for the passphrase until it is renamed too.`,
    );
  }

  return {
    from,
    to: name,
    fromDir: source.dir,
    toDir,
    relativeFrom: path.relative(root, source.dir),
    relativeTo: path.relative(root, toDir),
    notes,
  };
}

/**
 * Carry out a rename. The target is checked again: the plan may be as old as
 * the confirmation dialog was open.
 *
 * @param {RenamePlan} plan
 */
function renameEnvironment(plan) {
  if (occupied(plan.toDir)) {
    throw new Error(`${plan.relativeTo} already exists.`);
  }
  fs.renameSync(plan.fromDir, plan.toDir);
}

/**
 * A setting that names environments, with one renamed -- or undefined when
 * the value does not mention it. An object is keyed by environment
 * (vaultPasswordFiles), an array lists them (serviceEnvironments).
 *
 * @param {unknown} value
 * @param {string} from
 * @param {string} to
 * @returns {unknown}
 */
function renameInSetting(value, from, to) {
  if (Array.isArray(value)) {
    if (!value.includes(from)) {
      return undefined;
    }
    return value
      .map((item) => (item === from ? to : item))
      .filter((item, index, all) => all.indexOf(item) === index);
  }
  if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, from)) {
    return undefined;
  }
  const source = /** @type {Record<string, unknown>} */ (value);
  /** @type {Record<string, unknown>} */
  const renamed = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === to) {
      continue; // the renamed environment's entry takes its place
    }
    renamed[key === from ? to : key] = entry;
  }
  return renamed;
}

/**
 * @typedef {object} DeletePlan
 * @property {string} name
 * @property {string} dir
 * @property {string} relative
 * @property {number} files
 * @property {number} vaults
 * @property {boolean} isLink  the directory is a symlink; not removed here
 * @property {boolean} isProduction
 * @property {boolean} isLast  no environment is left afterwards
 */

/**
 * @param {string} dir
 * @returns {number} files below dir, symlinks counted but not followed
 */
function countFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    count += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return count;
}

/**
 * What removing an environment takes with it. Nothing is removed here.
 *
 * @param {string} root
 * @param {string} name
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @returns {DeletePlan}
 */
function planDelete(root, name, settings) {
  const config = withDefaults(settings);
  const environments = findEnvironments(root, config);
  const environment = environments.find((item) => item.name === name);
  if (!environment) {
    throw new Error(`${name} is not an environment.`);
  }
  let isLink = false;
  try {
    isLink = fs.lstatSync(environment.dir).isSymbolicLink();
  } catch {
    isLink = false;
  }
  return {
    name,
    dir: environment.dir,
    relative: path.relative(root, environment.dir),
    files: countFiles(environment.dir),
    vaults: findVaultGroups(environment, config).filter((group) => group.hasVault).length,
    isLink,
    isProduction: isProductionName(config, name),
    isLast: environments.length === 1,
  };
}

module.exports = {
  inventoryGroupSkeleton,
  planDelete,
  planEnvironment,
  planRename,
  renameEnvironment,
  renameInSetting,
  validateEnvironmentName,
};
