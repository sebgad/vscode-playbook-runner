/**
 * The dashboard: a webview editor tab, the extension's whole UI.
 *
 * Editor surface only. The page in media/dashboard/ renders what it is sent;
 * what it sends back goes through src/model.js -- parsed field by field, then
 * matched against what the model offered -- and a run goes through the same
 * startPlaybookRun as every other run, production modal and all.
 */

"use strict";

const crypto = require("crypto");
const path = require("path");
const vscode = require("vscode");

const { shellQuote } = require("./command");
const DEFAULTS = require("./defaults");
const { findEnvironments } = require("./discovery");
const model = require("./model");
const { readSettings } = require("./settings");
const settingsEdit = require("./settingsEdit");
const { findPlaybookOutline, findPlaybookTags } = require("./tags");

const VIEW_TYPE = "playbookRunner.dashboard";
const SECTION = "playbookRunner";

/**
 * One setting as the Settings tab shows it.
 *
 * @typedef {object} SettingView
 * @property {string} key
 * @property {string} group
 * @property {"string" | "boolean" | "list" | "map"} type
 * @property {string} description
 * @property {boolean} machine
 * @property {unknown} value          the effective value
 * @property {unknown} defaultValue
 * @property {unknown} userValue      undefined when not set there
 * @property {unknown} workspaceValue undefined when not set there
 */

/** @param {unknown} fallback */
function settingType(fallback) {
  if (typeof fallback === "boolean") {
    return "boolean";
  }
  if (Array.isArray(fallback)) {
    return "list";
  }
  return typeof fallback === "string" ? "string" : "map";
}

/**
 * Every playbookRunner.* setting with its description from package.json and
 * where its value comes from.
 *
 * @param {vscode.ExtensionContext} context
 * @returns {SettingView[]}
 */
function settingViews(context) {
  /** @type {Record<string, { description?: string, markdownDescription?: string }>} */
  const properties =
    (context.extension && context.extension.packageJSON.contributes.configuration.properties) || {};
  const config = vscode.workspace.getConfiguration(SECTION);
  return settingsEdit.SETTING_GROUPS.flatMap((group) =>
    group.keys.map((key) => {
      const spec = properties[`${SECTION}.${key}`] || {};
      const inspected = config.inspect(key);
      return {
        key,
        group: group.title,
        type: settingType(/** @type {Record<string, unknown>} */ (DEFAULTS)[key]),
        // `#playbookRunner.x#` is a settings-editor link; the tab shows text.
        description: (spec.markdownDescription || spec.description || "").replace(/#playbookRunner\.(\w+)#/g, "$1"),
        machine: settingsEdit.MACHINE_SETTINGS.includes(key),
        value: config.get(key),
        defaultValue: inspected ? inspected.defaultValue : undefined,
        userValue: inspected ? inspected.globalValue : undefined,
        workspaceValue: inspected ? inspected.workspaceValue : undefined,
      };
    }),
  );
}

/**
 * @typedef {object} DashboardDeps
 * @property {import("./tracker").RunTracker} tracker
 * @property {(run: { folder: vscode.WorkspaceFolder, settings: import("./defaults").Settings, environment: import("./discovery").Environment, playbookFile: string, options: import("./command").RunOptions }) => Promise<void>} startRun
 * @property {DashboardActions} actions
 */

/**
 * The extension's own commands, called with a node the dashboard builds from
 * discovery's objects -- the same functions the palette runs.
 *
 * @typedef {object} DashboardActions
 * @property {(node: object, action: "edit" | "create") => Promise<void>} vault
 * @property {(node: object) => Promise<void>} rekey
 * @property {(node: object) => Promise<void>} createService
 * @property {() => Promise<void>} rerunLast
 */

/** @param {string} fsPath */
function workspaceFolderAt(fsPath) {
  return (vscode.workspace.workspaceFolders || []).find((folder) => folder.uri.fsPath === fsPath);
}

/**
 * The preview as one line a person could paste: env assignments, then the
 * command and its arguments, each quoted the way the shell would need.
 *
 * @param {string} commandName
 * @param {string[]} argv
 * @param {Record<string, string>} env
 */
function commandLine(commandName, argv, env) {
  const assignments = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
  return [...assignments, commandName, ...argv.map(shellQuote)].join(" ");
}

class DashboardPanel {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {DashboardDeps} deps
   */
  static show(context, deps) {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "Playbook Runner",
      vscode.ViewColumn.Active,
      DashboardPanel.webviewOptions(context),
    );
    DashboardPanel.current = new DashboardPanel(panel, context, deps);
  }

  /**
   * @param {vscode.WebviewPanel} panel
   * @param {vscode.ExtensionContext} context
   * @param {DashboardDeps} deps
   */
  static revive(panel, context, deps) {
    panel.webview.options = DashboardPanel.webviewOptions(context);
    DashboardPanel.current = new DashboardPanel(panel, context, deps);
  }

  /** @param {vscode.ExtensionContext} context */
  static webviewOptions(context) {
    return {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    };
  }

  /** Re-send the model to an open dashboard, if there is one. */
  static refresh() {
    if (DashboardPanel.current) {
      DashboardPanel.current.update();
    }
  }

  /**
   * @param {vscode.WebviewPanel} panel
   * @param {vscode.ExtensionContext} context
   * @param {DashboardDeps} deps
   */
  constructor(panel, context, deps) {
    this.panel = panel;
    this.context = context;
    this.deps = deps;
    /** @type {model.DashboardModel} */
    this.model = { folders: [] };

    const media = vscode.Uri.joinPath(context.extensionUri, "media");
    // An editor tab draws its icon as an image, where currentColor is black;
    // so one file per theme, in VS Code's own icon greys.
    panel.iconPath = {
      light: vscode.Uri.joinPath(media, "runner-light.svg"),
      dark: vscode.Uri.joinPath(media, "runner-dark.svg"),
    };
    panel.webview.html = this.html(panel.webview, media);

    this.disposables = [
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((message) => this.receive(message)),
    ];
  }

  buildModel() {
    const folders = vscode.workspace.workspaceFolders || [];
    this.model = model.buildDashboardModel(
      folders.map((folder) => ({ name: folder.name, path: folder.uri.fsPath })),
      (folder) => readSettings(workspaceFolderAt(folder.path)),
      this.deps.tracker.history,
    );
    /** @type {Record<string, string[]>} */
    const setupTags = {};
    for (const folder of folders) {
      setupTags[folder.uri.fsPath] = readSettings(folder).setupTags;
    }
    return { model: this.model, setupTags };
  }

  update() {
    const { model: data, setupTags } = this.buildModel();
    void this.panel.webview.postMessage({
      type: "model",
      model: data,
      setupTags,
      settings: settingViews(this.context),
      now: Date.now(),
    });
  }

  /**
   * Save or reset one setting. The value is validated here, whatever the page
   * checked, and a machine setting goes to User settings whatever the page
   * asked for. The dashboard refreshes through onDidChangeConfiguration.
   *
   * @param {string} key
   * @param {unknown} value  undefined resets
   * @param {"workspace" | "user"} requested
   */
  async writeSetting(key, value, requested) {
    /** @type {string | null} */
    let error = null;
    try {
      let toSave = value;
      if (value !== undefined) {
        const checked = settingsEdit.validateSettingValue(key, value);
        if (!checked.ok) {
          throw new Error(checked.error);
        }
        toSave = checked.value;
      } else if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
        throw new Error(`"${key}" is not a Playbook Runner setting`);
      }
      const target =
        settingsEdit.settingTarget(key, requested) === "user"
          ? vscode.ConfigurationTarget.Global
          : vscode.ConfigurationTarget.Workspace;
      await vscode.workspace.getConfiguration(SECTION).update(key, toSave, target);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    void this.panel.webview.postMessage({ type: "settingResult", key, error });
  }

  /** @param {unknown} value */
  async receive(value) {
    const message = model.parseWebviewMessage(value);
    if (!message) {
      return;
    }
    if (message.type === "ready") {
      this.update();
      return;
    }

    if (message.type === "outline") {
      const folder = model.findOfferedPlaybook(this.model, message.folder, message.playbook);
      const workspaceFolder = folder && workspaceFolderAt(folder.path);
      if (!workspaceFolder) {
        return;
      }
      const settings = readSettings(workspaceFolder);
      void this.panel.webview.postMessage({
        type: "outline",
        folder: folder.path,
        playbook: message.playbook,
        outline: findPlaybookOutline(folder.path, message.playbook, settings),
        tags: findPlaybookTags(folder.path, message.playbook, settings),
      });
      return;
    }

    if (message.type === "rerunLast") {
      await this.deps.actions.rerunLast();
      return;
    }
    if (message.type === "setSetting") {
      await this.writeSetting(message.key, message.value, message.target);
      return;
    }
    if (message.type === "resetSetting") {
      await this.writeSetting(message.key, undefined, message.target);
      return;
    }
    if (message.type === "moveSetting") {
      const config = vscode.workspace.getConfiguration(SECTION);
      const inspected = Object.prototype.hasOwnProperty.call(DEFAULTS, message.key)
        ? config.inspect(message.key)
        : undefined;
      const error = await settingsEdit.moveSettingToUser(
        message.key,
        inspected ? inspected.workspaceValue : undefined,
        (value, target) =>
          Promise.resolve(
            config.update(
              message.key,
              value,
              target === "user" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace,
            ),
          ),
      );
      void this.panel.webview.postMessage({ type: "settingResult", key: message.key, error });
      return;
    }
    if (message.type === "openSettings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "playbookRunner");
      return;
    }
    if (message.type === "createService") {
      const folder = model.resolveFolderRequest(this.model, message.folder);
      const workspaceFolder = folder && workspaceFolderAt(folder.path);
      if (workspaceFolder) {
        await this.deps.actions.createService({ folder: workspaceFolder });
      }
      return;
    }
    if (message.type === "rekey") {
      const found = model.resolveEnvironmentRequest(this.model, message.folder, message.environment);
      const target = found && this.discovered(found.folder.path, found.environment.name);
      if (target) {
        await this.deps.actions.rekey(target);
      }
      return;
    }
    if (message.type === "vault") {
      const found = model.resolveVaultRequest(this.model, message);
      const target = found && this.discovered(found.folder.path, found.environment.name);
      if (found && target && found.service.vaultFile) {
        // The vault file comes from the model, never from the message.
        await this.deps.actions.vault(
          { ...target, vaultFile: found.service.vaultFile, hasVault: found.service.hasVault },
          message.action,
        );
      }
      return;
    }

    if (message.type === "open") {
      const target = model.resolveOpenRequest(this.model, message, (folderPath, playbookFile) =>
        findPlaybookOutline(folderPath, playbookFile, readSettings(workspaceFolderAt(folderPath))),
      );
      if (!target) {
        return;
      }
      const position = new vscode.Position(target.line - 1, 0);
      await vscode.window.showTextDocument(vscode.Uri.file(target.file), {
        viewColumn: vscode.ViewColumn.Beside,
        selection: new vscode.Range(position, position),
        preview: true,
      });
      return;
    }

    const resolved = model.resolveRunRequest(this.model, message);
    const workspaceFolder = resolved && workspaceFolderAt(resolved.folder.path);
    if (!resolved || !workspaceFolder || (message.type !== "preview" && message.type !== "run")) {
      return;
    }
    const settings = readSettings(workspaceFolder);
    const root = workspaceFolder.uri.fsPath;

    if (message.type === "preview") {
      const outline = findPlaybookOutline(root, resolved.playbook.file, settings);
      const preview = model.buildPreview({
        root,
        environment: resolved.environment,
        playbookFile: resolved.playbook.file,
        settings,
        options: message.options,
        outline,
        pluginDir: path.join(this.context.extensionPath, "ansible", "strategy"),
      });
      void this.panel.webview.postMessage({
        type: "preview",
        playbook: resolved.playbook.file,
        environment: resolved.environment.name,
        commandLine: commandLine(settings.ansiblePlaybookCommand, preview.argv, preview.env),
        error: preview.error,
      });
      return;
    }

    // A run: re-find the environment through discovery, so what reaches the
    // runner is discovery's object and not one rebuilt from the message.
    const environment = findEnvironments(root, settings).find(
      (item) => item.name === resolved.environment.name,
    );
    if (!environment) {
      return;
    }
    await this.deps.startRun({
      folder: workspaceFolder,
      settings,
      environment,
      playbookFile: resolved.playbook.file,
      options: message.options,
    });
  }

  /**
   * The workspace folder and discovery's environment object for names the
   * model offered -- what a command node is built from.
   *
   * @param {string} folderPath
   * @param {string} environmentName
   * @returns {{ folder: vscode.WorkspaceFolder, environment: import("./discovery").Environment } | null}
   */
  discovered(folderPath, environmentName) {
    const folder = workspaceFolderAt(folderPath);
    const environment =
      folder && findEnvironments(folderPath, readSettings(folder)).find((item) => item.name === environmentName);
    return folder && environment ? { folder, environment } : null;
  }

  /**
   * @param {vscode.Webview} webview
   * @param {vscode.Uri} media
   */
  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString("base64");
    const uri = (/** @type {string[]} */ ...parts) =>
      webview.asWebviewUri(vscode.Uri.joinPath(media, ...parts)).toString();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" nonce="${nonce}" href="${uri("codicons", "codicon.css")}">
  <link rel="stylesheet" nonce="${nonce}" href="${uri("dashboard", "style.css")}">
  <title>Playbook Runner</title>
</head>
<body>
  <div id="app" class="app"><p class="loading">Loading…</p></div>
  <script nonce="${nonce}" src="${uri("dashboard", "main.js")}"></script>
</body>
</html>`;
  }

  dispose() {
    if (DashboardPanel.current === this) {
      DashboardPanel.current = null;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.panel.dispose();
  }
}

/** @type {DashboardPanel | null} */
DashboardPanel.current = null;

module.exports = { DashboardPanel, VIEW_TYPE };
