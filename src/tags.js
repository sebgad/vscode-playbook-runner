/**
 * The tags a playbook can be run with, read out of the YAML.
 *
 * `ansible-playbook --list-tags` is the authoritative answer, but it needs the
 * inventory, the vault passphrase and a second or two of ansible start-up
 * before a picker could open -- three reasons for a checkbox list not to
 * appear. So the files are read instead: the playbook, the playbooks it
 * imports, and the task files of the roles it pulls in. That is the whole
 * reachable set in this repository, where every role and every tag is written
 * out literally.
 *
 * It is a line scanner, not a YAML parser -- the extension has no runtime
 * dependencies and is not about to gain one for this. What that costs is a tag
 * built out of a variable (`tags: "{{ thing }}"`, deliberately skipped) and
 * anything laid out unusually enough that the shapes below miss it, which is
 * why the picker keeps a free-text way in. What it buys is a list that is there
 * the instant the item is ticked, with no passphrase and no ansible on PATH.
 *
 * Like discovery.js this imports `vscode` nowhere, so test/tags.test.js can
 * exercise it under plain node.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = require("./defaults");
const { isDirectory, isFile } = require("./discovery");

/** Extensions tried when a reference leaves one off, in order. */
const FILE_EXTENSIONS = ["", ".yml", ".yaml"];

/** A stop on runaway recursion; no real playbook comes near it. */
const MAX_FILES = 200;

/**
 * @typedef {object} PlaybookTag
 * @property {string} name
 * @property {string[]} sources  where it was found, empty when that is the playbook itself
 */

/**
 * Drop a trailing `# comment`, leaving one inside a quoted scalar alone.
 *
 * @param {string} text
 * @returns {string}
 */
function stripComment(text) {
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(text.charAt(i - 1)))) {
      return text.slice(0, i);
    }
  }
  return text;
}

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  const text = value.trim();
  if (text.length >= 2) {
    const first = text.charAt(0);
    const last = text.charAt(text.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/** @param {string} line */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * One line, split into the column its key starts at and what follows.
 *
 * `- role: storage/nfs` is a mapping whose key sits at column 2, not column 0 --
 * getting that right is what keeps the block boundaries below honest.
 *
 * @param {string} line
 * @returns {{ indent: number, isItem: boolean, key: string | null, value: string, body: string }}
 */
function readLine(line) {
  const content = stripComment(line).trimEnd();
  const dashes = /^(\s*(?:-\s+)*)(.*)$/.exec(content);
  const prefix = dashes?.[1] ?? "";
  const body = dashes?.[2] ?? "";
  const pair = /^([A-Za-z_][\w.]*)\s*:\s*(.*)$/.exec(body);
  return {
    indent: prefix.length,
    isItem: prefix.trimStart().startsWith("-"),
    key: pair?.[1] ?? null,
    value: (pair?.[2] ?? "").trim(),
    body,
  };
}

/**
 * The lines belonging to a key: everything indented deeper than it. A sequence
 * written at the key's own column counts too -- YAML allows that, and a `tags:`
 * with its items flush against it is not an unusual thing to write.
 *
 * @param {string[]} lines
 * @param {number} start  first line after the key
 * @param {number} keyIndent
 * @returns {string[]}
 */
function blockAfter(lines, start, keyIndent) {
  /** @type {string[]} */
  const block = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      continue;
    }
    const indent = indentOf(line);
    if (indent > keyIndent || (indent === keyIndent && line.trimStart().startsWith("-"))) {
      block.push(line);
      continue;
    }
    break;
  }
  return block;
}

/**
 * The scalars of a flow sequence, `[a, "b"]`, gathered across lines until the
 * bracket closes.
 *
 * @param {string} first
 * @param {string[]} lines
 * @param {number} start
 * @returns {string[]}
 */
function flowSequence(first, lines, start) {
  let text = first;
  for (let i = start; i < lines.length && !text.includes("]"); i += 1) {
    text += ` ${stripComment(lines[i] ?? "").trim()}`;
  }
  const inner = text.slice(text.indexOf("[") + 1, text.includes("]") ? text.indexOf("]") : undefined);
  return inner.split(",");
}

/**
 * A tag name worth offering: something literal. A templated one cannot be
 * resolved without running ansible, so it is left out rather than shown as the
 * expression it is written as.
 *
 * @param {string} value
 * @returns {string | null}
 */
function tagName(value) {
  const name = unquote(value);
  if (!name || name.includes("{{") || name.includes("{%")) {
    return null;
  }
  return name;
}

/**
 * The tags of one `tags:` line, whichever of the three shapes it is written in:
 * a flow sequence, a comma-separated scalar, or a block sequence underneath.
 *
 * @param {{ value: string, indent: number }} entry
 * @param {string[]} lines
 * @param {number} index  the line the key is on
 * @returns {string[]}
 */
function tagsAt(entry, lines, index) {
  /** @type {string[]} */
  let candidates;
  if (entry.value.startsWith("[")) {
    candidates = flowSequence(entry.value, lines, index + 1);
  } else if (entry.value) {
    candidates = entry.value.split(",");
  } else {
    candidates = blockAfter(lines, index + 1, entry.indent)
      .filter((line) => line.trimStart().startsWith("-"))
      .map((line) => stripComment(line).trim().replace(/^-\s*/, ""));
  }

  /** @type {string[]} */
  const tags = [];
  for (const candidate of candidates) {
    const name = tagName(candidate);
    if (name) {
      tags.push(name);
    }
  }
  return tags;
}

/**
 * The `name:` of an import_role/include_role, which is only ever looked for
 * inside that module's own block -- a bare `name:` is the label of every task
 * in the file.
 *
 * @param {string[]} block
 * @param {string} key
 * @returns {string | null}
 */
function fieldIn(block, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`);
  for (const line of block) {
    const match = pattern.exec(stripComment(line));
    if (match) {
      const value = unquote(match[1] ?? "");
      return value.includes("{{") ? null : value || null;
    }
  }
  return null;
}

/**
 * An inline `{ name: x }` or a bare scalar, for the modules that accept either.
 *
 * @param {string} value
 * @param {string} key
 * @returns {string | null}
 */
function inlineField(value, key) {
  if (!value) {
    return null;
  }
  if (value.startsWith("{")) {
    const match = new RegExp(`${key}\\s*:\\s*([^,}]+)`).exec(value);
    const found = match ? unquote(match[1] ?? "") : "";
    return found && !found.includes("{{") ? found : null;
  }
  const scalar = unquote(value);
  return scalar && !scalar.includes("{{") ? scalar : null;
}

/**
 * The first of `candidates` that is a file, with .yml and .yaml tried for a
 * reference that left the extension off.
 *
 * @param {string[]} candidates
 * @returns {string | null}
 */
function resolveFile(candidates) {
  for (const candidate of candidates) {
    for (const extension of FILE_EXTENSIONS) {
      const file = `${candidate}${extension}`;
      if (isFile(file)) {
        return file;
      }
    }
  }
  return null;
}

/**
 * @typedef {object} ScanState
 * @property {string} root
 * @property {import("./defaults").Settings} settings
 * @property {Map<string, Set<string>>} tags  name -> source labels, in the order first seen
 * @property {Set<string>} visited            real paths of files already read
 */

/**
 * Where a role lives: beside the playbook first, the way ansible looks, then
 * the configured roles directory -- ansible.cfg's roles_path, which is relative
 * to the workspace folder because that is the cwd every run uses.
 *
 * @param {ScanState} state
 * @param {string} name
 * @param {string} playbookDir
 * @returns {string | null}
 */
function resolveRole(state, name, playbookDir) {
  const candidates = [
    path.join(playbookDir, state.settings.rolesDir, name),
    path.join(state.root, state.settings.rolesDir, name),
  ];
  return candidates.find((dir) => isDirectory(dir)) ?? null;
}

/**
 * @param {string} file
 * @returns {string[] | null}
 */
function readLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    return null;
  }
}

/**
 * How an imported file is named beside a tag: the same shape the tree and the
 * task labels use, `podman_servers/acme.yml` rather than the whole path.
 *
 * @param {ScanState} state
 * @param {string} file
 * @returns {string}
 */
function labelFor(state, file) {
  const fromPlaybooks = path.relative(
    path.join(state.root, state.settings.playbooksDir),
    file,
  );
  return fromPlaybooks.startsWith("..") ? path.relative(state.root, file) : fromPlaybooks;
}

/**
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
 * Read one file, recording its tags and following what it pulls in.
 *
 * `label` is what the picker shows beside a tag, and is null for the playbook
 * that was asked about -- a tag written in the playbook itself needs no
 * explanation of where it came from.
 *
 * @param {ScanState} state
 * @param {string} file
 * @param {string | null} label
 * @param {{ playbookDir: string, roleDir: string | null }} context
 */
function scanFile(state, file, label, context) {
  const real = realPathOrNull(file);
  if (real === null || state.visited.has(real) || state.visited.size >= MAX_FILES) {
    return;
  }
  state.visited.add(real);

  const lines = readLines(file);
  if (!lines) {
    return;
  }

  /** @param {string} name */
  const record = (name) => {
    let sources = state.tags.get(name);
    if (!sources) {
      sources = new Set();
      state.tags.set(name, sources);
    }
    if (label) {
      sources.add(label);
    }
  };

  // What this file pulls in is walked only once the file itself has been read,
  // so a play's own tags come before the ones inside the roles it imports. The
  // reference sits above the `tags:` of the very task that carries it, so
  // descending where it is found would put the role's innards first and bury
  // `deploy-app` underneath them.
  /** @type {(() => void)[]} */
  const pending = [];

  /**
   * @param {string} file
   * @param {string | null} childLabel
   * @param {{ playbookDir: string, roleDir: string | null }} childContext
   */
  const follow = (file, childLabel, childContext) => {
    pending.push(() => scanFile(state, file, childLabel, childContext));
  };

  /** @param {string} name */
  const followRole = (name) => {
    const roleDir = resolveRole(state, name, context.playbookDir);
    if (!roleDir) {
      return;
    }
    const tasks = resolveFile([path.join(roleDir, "tasks", "main")]);
    if (tasks) {
      follow(tasks, name, { playbookDir: context.playbookDir, roleDir });
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const entry = readLine(lines[i] ?? "");
    if (!entry.key) {
      continue;
    }
    const key = entry.key.includes(".")
      ? entry.key.slice(entry.key.lastIndexOf(".") + 1)
      : entry.key;

    switch (key) {
      case "tags":
        for (const name of tagsAt(entry, lines, i)) {
          record(name);
        }
        break;

      case "role":
        // Only as a sequence item: `- role: storage/nfs`, never a variable
        // that happens to be called role.
        if (entry.isItem) {
          const name = inlineField(entry.value, "role") || unquote(entry.value);
          if (name && !name.includes("{{")) {
            followRole(name);
          }
        }
        break;

      case "roles": {
        // `- role:` entries are handled above; this is the bare-scalar form.
        const block = entry.value.startsWith("[")
          ? flowSequence(entry.value, lines, i + 1)
          : blockAfter(lines, i + 1, entry.indent)
              .map((line) => stripComment(line).trim())
              .filter((line) => line.startsWith("-"))
              .map((line) => line.replace(/^-\s*/, ""));
        for (const item of block) {
          const name = unquote(item);
          if (name && !name.includes(":") && !name.includes("{") && !name.includes("}")) {
            followRole(name);
          }
        }
        break;
      }

      case "import_role":
      case "include_role": {
        const block = blockAfter(lines, i + 1, entry.indent);
        const name = inlineField(entry.value, "name") || fieldIn(block, "name");
        if (!name) {
          break;
        }
        const roleDir = resolveRole(state, name, context.playbookDir);
        if (!roleDir) {
          break;
        }
        const from = fieldIn(block, "tasks_from") || "main";
        const tasks = resolveFile([path.join(roleDir, "tasks", from)]);
        if (tasks) {
          follow(tasks, name, { playbookDir: context.playbookDir, roleDir });
        }
        break;
      }

      case "import_tasks":
      case "include_tasks": {
        const block = blockAfter(lines, i + 1, entry.indent);
        const target = inlineField(entry.value, "file") || fieldIn(block, "file");
        if (!target) {
          break;
        }
        const bases = context.roleDir
          ? [path.join(context.roleDir, "tasks"), context.roleDir, context.playbookDir]
          : [context.playbookDir, state.root];
        const tasks = resolveFile(bases.map((base) => path.resolve(base, target)));
        if (tasks) {
          follow(tasks, label ?? labelFor(state, tasks), context);
        }
        break;
      }

      case "import_playbook": {
        const target = inlineField(entry.value, "file");
        if (!target) {
          break;
        }
        const playbook = resolveFile([
          path.resolve(context.playbookDir, target),
          path.resolve(state.root, target),
        ]);
        if (playbook) {
          follow(playbook, labelFor(state, playbook), {
            playbookDir: path.dirname(playbook),
            roleDir: null,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  for (const walk of pending) {
    walk();
  }
}

/**
 * Every tag a playbook could be run with, in the order the files mention them
 * -- which is play order, so the list reads like the run does rather than like
 * an alphabet.
 *
 * @param {string} root workspace folder path
 * @param {string} playbookFile absolute path
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @returns {PlaybookTag[]}
 */
function findPlaybookTags(root, playbookFile, settings) {
  /** @type {ScanState} */
  const state = {
    root,
    settings: { ...DEFAULTS, ...(settings || {}) },
    tags: new Map(),
    visited: new Set(),
  };

  scanFile(state, playbookFile, null, {
    playbookDir: path.dirname(playbookFile),
    roleDir: null,
  });

  return [...state.tags].map(([name, sources]) => ({ name, sources: [...sources] }));
}

/**
 * A `--tags` string as a list. Also the guard on what comes back from workspace
 * state: the remembered tags of the last run reach a command line.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function parseTagList(value) {
  if (typeof value !== "string") {
    return [];
  }
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

/**
 * @param {string[]} tags
 * @returns {string}
 */
function formatTagList(tags) {
  return parseTagList(tags.join(",")).join(",");
}

/**
 * @typedef {object} TagChoice
 * @property {string} name
 * @property {string[]} sources
 * @property {boolean} picked
 * @property {boolean} known   false for a tag carried over that the scan did not find
 */

/**
 * The checkbox list: what was found, in discovery order, followed by anything
 * that was selected last time but is not in the playbook any more. Dropping
 * those silently would quietly change what the next run does, so they stay,
 * ticked and marked.
 *
 * @param {PlaybookTag[]} available
 * @param {string[]} selected
 * @returns {TagChoice[]}
 */
function buildTagChoices(available, selected) {
  const chosen = new Set(selected);
  const known = new Set(available.map((tag) => tag.name));
  return [
    ...available.map((tag) => ({
      name: tag.name,
      sources: tag.sources,
      picked: chosen.has(tag.name),
      known: true,
    })),
    ...selected
      .filter((name) => !known.has(name))
      .map((name) => ({ name, sources: [], picked: true, known: false })),
  ];
}

module.exports = {
  MAX_FILES,
  buildTagChoices,
  findPlaybookTags,
  formatTagList,
  parseTagList,
};
