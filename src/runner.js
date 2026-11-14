/**
 * Executing the ansible commands.
 *
 * Two kinds of terminal, on purpose:
 *
 *   playbooks -> a "Playbook Runner" terminal per workspace folder, an
 *                ordinary interactive shell that is reused run after run. The
 *                command goes in through shell integration, which reports its
 *                exit code for the run history; it is a real tty, so
 *                --ask-vault-password, become and SSH prompts work, and Ctrl+C
 *                stops a run. A runner terminal with a command still running
 *                is never typed into -- a second one opens instead.
 *   vaults    -> a terminal of their own running `$shell -c <command>`,
 *                because `ansible-vault edit` spawns $EDITOR (nano, per
 *                ansible.cfg) and wants a terminal it owns; it ends when the
 *                command does.
 *
 * Every terminal here is created with `hideFromUser` and shown right after.
 * The Python Environments extension types `source .venv/bin/activate.fish`
 * into each new terminal it sees for a folder with a venv -- into a password
 * prompt or nano, if that is what is running -- and the one kind of terminal
 * it leaves alone is one created hidden. Playbooks used to run as a
 * vscode.Task, whose terminal it only sometimes recognised in time.
 *
 * Both run with the workspace folder as cwd: ansible.cfg is only picked up
 * from the working directory, and its roles_path is relative.
 *
 * The argument vectors and the command line are built in ./command.js.
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

const RUNNER_TERMINAL = "Playbook Runner";

/** How long a new runner terminal gets to bring up shell integration. */
const SHELL_INTEGRATION_TIMEOUT_MS = 5000;

/**
 * The runner terminals: which folder each runs in, and how many commands are
 * running in it right now (ours, or one typed by hand).
 *
 * @type {Map<vscode.Terminal, { folder: string, busy: number, reusable: boolean }>}
 */
const runnerTerminals = new Map();

/** @type {vscode.Disposable[]} */
const listeners = [];

function listen() {
  if (listeners.length) {
    return;
  }
  listeners.push(
    vscode.window.onDidStartTerminalShellExecution((event) => {
      const info = runnerTerminals.get(event.terminal);
      if (info) {
        info.busy += 1;
      }
    }),
    vscode.window.onDidEndTerminalShellExecution((event) => {
      const info = runnerTerminals.get(event.terminal);
      if (info) {
        info.busy = Math.max(0, info.busy - 1);
      }
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      runnerTerminals.delete(terminal);
      vaultTerminals.delete(terminal);
    }),
  );
}

/**
 * An idle runner terminal for this folder, or a new one. A new one is created
 * hidden and then shown: see the header for why.
 *
 * @param {vscode.WorkspaceFolder} folder
 * @returns {vscode.Terminal}
 */
function runnerTerminalFor(folder) {
  listen();
  const root = folder.uri.fsPath;
  for (const [terminal, info] of runnerTerminals) {
    if (!terminal.exitStatus && info.folder === root && info.reusable && info.busy === 0) {
      return terminal;
    }
  }
  const open = [...runnerTerminals.values()].filter((info) => info.folder === root).length;
  const terminal = vscode.window.createTerminal({
    name: open ? `${RUNNER_TERMINAL} (${open + 1})` : RUNNER_TERMINAL,
    cwd: root,
    hideFromUser: true,
    iconPath: new vscode.ThemeIcon("run-all"),
  });
  runnerTerminals.set(terminal, { folder: root, busy: 0, reusable: true });
  return terminal;
}

/**
 * The terminal's shell integration, waiting a few seconds for a new one.
 *
 * @param {vscode.Terminal} terminal
 * @returns {Promise<vscode.TerminalShellIntegration | undefined>}
 */
function shellIntegrationOf(terminal) {
  if (terminal.shellIntegration) {
    return Promise.resolve(terminal.shellIntegration);
  }
  return new Promise((resolve) => {
    const subscription = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal) {
        clearTimeout(timer);
        subscription.dispose();
        resolve(event.shellIntegration);
      }
    });
    const timer = setTimeout(() => {
      subscription.dispose();
      resolve(terminal.shellIntegration);
    }, SHELL_INTEGRATION_TIMEOUT_MS);
  });
}

/**
 * Run one playbook in a runner terminal.
 *
 * `env` is added for this one command -- the task-range variables from
 * command.buildPlaybookEnv -- through `env` on the command line, never
 * exported into the shell.
 *
 * Resolves once the command has been handed to the shell. `finished` then
 * resolves with its exit code (undefined if the shell could not say), or is
 * null when the terminal has no shell integration and the result cannot be
 * tracked at all.
 *
 * @param {vscode.WorkspaceFolder} folder
 * @param {import("./defaults").Settings} settings
 * @param {{ environment: import("./discovery").Environment, playbookFile: string, options?: command.RunOptions, env?: Record<string, string> }} request
 * @returns {Promise<{ finished: Promise<number | undefined> | null }>}
 */
async function runPlaybook(folder, settings, request) {
  const root = folder.uri.fsPath;
  // The same argv the dashboard previews -- see model.playbookArgv.
  const argv = playbookArgv(root, settings, request.environment, request.playbookFile, request.options || {});
  const line = command.buildTerminalCommand({
    cwd: root,
    command: settings.ansiblePlaybookCommand,
    argv,
    env: request.env || {},
  });

  const terminal = runnerTerminalFor(folder);
  const info = runnerTerminals.get(terminal);
  if (info) {
    // Claimed before the wait, so a second run started meanwhile opens its
    // own terminal instead of typing into this one.
    info.busy += 1;
  }
  terminal.show(true);
  const integration = await shellIntegrationOf(terminal);
  if (info) {
    info.busy = Math.max(0, info.busy - 1);
  }

  if (!integration) {
    // No way to know when it ends, so no way to know when the terminal is
    // free again: it is not reused.
    if (info) {
      info.reusable = false;
    }
    terminal.sendText(line, true);
    return { finished: null };
  }

  const execution = integration.executeCommand(line);
  /** @type {Promise<number | undefined>} */
  const finished = new Promise((resolve) => {
    const subscription = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.execution === execution) {
        subscription.dispose();
        resolve(event.exitCode);
      }
    });
  });
  return { finished };
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

  listen();
  const terminal = vscode.window.createTerminal({
    name,
    cwd: folder.uri.fsPath,
    shellPath: shellPath(),
    shellArgs: ["-c", argv.map(command.shellQuote).join(" ")],
    iconPath: new vscode.ThemeIcon("lock"),
    // Hidden at creation so nothing types into ansible-vault's password
    // prompt or into nano -- see the header. Shown just below.
    hideFromUser: true,
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
  runnerTerminals.clear();
  for (const listener of listeners.splice(0)) {
    listener.dispose();
  }
}

module.exports = {
  RUNNER_TERMINAL,
  VAULT_TERMINAL,
  buildPlaybookArgs: command.buildPlaybookArgs,
  dispose,
  playbookLabel: command.playbookLabel,
  runInTerminal,
  runPlaybook,
  runVaultCommand,
  runVaultRekey,
  shellQuote: command.shellQuote,
};
