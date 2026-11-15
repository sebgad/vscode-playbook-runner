/**
 * Default values for every playbookRunner.* setting.
 *
 * Kept in its own module so that both the settings reader (which needs
 * `vscode`) and the discovery layer (which deliberately does not) can share
 * them, and so the discovery tests can run under plain node.
 *
 * The defaults are also the shape check: settings.js only accepts a configured
 * value whose runtime type matches the default below.
 */

"use strict";

/**
 * @typedef {object} Settings
 * @property {string} playbooksDir
 * @property {string} rolesDir
 * @property {string} inventoriesDir
 * @property {string} inventoryFile
 * @property {string} groupVarsDir
 * @property {string} envFileName
 * @property {string} vaultFileName
 * @property {string} vaultPasswordFilePattern
 * @property {Record<string, string>} vaultPasswordFiles
 * @property {string} productionPattern
 * @property {boolean} confirmProduction
 * @property {string} ansiblePlaybookCommand
 * @property {string} ansibleVaultCommand
 * @property {string[]} serviceEnvironments
 * @property {string[]} setupTags
 */

/** @type {Settings} */
const DEFAULTS = {
  // Repository layout -- everything the shell scripts used to hardcode.
  playbooksDir: "playbooks",
  rolesDir: "roles",
  inventoriesDir: "inventories",
  inventoryFile: "hosts.ini",
  groupVarsDir: "group_vars",
  envFileName: "env.yml",
  vaultFileName: "vault.yml",

  // Vault passwords.
  vaultPasswordFilePattern: "${userHome}/.ansible-vault/${env}.pass",
  vaultPasswordFiles: {},

  // Behaviour.
  productionPattern: "production",
  confirmProduction: true,
  ansiblePlaybookCommand: "ansible-playbook",
  ansibleVaultCommand: "ansible-vault",

  // Which environments Create Service Skeleton lays a service out in. Empty
  // means every environment discovered under inventoriesDir.
  serviceEnvironments: [],

  // Tags whose tasks still run before the start of a task range, because the
  // tasks after it need the facts they set. Empty: no tag is special.
  setupTags: [],
};

module.exports = DEFAULTS;
