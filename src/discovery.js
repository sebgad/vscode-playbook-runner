/**
 * Filesystem discovery: environments, playbooks and vaults.
 *
 * This is the module that replaces the fixed paths in the shell scripts --
 * there is no list of environment names anywhere, `inventories/` is simply
 * read. It imports `vscode` on purpose nowhere at all, so it can be exercised
 * from plain node in test/discovery.test.js.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = require("./defaults");

const PLAYBOOK_EXTENSIONS = new Set([".yml", ".yaml"]);

/** Label for playbooks lying directly in playbooks/ rather than in a subfolder. */
const ROOT_GROUP = "(root)";

/**
 * @param {string} target
 * @returns {fs.Stats | null}
 */
function statOrNull(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

/** @param {string} target */
function isDirectory(target) {
  const stats = statOrNull(target);
  return Boolean(stats && stats.isDirectory());
}

/** @param {string} target */
function isFile(target) {
  const stats = statOrNull(target);
  return Boolean(stats && stats.isFile());
}

/**
 * Immediate subdirectory names, sorted, symlinked directories included.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listDirectoryNames(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() ||
        (entry.isSymbolicLink() && isDirectory(path.join(dir, entry.name))),
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The real path of a directory, or null when it cannot be resolved. Used to
 * recognise a directory that has already been walked, however it was reached.
 *
 * @param {string} target
 * @returns {string | null}
 */
function realPathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Playbook files below `dir`, named relative to it. The bash script used
 * `find`, so nested layouts kept working; recursing here preserves that.
 *
 * Symlinked directories are followed -- `playbooks/shared -> ../common` is a
 * reasonable thing to have -- so the walk keeps the real path of everything it
 * has entered: a link pointing at an ancestor is a cycle, not infinite work.
 *
 * @param {string} dir
 * @param {{ recursive?: boolean }} [opts]
 * @returns {{ name: string, file: string }[]}
 */
function listPlaybookFiles(dir, opts = {}) {
  const recursive = opts.recursive !== false;
  /** @type {{ name: string, file: string }[]} */
  const found = [];
  /** @type {Set<string>} */
  const visited = new Set();

  /** @param {string} current */
  const walk = (current) => {
    const real = realPathOrNull(current);
    if (real === null || visited.has(real)) {
      return;
    }
    visited.add(real);

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (isDirectory(full)) {
        if (recursive) {
          walk(full);
        }
        continue;
      }
      if (!PLAYBOOK_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      found.push({ name: path.relative(dir, full), file: full });
    }
  };

  walk(dir);
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

/**
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @returns {import("./defaults").Settings}
 */
function withDefaults(settings) {
  return { ...DEFAULTS, ...(settings || {}) };
}

/**
 * @typedef {object} Environment
 * @property {string} name          directory name, e.g. "production"
 * @property {string} dir           inventories/<name>
 * @property {string} inventory     inventories/<name>/hosts.ini
 * @property {string} groupVarsDir  inventories/<name>/group_vars
 */

/**
 * Every directory under `inventories/` that actually holds an inventory file.
 * Dropping in `inventories/lab/hosts.ini` is all it takes to gain a third
 * environment; nothing here knows the words "staging" or "production".
 *
 * @param {string} root workspace folder path
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @returns {Environment[]}
 */
function findEnvironments(root, settings) {
  const config = withDefaults(settings);
  const base = path.join(root, config.inventoriesDir);

  /** @type {Environment[]} */
  const environments = [];
  for (const name of listDirectoryNames(base)) {
    const dir = path.join(base, name);
    const inventory = path.join(dir, config.inventoryFile);
    if (!isFile(inventory)) {
      continue;
    }
    environments.push({
      name,
      dir,
      inventory,
      groupVarsDir: path.join(dir, config.groupVarsDir),
    });
  }
  return environments;
}

/**
 * @typedef {object} InventoryCandidate
 * @property {string} name directory name under the inventories directory
 * @property {string} dir
 */

/**
 * Directories under `inventories/` that have no inventory file yet, so the
 * Inventory tab can offer to create one.
 *
 * @param {string} root workspace folder path
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @returns {InventoryCandidate[]}
 */
function findInventoryCandidates(root, settings) {
  const config = withDefaults(settings);
  const base = path.join(root, config.inventoriesDir);
  return listDirectoryNames(base)
    .map((name) => ({ name, dir: path.join(base, name) }))
    .filter((candidate) => !isFile(path.join(candidate.dir, config.inventoryFile)));
}

/**
 * @typedef {object} PlaybookGroup
 * @property {string} name
 * @property {string} dir
 * @property {{ name: string, file: string }[]} playbooks
 */

/**
 * One group per subfolder of `playbooks/`, plus a "(root)" group for loose
 * files. Groups without a playbook in them are left out -- an empty folder is
 * nothing you can run. Playbooks are environment-independent, so this is
 * scanned once and shared by every environment node.
 *
 * @param {string} root
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @returns {PlaybookGroup[]}
 */
function findPlaybooks(root, settings) {
  const config = withDefaults(settings);
  const base = path.join(root, config.playbooksDir);
  if (!isDirectory(base)) {
    return [];
  }

  /** @type {PlaybookGroup[]} */
  const groups = [];

  const loose = listPlaybookFiles(base, { recursive: false });
  if (loose.length) {
    groups.push({ name: ROOT_GROUP, dir: base, playbooks: loose });
  }

  for (const name of listDirectoryNames(base)) {
    const dir = path.join(base, name);
    const playbooks = listPlaybookFiles(dir);
    if (!playbooks.length) {
      continue;
    }
    groups.push({ name, dir, playbooks });
  }

  return groups;
}

/**
 * @typedef {object} VaultGroup
 * @property {string} name
 * @property {string} dir
 * @property {string} envFile    group_vars/<name>/env.yml
 * @property {boolean} hasEnv
 * @property {string} vaultFile  group_vars/<name>/vault.yml
 * @property {boolean} hasVault
 */

/**
 * Every group_vars directory of an environment, with its two files flagged by
 * existence. `hasVault` drives both vault operations -- groups that have one
 * can be edited, the others created, which is the whole difference between the
 * two vault commands -- while `envFile` is the plain, unencrypted half the dashboard
 * opens in the editor.
 *
 * One env and one vault per group is assumed: they are fixed filenames, not a
 * scan, so nothing below this ever has to deal with a list of either.
 *
 * @param {Environment} [environment]
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @returns {VaultGroup[]}
 */
function findVaultGroups(environment, settings) {
  const config = withDefaults(settings);
  if (!environment || !isDirectory(environment.groupVarsDir)) {
    return [];
  }

  return listDirectoryNames(environment.groupVarsDir).map((name) => {
    const dir = path.join(environment.groupVarsDir, name);
    const envFile = path.join(dir, config.envFileName);
    const vaultFile = path.join(dir, config.vaultFileName);
    return {
      name,
      dir,
      envFile,
      hasEnv: isFile(envFile),
      vaultFile,
      hasVault: isFile(vaultFile),
    };
  });
}

/**
 * @typedef {object} Service
 * @property {string} name
 * @property {{ name: string, file: string }[]} playbooks
 * @property {string | null} playbooksDir  playbooks/<name>, when it exists
 * @property {VaultGroup | null} vars      group_vars/<name>, when it exists
 */

/**
 * The services of one environment: `playbooks/<name>/` and
 * `group_vars/<name>/` joined on their directory name, which is how this
 * repository already pairs them (playbooks/authentik ↔ group_vars/authentik).
 *
 * A service needs only one of the two halves -- `group_vars/all` has no
 * playbooks, a playbook folder may exist before the environment has any
 * variables for it -- so this is a union, not an intersection.
 *
 * @param {string} root
 * @param {Environment} [environment]
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @returns {Service[]}
 */
function findServices(root, environment, settings) {
  /** @type {Map<string, Service>} */
  const services = new Map();

  /** @param {string} name */
  const ensure = (name) => {
    let service = services.get(name);
    if (!service) {
      service = { name, playbooks: [], playbooksDir: null, vars: null };
      services.set(name, service);
    }
    return service;
  };

  for (const group of findPlaybooks(root, settings)) {
    const service = ensure(group.name);
    service.playbooks = group.playbooks;
    service.playbooksDir = group.dir;
  }

  for (const group of findVaultGroups(environment, settings)) {
    ensure(group.name).vars = group;
  }

  return [...services.values()].sort((a, b) => {
    if (a.name === ROOT_GROUP || b.name === ROOT_GROUP) {
      return a.name === ROOT_GROUP ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

module.exports = {
  DEFAULTS,
  ROOT_GROUP,
  findEnvironments,
  findInventoryCandidates,
  findPlaybooks,
  findServices,
  findVaultGroups,
  isDirectory,
  isFile,
  listDirectoryNames,
  listPlaybookFiles,
};
