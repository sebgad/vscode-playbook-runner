/**
 * The QuickPick chain -- environment, folder, playbook -- that the palette
 * commands use. It is the same walk the tree offers by clicking, and the same
 * one the bash scripts did with `read -p`, so both habits share one code path.
 */

"use strict";

const path = require("path");
const vscode = require("vscode");

const { findEnvironments, findPlaybooks, findVaultGroups } = require("./discovery");
const { validateServiceName } = require("./scaffold");
const { productionPattern } = require("./settings");
const { buildTagChoices, formatTagList, parseTagList } = require("./tags");

/**
 * @returns {Promise<vscode.WorkspaceFolder | undefined>}
 */
async function pickFolder() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) {
    vscode.window.showErrorMessage("Playbook Runner: no folder is open.");
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, folder })),
    { title: "Select workspace folder", matchOnDescription: true },
  );
  return picked && picked.folder;
}

/**
 * @param {vscode.WorkspaceFolder} folder
 * @param {import("./defaults").Settings} settings
 */
async function pickEnvironment(folder, settings) {
  const environments = findEnvironments(folder.uri.fsPath, settings);
  if (!environments.length) {
    vscode.window.showErrorMessage(
      `Playbook Runner: no environment with a ${settings.inventoryFile} under ${settings.inventoriesDir}/.`,
    );
    return undefined;
  }
  if (environments.length === 1) {
    return environments[0];
  }

  const production = productionPattern(settings);
  const picked = await vscode.window.showQuickPick(
    environments.map((environment) => ({
      label: production && production.test(environment.name)
        ? `$(warning) ${environment.name}`
        : `$(beaker) ${environment.name}`,
      description: path.relative(folder.uri.fsPath, environment.inventory),
      environment,
    })),
    { title: "Select environment" },
  );
  return picked && picked.environment;
}

/**
 * @param {vscode.WorkspaceFolder} folder
 * @param {import("./defaults").Settings} settings
 * @returns {Promise<string | undefined>} absolute playbook path
 */
async function pickPlaybook(folder, settings) {
  const groups = findPlaybooks(folder.uri.fsPath, settings);
  if (!groups.length) {
    vscode.window.showErrorMessage(
      `Playbook Runner: no playbooks found under ${settings.playbooksDir}/.`,
    );
    return undefined;
  }

  const group =
    groups.length === 1
      ? groups[0]
      : (
          await vscode.window.showQuickPick(
            groups.map((item) => ({
              label: item.name,
              description: `${item.playbooks.length} playbook${
                item.playbooks.length === 1 ? "" : "s"
              }`,
              group: item,
            })),
            { title: "Select service" },
          )
        )?.group;
  if (!group) {
    return undefined;
  }

  if (group.playbooks.length === 1) {
    return group.playbooks[0]?.file;
  }
  const picked = await vscode.window.showQuickPick(
    group.playbooks.map((playbook) => ({ label: playbook.name, playbook })),
    { title: `Select playbook in ${group.name}` },
  );
  return picked && picked.playbook.file;
}

/**
 * @param {import("./discovery").Environment} environment
 * @param {import("./defaults").Settings} settings
 * @param {"edit" | "create"} action
 */
async function pickVaultGroup(environment, settings, action) {
  const groups = findVaultGroups(environment, settings).filter((group) =>
    action === "edit" ? group.hasVault : !group.hasVault,
  );
  if (!groups.length) {
    vscode.window.showErrorMessage(
      action === "edit"
        ? `Playbook Runner: no ${settings.vaultFileName} in ${environment.name}.`
        : `Playbook Runner: every group in ${environment.name} already has a ${settings.vaultFileName}.`,
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    groups.map((group) => ({ label: group.name, group })),
    { title: action === "edit" ? "Select vault to edit" : "Select group to create a vault for" },
  );
  return picked && picked.group;
}

/**
 * The name of a service to lay out. Rejected names are reported by the input
 * box itself, and a name that is already in use is a warning rather than a
 * refusal: the skeleton fills in the environments a service is missing from.
 *
 * @param {string[]} existingNames
 * @returns {Promise<string | undefined>}
 */
async function pickServiceName(existingNames) {
  const taken = new Set(existingNames);
  const name = await vscode.window.showInputBox({
    title: "New service skeleton",
    prompt: "Directory name, used for playbooks/<name>/ and group_vars/<name>/ in every environment",
    placeHolder: "uptime-kuma",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const complaint = validateServiceName(value);
      if (complaint) {
        return complaint;
      }
      if (taken.has(value.trim())) {
        return {
          message: `${value.trim()} already exists — only what is missing will be created.`,
          severity: vscode.InputBoxValidationSeverity.Warning,
        };
      }
      return undefined;
    },
  });
  return name === undefined ? undefined : name.trim();
}

/**
 * The free-text way in, and the whole of it when nothing was discovered.
 *
 * @param {string[]} current
 * @returns {Promise<string | undefined>}
 */
async function promptForTags(current) {
  const tags = await vscode.window.showInputBox({
    title: "Ansible tags",
    prompt: "Comma-separated, passed to --tags",
    value: formatTagList(current),
    ignoreFocusOut: true,
  });
  return tags === undefined ? undefined : formatTagList(parseTagList(tags));
}

/** The item that leaves the checkbox list for the input box. */
const TYPE_TAGS_BY_HAND = "\u0000other";

/**
 * The tags of a run, as a checkbox list of what the playbook actually has.
 *
 * The list is what src/tags.js read out of the YAML, so it is a good list
 * rather than a guaranteed one -- a templated tag is not in it, and neither is
 * anything written in a shape the scanner does not know. Hence the last row:
 * "Other…" hands over to the input box, seeded with whatever is ticked, so a
 * tag the scan missed is still one QuickPick away rather than a dead end. When
 * the scan found nothing at all the input box is all there is, which is exactly
 * what this asked before there was a list.
 *
 * @param {import("./tags").PlaybookTag[]} available
 * @param {string} [previous] the --tags of the last run of this playbook
 * @returns {Promise<string | undefined>}
 */
async function pickTags(available, previous) {
  const selected = parseTagList(previous);
  if (!available.length) {
    return promptForTags(selected);
  }

  /** @typedef {vscode.QuickPickItem & { tag?: string }} TagItem */
  /** @type {TagItem[]} */
  const items = buildTagChoices(available, selected).map((choice) => ({
    label: choice.name,
    description: choice.known
      ? choice.sources.join(", ")
      : "kept from the last run — not found in this playbook",
    picked: choice.picked,
    tag: choice.name,
  }));
  items.push(
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(edit) Other…",
      description: "type the tags by hand",
      picked: false,
      tag: TYPE_TAGS_BY_HAND,
    },
  );

  const chosen = await vscode.window.showQuickPick(items, {
    title: "Ansible tags",
    placeHolder: "Tick the tags to pass to --tags",
    canPickMany: true,
  });
  if (!chosen) {
    return undefined;
  }

  const tags = chosen
    .map((item) => item.tag)
    .filter(
      /** @returns {tag is string} */
      (tag) => typeof tag === "string" && tag !== TYPE_TAGS_BY_HAND,
    );
  return chosen.some((item) => item.tag === TYPE_TAGS_BY_HAND)
    ? promptForTags(tags)
    : formatTagList(tags);
}

/**
 * Tags / verbosity / --check / --diff / --limit, in one multi-select followed
 * by the inputs for whatever was ticked.
 *
 * @param {import("./command").RunOptions} [previous]
 * @param {import("./tags").PlaybookTag[]} [availableTags] as read from the playbook
 * @returns {Promise<import("./command").RunOptions | undefined>}
 */
async function pickRunOptions(previous = {}, availableTags = []) {
  const items = [
    {
      label: "$(tag) Tags",
      detail: previous.tags
        ? `currently: ${previous.tags}`
        : availableTags.length
          ? `--tags · ${availableTags.length} found in this playbook`
          : "--tags",
      key: "tags",
      picked: Boolean(previous.tags),
    },
    {
      label: "$(output) Verbosity",
      detail: previous.verbosity ? `currently: -${"v".repeat(previous.verbosity)}` : "-v .. -vvvv",
      key: "verbosity",
      picked: Boolean(previous.verbosity),
    },
    {
      label: "$(target) Limit",
      detail: previous.limit ? `currently: ${previous.limit}` : "--limit",
      key: "limit",
      picked: Boolean(previous.limit),
    },
    {
      label: "$(beaker) Check (dry run)",
      detail: "--check",
      key: "check",
      picked: Boolean(previous.check),
    },
    { label: "$(diff) Diff", detail: "--diff", key: "diff", picked: Boolean(previous.diff) },
  ];

  const chosen = await vscode.window.showQuickPick(items, {
    title: "Run options",
    canPickMany: true,
  });
  if (!chosen) {
    return undefined;
  }

  const keys = new Set(chosen.map((item) => item.key));
  /** @type {import("./command").RunOptions} */
  const options = { check: keys.has("check"), diff: keys.has("diff") };

  if (keys.has("tags")) {
    const tags = await pickTags(availableTags, previous.tags);
    if (tags === undefined) {
      return undefined;
    }
    options.tags = tags;
  }

  if (keys.has("limit")) {
    const limit = await vscode.window.showInputBox({
      title: "Limit",
      prompt: "Host or group pattern, passed to --limit",
      value: previous.limit || "",
      ignoreFocusOut: true,
    });
    if (limit === undefined) {
      return undefined;
    }
    options.limit = limit.trim();
  }

  if (keys.has("verbosity")) {
    const level = await vscode.window.showQuickPick(
      ["1", "2", "3", "4"].map((value) => ({
        label: `-${"v".repeat(Number(value))}`,
        description: value,
        value: Number(value),
      })),
      { title: "Verbosity level" },
    );
    if (!level) {
      return undefined;
    }
    options.verbosity = level.value;
  }

  return options;
}

/**
 * The modal shown before a production run, unless it is switched off.
 *
 * @param {import("./defaults").Settings} settings
 * @param {import("./discovery").Environment} environment
 * @param {string} description
 * @returns {Promise<boolean>}
 */
async function confirmProduction(settings, environment, description) {
  const production = productionPattern(settings);
  if (!settings.confirmProduction || !production || !production.test(environment.name)) {
    return true;
  }
  const answer = await vscode.window.showWarningMessage(
    `Run ${description} against ${environment.name}?`,
    { modal: true, detail: "This targets the production inventory." },
    "Run",
  );
  return answer === "Run";
}

/**
 * The modal shown before rotating vault passphrases.
 *
 * Asked in every environment, not only production: rekeying rewrites each vault
 * in place, and ansible-vault works through the list one file at a time -- a
 * failure part-way leaves the files it already reached on the new passphrase and
 * the rest on the old one, with nothing in the output saying where it stopped.
 *
 * The password-file warning is the one people actually get caught by: rekeying
 * does not touch the file the passphrase was read from, so every later run
 * authenticates with a passphrase the vaults no longer use.
 *
 * @param {import("./discovery").Environment} environment
 * @param {number} count
 * @param {string | null} passwordFile
 * @returns {Promise<boolean>}
 */
async function confirmRekey(environment, count, passwordFile) {
  const detail = [
    `All ${count} vault${count === 1 ? "" : "s"} in ${environment.name} are rewritten in place.`,
    "",
    "ansible-vault asks for the current passphrase, then the new one twice.",
    "",
    "If it fails part-way the vaults are left split between the old and the new passphrase, so commit the inventory first — the diff is then the record of how far it got.",
    passwordFile
      ? `\nAfterwards, update ${passwordFile}: it still holds the old passphrase, and every later run reads it.`
      : "",
  ]
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n");

  const answer = await vscode.window.showWarningMessage(
    `Rotate the vault passphrase for ${environment.name}?`,
    { modal: true, detail },
    "Rekey",
  );
  return answer === "Rekey";
}

module.exports = {
  confirmProduction,
  confirmRekey,
  pickEnvironment,
  pickFolder,
  pickPlaybook,
  pickRunOptions,
  pickServiceName,
  pickTags,
  pickVaultGroup,
};
