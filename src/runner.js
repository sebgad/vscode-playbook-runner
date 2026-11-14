/**
 * Executing the ansible commands.
 *
 * Two execution paths on purpose:
 *
 *   playbooks -> vscode.Task, which brings Terminate Task, Re-run Last Task
 *                and the task terminal, and still has a real tty so
 *                --ask-vault-password and become prompts work.
 *   vaults    -> a terminal of their own, because `ansible-vault edit` spawns
 *                $EDITOR (nano, per ansible.cfg) and that wants a terminal it
 *                owns.
 *
 * The vault terminal runs `$shell -c <command>` as its process rather than
 * being an interactive shell we type into. That way the terminal ends when the
 * command does -- so a second vault action opens a new one instead of sending
 * text into the `nano` the first one still has open -- while a configured
 * command that is a wrapper ("uv run ansible-vault") keeps working and PATH is
 * resolved the way the user's shell resolves it. POSIX `-c` is assumed; ansible
 * is not a Windows tool.
 *
 * Both run with the workspace folder as cwd: ansible.cfg is only picked up
 * from the working directory, and its roles_path is relative.
 *
 * The argument vectors themselves are built in ./command.js.
 */

"use strict";

const path = require("path");
const vscode = require("vscode");

const command = require("./command");
const { playbookArgv } = require("./model");
const { resolveVaultPasswordFile } = require("./paths");

const VAULT_TERMINAL = "Ansible Vault";

/** Terminals opened for vault commands, so finished ones can be cleaned up. */
/** @type {Set<vscode.Terminal>} */
const vaultTerminals = new Set();

/**
 * Arguments are handed to the shell strongly quoted -- a playbook called
 * `it's a test.yml` is a filename, never syntax. The command itself is left
 * alone so that a wrapper still works, which is why it is a `machine` scope
 * setting a workspace cannot set.
 *
 * @param {string[]} args
 * @returns {vscode.ShellQuotedString[]}
 */
function quoteArgs(args) {
  return args.map((value) => ({ value, quoting: vscode.ShellQuoting.Strong }));
}

/**
 * @param {vscode.WorkspaceFolder} folder
 * @param {import("./defaults").Settings} settings
 * `env` is added to the task's environment -- the task-range variables from
 * command.buildPlaybookEnv, never anything put into the command string --
 * and `runId` goes into the task definition so the run's end can be matched
 * back to its history entry.
 *
 * @param {{ environment: import("./discovery").Environment, playbookFile: string, options?: command.RunOptions, env?: Record<string, string>, runId: string }} request
 * @returns {Thenable<vscode.TaskExecution>}
 */
function runPlaybook(folder, settings, request) {
  const root = folder.uri.fsPath;
  const playbook = path.relative(root, request.playbookFile);
  // The same argv the dashboard previews -- see model.playbookArgv.
  const args = playbookArgv(root, settings, request.environment, request.playbookFile, request.options || {});

  const execution = new vscode.ShellExecution(
    settings.ansiblePlaybookCommand,
    quoteArgs(args),
    request.env && Object.keys(request.env).length ? { cwd: root, env: request.env } : { cwd: root },
  );

  const label = command.playbookLabel(root, settings, request.playbookFile);
  const task = new vscode.Task(
    { type: "playbook-runner", environment: request.environment.name, playbook, runId: request.runId },
    folder,
    `${request.environment.name}: ${label}`,
    "Playbook Runner",
    execution,
  );

  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.New,
    clear: true,
    echo: true,
    focus: false,
  };

  return vscode.tasks.executeTask(task);
}

/** The shell used to run a vault command, in the order VS Code itself picks. */
function shellPath() {
  return vscode.env.shell || process.env.SHELL || "/bin/sh";
}

/**
 * Close the terminals of vault commands that have finished. A terminal whose
 * process is still running is left alone: that is someone in `nano`.
 */
function pruneFinished() {
  for (const terminal of [...vaultTerminals]) {
    if (terminal.exitStatus) {
      vaultTerminals.delete(terminal);
      terminal.dispose();
    }
  }
}

/**
 * Open a terminal running `argv`, and clean up after the previous ones.
 *
 * The terminal takes focus, because the first thing the command does is ask
 * for the vault password.
 *
 * @param {vscode.WorkspaceFolder} folder
 * @param {string[]} argv
 * @param {string} name
 * @returns {vscode.Terminal}
 */
function runInTerminal(folder, argv, name = VAULT_TERMINAL) {
  pruneFinished();

  const terminal = vscode.window.createTerminal({
    name,
    cwd: folder.uri.fsPath,
    shellPath: shellPath(),
    shellArgs: ["-c", argv.map(command.shellQuote).join(" ")],
    iconPath: new vscode.ThemeIcon("lock"),
  });
  vaultTerminals.add(terminal);
  terminal.show();
  return terminal;
}

/**
 * @param {vscode.WorkspaceFolder} folder
 * @param {import("./defaults").Settings} settings
 * @param {{ environment: import("./discovery").Environment, vaultFile: string, action: "edit" | "create" }} request
 * @returns {vscode.Terminal}
 */
function runVaultCommand(folder, settings, request) {
  const root = folder.uri.fsPath;
  const vaultFile = path.relative(root, request.vaultFile);
  const argv = command.buildVaultArgv({
    vaultCommand: settings.ansibleVaultCommand,
    action: request.action,
    vaultFile,
    vaultPasswordFile: resolveVaultPasswordFile(settings, request.environment.name, root),
  });
  return runInTerminal(folder, argv, `${VAULT_TERMINAL}: ${request.environment.name}`);
}

/**
 * Rotate the passphrase of several vaults at once.
 *
 * Same terminal path as edit and create, and for the same reason: ansible-vault
 * asks for the current passphrase and then twice for the new one, so it needs a
 * tty of its own. Paths are made relative to the workspace folder because that
 * is the cwd the terminal runs in.
 *
 * @param {vscode.WorkspaceFolder} folder
 * @param {import("./defaults").Settings} settings
 * @param {{ environment: import("./discovery").Environment, vaultFiles: string[] }} request
 * @returns {vscode.Terminal}
 */
function runVaultRekey(folder, settings, request) {
  const root = folder.uri.fsPath;
  const argv = command.buildVaultRekeyArgv({
    vaultCommand: settings.ansibleVaultCommand,
    vaultFiles: request.vaultFiles.map((file) => path.relative(root, file)),
    vaultPasswordFile: resolveVaultPasswordFile(settings, request.environment.name, root),
  });
  return runInTerminal(folder, argv, `${VAULT_TERMINAL}: rekey ${request.environment.name}`);
}

/**
 * Let go of the vault terminals on shutdown. The finished ones are closed; a
 * command still running keeps its terminal, which VS Code takes down with the
 * window anyway -- deactivation is no reason to end an edit in progress.
 */
function dispose() {
  pruneFinished();
  vaultTerminals.clear();
}

module.exports = {
  VAULT_TERMINAL,
  buildPlaybookArgs: command.buildPlaybookArgs,
  dispose,
  playbookLabel: command.playbookLabel,
  quoteArgs,
  runInTerminal,
  runPlaybook,
  runVaultCommand,
  runVaultRekey,
  shellQuote: command.shellQuote,
};
