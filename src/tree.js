/**
 * The Playbook Runner sidebar tree.
 *
 *   <environment>          production, staging, …
 *     <service>            playbooks/<name> joined with group_vars/<name>
 *       Playbooks
 *         <playbook.yml>   opens the file; the inline buttons run it
 *           <tag>          one row per tag the playbook offers
 *       Env                opens group_vars/<name>/env.yml
 *       Vault              edits it, or creates it when there is none yet
 *
 * A service has at most one env and one vault, so those two are rows that act
 * on click rather than sections to expand.
 *
 * The tags under a playbook are read out of the YAML by src/tags.js -- the same
 * list the run options offer as checkboxes, here to be read without opening a
 * picker and to run one tag on its own.
 */

"use strict";

const path = require("path");
const vscode = require("vscode");

const { playbookLabel } = require("./command");
const { findEnvironments, findServices } = require("./discovery");
const { findPlaybookTags } = require("./tags");
const { productionPattern, readSettings } = require("./settings");

const PRODUCTION_COLOR = new vscode.ThemeColor("charts.red");
const NEUTRAL_COLOR = new vscode.ThemeColor("charts.blue");

class MessageNode extends vscode.TreeItem {
  /**
   * @param {string} message
   * @param {string} [icon]
   */
  constructor(message, icon = "info") {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = "playbookRunner.message";
  }
}

class EnvironmentNode extends vscode.TreeItem {
  /**
   * @param {import("./discovery").Environment} environment
   * @param {vscode.WorkspaceFolder} folder
   * @param {import("./defaults").Settings} settings
   * @param {boolean} isProduction
   */
  constructor(environment, folder, settings, isProduction) {
    super(environment.name, vscode.TreeItemCollapsibleState.Expanded);
    this.environment = environment;
    this.folder = folder;
    this.settings = settings;
    this.isProduction = isProduction;
    this.contextValue = "playbookRunner.environment";
    this.iconPath = new vscode.ThemeIcon(
      isProduction ? "server-environment" : "beaker",
      isProduction ? PRODUCTION_COLOR : NEUTRAL_COLOR,
    );

    const tooltip = new vscode.MarkdownString(undefined, true);
    if (isProduction) {
      tooltip.appendMarkdown("$(warning) **Production**\n\n");
    }
    tooltip.appendMarkdown(
      `Inventory: \`${path.relative(folder.uri.fsPath, environment.inventory)}\``,
    );
    this.tooltip = tooltip;
  }
}

class SectionNode extends vscode.TreeItem {
  /**
   * @param {string} name
   * @param {string} icon
   * @param {() => vscode.TreeItem[] | Promise<vscode.TreeItem[]>} childrenOf
   * @param {number} [count]
   */
  constructor(name, icon, childrenOf, count) {
    super(name, vscode.TreeItemCollapsibleState.Collapsed);
    this.childrenOf = childrenOf;
    this.contextValue = "playbookRunner.section";
    this.iconPath = new vscode.ThemeIcon(icon);
    if (typeof count === "number") {
      this.description = `${count}`;
    }
  }
}

class ServiceNode extends vscode.TreeItem {
  /**
   * @param {import("./discovery").Service} service
   * @param {EnvironmentNode} parent
   */
  constructor(service, parent) {
    super(service.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.service = service;
    // Everything a playbook or vault row below needs, so those nodes do not
    // have to walk back up to the environment.
    this.environment = parent.environment;
    this.folder = parent.folder;
    this.settings = parent.settings;
    this.isProduction = parent.isProduction;
    this.contextValue = "playbookRunner.service";
    this.iconPath = new vscode.ThemeIcon("server-process");

    // No codicons here -- TreeItem.description is plain text.
    const parts = [];
    if (service.playbooks.length) {
      parts.push(`${service.playbooks.length}`);
    }
    if (service.vars && !service.vars.hasVault) {
      parts.push("no vault");
    }
    this.description = parts.join(" · ");

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`**${service.name}** — ${parent.environment.name}\n\n`);
    if (service.playbooksDir) {
      tooltip.appendMarkdown(
        `Playbooks: \`${path.relative(parent.folder.uri.fsPath, service.playbooksDir)}\`\n\n`,
      );
    }
    if (service.vars) {
      tooltip.appendMarkdown(
        `Variables: \`${path.relative(parent.folder.uri.fsPath, service.vars.dir)}\``,
      );
    }
    this.tooltip = tooltip;
  }
}

class PlaybookNode extends vscode.TreeItem {
  /**
   * @param {{ name: string, file: string }} playbook
   * @param {ServiceNode} parent
   * @param {import("./tags").PlaybookTag[]} [tags] as read out of the YAML
   */
  constructor(playbook, parent, tags = []) {
    // A playbook whose tags were not found stays a leaf: an arrow that opens
    // onto nothing is worse than no arrow.
    super(
      playbook.name,
      tags.length
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.playbookFile = playbook.file;
    this.tags = tags;
    this.environment = parent.environment;
    this.folder = parent.folder;
    this.settings = parent.settings;
    this.isProduction = parent.isProduction;
    this.contextValue = "playbookRunner.playbook";
    this.resourceUri = vscode.Uri.file(playbook.file);
    this.iconPath = new vscode.ThemeIcon(
      "play",
      parent.isProduction ? PRODUCTION_COLOR : NEUTRAL_COLOR,
    );

    const label = playbookLabel(parent.folder.uri.fsPath, parent.settings, playbook.file);
    const tooltip = new vscode.MarkdownString(undefined, true);
    if (parent.isProduction) {
      tooltip.appendMarkdown("$(warning) **Production**\n\n");
    }
    tooltip.appendMarkdown("$(go-to-file) Open in the editor — $(play) runs it\n\n");
    if (tags.length) {
      tooltip.appendMarkdown(
        `$(tag) ${tags.length} tag${tags.length === 1 ? "" : "s"} — expand to run one on its own\n\n`,
      );
    }
    tooltip.appendCodeblock(
      `ansible-playbook -i ${path.relative(
        parent.folder.uri.fsPath,
        parent.environment.inventory,
      )} ${path.relative(parent.folder.uri.fsPath, playbook.file)}`,
      "shell",
    );
    tooltip.appendMarkdown(`\n\n${parent.environment.name} — ${label}`);
    this.tooltip = tooltip;

    // Opening, not running: a click is how a file is read everywhere else in
    // the editor, and running lives one deliberate move away on the inline
    // buttons -- which is also what keeps a stray click off production.
    this.command = {
      command: "playbookRunner.openPlaybook",
      title: "Open Playbook",
      arguments: [this],
    };
  }
}

class TagNode extends vscode.TreeItem {
  /**
   * One `--tags` value of the playbook above it. The inline $(play) runs the
   * playbook with this tag and nothing else; a click opens the playbook, the
   * same as the row it hangs under -- running stays on the button, which is
   * what keeps a stray click off production.
   *
   * @param {import("./tags").PlaybookTag} tag
   * @param {PlaybookNode} parent
   */
  constructor(tag, parent) {
    super(tag.name, vscode.TreeItemCollapsibleState.None);
    this.tag = tag.name;
    this.playbookFile = parent.playbookFile;
    this.environment = parent.environment;
    this.folder = parent.folder;
    this.settings = parent.settings;
    this.isProduction = parent.isProduction;
    this.contextValue = "playbookRunner.tag";
    this.iconPath = new vscode.ThemeIcon(
      "tag",
      parent.isProduction ? PRODUCTION_COLOR : NEUTRAL_COLOR,
    );
    // Where it was found: the roles it came through, and nothing at all when
    // the playbook writes it itself.
    this.description = tag.sources.join(", ");

    const root = parent.folder.uri.fsPath;
    const tooltip = new vscode.MarkdownString(undefined, true);
    if (parent.isProduction) {
      tooltip.appendMarkdown("$(warning) **Production**\n\n");
    }
    tooltip.appendMarkdown("$(play) Runs the playbook with only this tag\n\n");
    tooltip.appendCodeblock(
      `ansible-playbook -i ${path.relative(
        root,
        parent.environment.inventory,
      )} ${path.relative(root, parent.playbookFile)} --tags ${tag.name}`,
      "shell",
    );
    tooltip.appendMarkdown(
      `\n\n${
        tag.sources.length
          ? `From ${tag.sources.join(", ")}`
          : "Written in the playbook itself"
      }`,
    );
    this.tooltip = tooltip;

    this.command = {
      command: "playbookRunner.openPlaybook",
      title: "Open Playbook",
      arguments: [this],
    };
  }
}

class EnvNode extends vscode.TreeItem {
  /**
   * The unencrypted half of a service's variables. Plain YAML, so a click
   * opens it in the editor instead of going through ansible.
   *
   * @param {import("./discovery").VaultGroup} group
   * @param {ServiceNode} parent
   */
  constructor(group, parent) {
    super("Env", vscode.TreeItemCollapsibleState.None);
    this.envFile = group.envFile;
    this.environment = parent.environment;
    this.folder = parent.folder;
    this.contextValue = "playbookRunner.env";
    this.resourceUri = vscode.Uri.file(group.envFile);
    this.iconPath = new vscode.ThemeIcon("symbol-variable", NEUTRAL_COLOR);

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(`$(go-to-file) Open in the editor\n\n`);
    tooltip.appendMarkdown(`\`${path.relative(parent.folder.uri.fsPath, group.envFile)}\``);
    this.tooltip = tooltip;

    this.command = {
      command: "playbookRunner.openEnv",
      title: "Open Env File",
      arguments: [this],
    };
  }
}

class VaultNode extends vscode.TreeItem {
  /**
   * @param {import("./discovery").VaultGroup} group
   * @param {ServiceNode} parent
   */
  constructor(group, parent) {
    super("Vault", vscode.TreeItemCollapsibleState.None);
    this.vaultFile = group.vaultFile;
    this.hasVault = group.hasVault;
    this.environment = parent.environment;
    this.folder = parent.folder;
    this.contextValue = group.hasVault ? "playbookRunner.vault" : "playbookRunner.vaultMissing";
    this.iconPath = new vscode.ThemeIcon(group.hasVault ? "lock" : "add");
    this.description = group.hasVault ? "" : "create";

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown(
      group.hasVault
        ? `$(edit) \`ansible-vault edit\`\n\n`
        : `$(add) \`ansible-vault create\`\n\n`,
    );
    tooltip.appendMarkdown(`\`${path.relative(parent.folder.uri.fsPath, group.vaultFile)}\``);
    this.tooltip = tooltip;

    this.command = {
      command: group.hasVault ? "playbookRunner.editVault" : "playbookRunner.createVault",
      title: group.hasVault ? "Edit Vault" : "Create Vault",
      arguments: [this],
    };
  }
}

class FolderNode extends vscode.TreeItem {
  /**
   * @param {vscode.WorkspaceFolder} folder
   */
  constructor(folder) {
    super(folder.name, vscode.TreeItemCollapsibleState.Expanded);
    this.folder = folder;
    this.contextValue = "playbookRunner.folder";
    this.iconPath = new vscode.ThemeIcon("root-folder");
  }
}

class PlaybookRunnerTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  /** @param {vscode.TreeItem} element */
  getTreeItem(element) {
    return element;
  }

  /** @param {vscode.TreeItem} [element] */
  async getChildren(element) {
    if (!element) {
      const folders = vscode.workspace.workspaceFolders || [];
      const [first] = folders;
      if (!first) {
        return [new MessageNode("Open a folder with playbooks to see them")];
      }
      if (folders.length === 1) {
        return this.folderChildren(first);
      }
      return folders.map((folder) => new FolderNode(folder));
    }

    if (element instanceof FolderNode) {
      return this.folderChildren(element.folder);
    }
    if (element instanceof EnvironmentNode) {
      return this.environmentChildren(element);
    }
    if (element instanceof ServiceNode) {
      return this.serviceChildren(element);
    }
    if (element instanceof PlaybookNode) {
      return element.tags.map((tag) => new TagNode(tag, element));
    }
    if (element instanceof SectionNode) {
      return element.childrenOf();
    }
    return [];
  }

  /**
   * @param {vscode.WorkspaceFolder} folder
   * @returns {vscode.TreeItem[]}
   */
  folderChildren(folder) {
    const settings = readSettings(folder);
    const production = productionPattern(settings);
    const root = folder.uri.fsPath;

    /** @type {vscode.TreeItem[]} */
    const nodes = [];

    const environments = findEnvironments(root, settings);
    if (!environments.length) {
      nodes.push(
        new MessageNode(
          `No environments found under ${settings.inventoriesDir}/ (looking for ${settings.inventoryFile})`,
          "warning",
        ),
      );
    }
    for (const environment of environments) {
      nodes.push(
        new EnvironmentNode(
          environment,
          folder,
          settings,
          Boolean(production && production.test(environment.name)),
        ),
      );
    }

    return nodes;
  }

  /**
   * @param {EnvironmentNode} node
   * @returns {vscode.TreeItem[]}
   */
  environmentChildren(node) {
    const services = findServices(node.folder.uri.fsPath, node.environment, node.settings);
    if (!services.length) {
      return [
        new MessageNode(
          `No services found under ${node.settings.playbooksDir}/ or ${path.relative(
            node.folder.uri.fsPath,
            node.environment.groupVarsDir,
          )}/`,
          "warning",
        ),
      ];
    }
    return services.map((service) => new ServiceNode(service, node));
  }

  /**
   * The playbook rows of a service, each carrying the tags it offers.
   *
   * The scan happens here rather than when a playbook is expanded, because
   * whether the row gets an arrow at all depends on the answer. It is about a
   * millisecond of file reading per playbook, and it runs only once the
   * Playbooks section is opened.
   *
   * @param {ServiceNode} node
   * @returns {vscode.TreeItem[]}
   */
  playbookNodes(node) {
    const root = node.folder.uri.fsPath;
    return node.service.playbooks.map(
      (playbook) =>
        new PlaybookNode(
          playbook,
          node,
          findPlaybookTags(root, playbook.file, node.settings),
        ),
    );
  }

  /**
   * Playbooks, Env and Vault -- only what the service actually has. A section
   * or row that leads nowhere is left out rather than shown empty.
   *
   * @param {ServiceNode} node
   * @returns {vscode.TreeItem[]}
   */
  serviceChildren(node) {
    const { service } = node;

    /** @type {vscode.TreeItem[]} */
    const children = [];

    if (service.playbooks.length) {
      children.push(
        new SectionNode(
          "Playbooks",
          "book",
          () => this.playbookNodes(node),
          service.playbooks.length,
        ),
      );
    }

    if (service.vars && service.vars.hasEnv) {
      children.push(new EnvNode(service.vars, node));
    }
    if (service.vars) {
      children.push(new VaultNode(service.vars, node));
    }

    return children;
  }
}

module.exports = {
  EnvNode,
  EnvironmentNode,
  PlaybookRunnerTreeProvider,
  PlaybookNode,
  ServiceNode,
  TagNode,
  VaultNode,
};
