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
 * @param {{ root: string, settings: import("./defaults").Settings }} state
 * @param {string} name
 * @param {string} playbookDir
 * @returns {string | null}
 */
function resolveRole(state, name, playbookDir) {
  const candidates = [
    path.join(playbookDir, state.settings.rolesDir, name),
    path.join(state.root, state.settings.rolesDir, name),
    // A role named by its path, `../../roles/unattended-upgrades`, which
    // ansible accepts relative to the playbook.
    path.resolve(playbookDir, name),
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
 * @param {{ root: string, settings: import("./defaults").Settings }} state
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
 * @typedef {object} OutlineTask
 * @property {string} name      ansible's get_name(): "podman/deploy-app : Render manifest" inside a role
 * @property {string} bareName  the `name:` as written
 * @property {string | null} role  the role as referenced, e.g. "podman/deploy-app"
 * @property {string[]} tags    its own tags plus the play's, the role reference's and the block's
 * @property {string} file
 * @property {number} line      1-based, the task's first line
 */

/**
 * @typedef {object} OutlinePlay
 * @property {string} name
 * @property {string} hosts
 * @property {OutlineTask[]} tasks
 */

/**
 * @typedef {object} PlaybookOutline
 * @property {OutlinePlay[]} plays
 * @property {string | null} strategy  the first play-level `strategy:`, which would bypass a range run
 * @property {number} skipped          tasks left out because they have no name
 */

/**
 * @typedef {object} OutlineState
 * @property {string} root
 * @property {import("./defaults").Settings} settings
 * @property {OutlinePlay[]} plays
 * @property {string | null} strategy
 * @property {number} skipped
 * @property {number} reads   files opened so far, against MAX_FILES
 * @property {Set<string>} stack  real paths of the files being walked right now
 */

/**
 * @typedef {object} TaskContext
 * @property {string} file
 * @property {string} playbookDir
 * @property {string | null} role
 * @property {string | null} roleDir
 * @property {string[]} tags  inherited from above
 */

/** @param {string} line */
function isBlank(line) {
  return !stripComment(line).trim();
}

/**
 * The items of the block sequence that starts at the first non-blank line of
 * `[start, end)`, as line ranges. Nothing when that line is not an item.
 *
 * @param {string[]} lines
 * @param {number} start
 * @param {number} end  exclusive
 * @returns {{ start: number, end: number }[]}
 */
function sequenceItems(lines, start, end) {
  /** @type {{ start: number, end: number }[]} */
  const items = [];
  let dashColumn = -1;
  for (let i = start; i < end; i += 1) {
    const line = lines[i] ?? "";
    if (isBlank(line)) {
      continue;
    }
    const indent = indentOf(line);
    const isDash = /^-(\s|$)/.test(line.trimStart());
    if (dashColumn < 0) {
      if (!isDash) {
        if (line.trim() === "---") {
          continue;
        }
        return items;
      }
      dashColumn = indent;
    }
    if (indent < dashColumn || (indent === dashColumn && !isDash)) {
      break;
    }
    if (indent === dashColumn) {
      const last = items[items.length - 1];
      if (last) {
        last.end = i;
      }
      items.push({ start: i, end });
    }
  }
  const last = items[items.length - 1];
  if (last && last.end > end) {
    last.end = end;
  }
  return items;
}

/**
 * @typedef {object} Field
 * @property {number} line   the key's line
 * @property {number} end    exclusive end of its block
 * @property {number} indent
 * @property {string} value
 */

/**
 * The top-level keys of one sequence item, a collection prefix dropped
 * (`ansible.builtin.import_role` is `import_role`). A scalar item has none and
 * comes back with its text as `scalar`.
 *
 * @param {string[]} lines
 * @param {{ start: number, end: number }} item
 * @returns {{ fields: Map<string, Field>, scalar: string | null }}
 */
function fieldsOf(lines, item) {
  /** @type {Map<string, Field>} */
  const fields = new Map();
  const first = readLine(lines[item.start] ?? "");
  if (!first.key) {
    return { fields, scalar: first.body.trim() || null };
  }
  const keyIndent = first.indent;
  /** @type {Field | null} */
  let current = null;
  /** @param {string} key @param {Field} field */
  const add = (key, field) => {
    const short = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1) : key;
    if (!fields.has(short)) {
      fields.set(short, field);
    }
  };
  current = { line: item.start, end: item.end, indent: keyIndent, value: first.value };
  add(first.key, current);
  for (let i = item.start + 1; i < item.end; i += 1) {
    const line = lines[i] ?? "";
    if (isBlank(line) || indentOf(line) !== keyIndent) {
      continue;
    }
    const entry = readLine(line);
    if (!entry.key || entry.isItem) {
      continue;
    }
    current.end = i;
    current = { line: i, end: item.end, indent: keyIndent, value: entry.value };
    add(entry.key, current);
  }
  return { fields, scalar: null };
}

/**
 * @param {string[]} lines
 * @param {Field | undefined} field
 * @returns {string[]}
 */
function fieldTags(lines, field) {
  return field ? tagsAt(field, lines, field.line) : [];
}

/**
 * @param {string[]} inherited
 * @param {string[]} own
 * @returns {string[]}
 */
function mergeTags(inherited, own) {
  return [...new Set([...inherited, ...own])];
}

/**
 * Read a file for the outline, or null when it is unreadable, already being
 * walked (an import cycle) or past the file budget.
 *
 * @param {OutlineState} state
 * @param {string} file
 * @param {(lines: string[]) => void} walk
 */
function withFile(state, file, walk) {
  const real = realPathOrNull(file);
  if (real === null || state.stack.has(real) || state.reads >= MAX_FILES) {
    return;
  }
  const lines = readLines(file);
  if (!lines) {
    return;
  }
  state.reads += 1;
  state.stack.add(real);
  try {
    walk(lines);
  } finally {
    state.stack.delete(real);
  }
}

/**
 * The tasks of a role's task file, appended to `out`.
 *
 * @param {OutlineState} state
 * @param {OutlineTask[]} out
 * @param {string} name
 * @param {string} from  tasks file without extension, "main" by default
 * @param {TaskContext} context
 * @param {string[]} tags
 */
function outlineRole(state, out, name, from, context, tags) {
  const roleDir = resolveRole(state, name, context.playbookDir);
  const file = roleDir ? resolveFile([path.join(roleDir, "tasks", from)]) : null;
  if (!roleDir || !file) {
    return;
  }
  withFile(state, file, (lines) =>
    outlineTasks(state, out, lines, 0, lines.length, {
      file,
      playbookDir: context.playbookDir,
      role: name,
      roleDir,
      tags,
    }),
  );
}

/**
 * Walk a task list in run order: a role or a task file is descended into where
 * it is referenced, which is where its tasks run.
 *
 * @param {OutlineState} state
 * @param {OutlineTask[]} out
 * @param {string[]} lines
 * @param {number} start
 * @param {number} end
 * @param {TaskContext} context
 */
function outlineTasks(state, out, lines, start, end, context) {
  for (const item of sequenceItems(lines, start, end)) {
    const { fields } = fieldsOf(lines, item);
    const tags = mergeTags(context.tags, fieldTags(lines, fields.get("tags")));
    const nameField = fields.get("name");
    const bareName = nameField ? unquote(nameField.value) : "";

    // Only the block's own tasks: `rescue:` and `always:` run on failure or as
    // cleanup, which makes them poor places to start or stop a run, and
    // `--list-tasks` leaves them out as well.
    const block = fields.get("block");
    if (block) {
      outlineTasks(state, out, lines, block.line + 1, block.end, { ...context, tags });
      continue;
    }

    const roleField = fields.get("import_role") || fields.get("include_role");
    if (roleField) {
      const block = lines.slice(roleField.line + 1, roleField.end);
      const role = inlineField(roleField.value, "name") || fieldIn(block, "name");
      if (fields.has("include_role")) {
        pushTask(state, out, bareName, item, context, tags);
      }
      if (role) {
        outlineRole(state, out, role, fieldIn(block, "tasks_from") || "main", context, tags);
      }
      continue;
    }

    const tasksField = fields.get("import_tasks") || fields.get("include_tasks");
    if (tasksField) {
      if (fields.has("include_tasks")) {
        pushTask(state, out, bareName, item, context, tags);
      }
      const block = lines.slice(tasksField.line + 1, tasksField.end);
      const target = inlineField(tasksField.value, "file") || fieldIn(block, "file");
      if (target) {
        const bases = context.roleDir
          ? [path.join(context.roleDir, "tasks"), context.roleDir, context.playbookDir]
          : [context.playbookDir, state.root];
        const file = resolveFile(bases.map((base) => path.resolve(base, target)));
        if (file) {
          withFile(state, file, (included) =>
            outlineTasks(state, out, included, 0, included.length, { ...context, file, tags }),
          );
        }
      }
      continue;
    }

    pushTask(state, out, bareName, item, context, tags);
  }
}

/**
 * @param {OutlineState} state
 * @param {OutlineTask[]} out
 * @param {string} bareName
 * @param {{ start: number }} item
 * @param {TaskContext} context
 * @param {string[]} tags
 */
function pushTask(state, out, bareName, item, context, tags) {
  // A templated name stays, raw: ansible matches a task by its name as
  // written, before templating, both for --start-at-task and in the iterator
  // the range plugin reads.
  if (!bareName) {
    state.skipped += 1;
    return;
  }
  out.push({
    name: context.role ? `${context.role} : ${bareName}` : bareName,
    bareName,
    role: context.role,
    tags,
    file: context.file,
    line: item.start + 1,
  });
}

/**
 * The plays of one playbook file, `import_playbook` followed in place.
 *
 * @param {OutlineState} state
 * @param {string} file
 */
function outlinePlaybook(state, file) {
  withFile(state, file, (lines) => {
    const playbookDir = path.dirname(file);
    for (const item of sequenceItems(lines, 0, lines.length)) {
      const { fields } = fieldsOf(lines, item);

      const imported = fields.get("import_playbook");
      if (imported) {
        const target = inlineField(imported.value, "file");
        const playbook = target
          ? resolveFile([path.resolve(playbookDir, target), path.resolve(state.root, target)])
          : null;
        if (playbook) {
          outlinePlaybook(state, playbook);
        }
        continue;
      }

      const hosts = fields.get("hosts");
      if (!hosts) {
        continue;
      }
      const strategy = fields.get("strategy");
      if (strategy && state.strategy === null) {
        state.strategy = unquote(strategy.value) || "?";
      }

      const nameField = fields.get("name");
      const hostsText = unquote(hosts.value);
      /** @type {OutlinePlay} */
      const play = {
        name: (nameField && unquote(nameField.value)) || hostsText,
        hosts: hostsText,
        tasks: [],
      };
      const playTags = fieldTags(lines, fields.get("tags"));
      /** @type {TaskContext} */
      const context = { file, playbookDir, role: null, roleDir: null, tags: playTags };

      // The order ansible runs a play's sections in.
      for (const section of ["pre_tasks", "roles", "tasks", "post_tasks"]) {
        const field = fields.get(section);
        if (!field) {
          continue;
        }
        if (section !== "roles") {
          outlineTasks(state, play.tasks, lines, field.line + 1, field.end, context);
          continue;
        }
        const refs = field.value.startsWith("[")
          ? flowSequence(field.value, lines, field.line + 1).map((name) => ({
              name: unquote(name),
              tags: /** @type {string[]} */ ([]),
            }))
          : sequenceItems(lines, field.line + 1, field.end).map((ref) => {
              const parsed = fieldsOf(lines, ref);
              const roleField = parsed.fields.get("role") || parsed.fields.get("name");
              return {
                name: parsed.scalar !== null ? unquote(parsed.scalar) : roleField ? unquote(roleField.value) : "",
                tags: fieldTags(lines, parsed.fields.get("tags")),
              };
            });
        for (const ref of refs) {
          if (ref.name && !/[{}:]/.test(ref.name)) {
            outlineRole(state, play.tasks, ref.name, "main", context, mergeTags(playTags, ref.tags));
          }
        }
      }
      state.plays.push(play);
    }
  });
}

/**
 * The plays and tasks of a playbook in the order they run, with the names
 * ansible itself gives them -- the names `--start-at-task` and the range
 * plugin match on. Read by the same line scanner as the tags, so the same
 * limits apply: a task generated at runtime, or a role reached through a
 * templated name, is not here.
 *
 * @param {string} root workspace folder path
 * @param {string} playbookFile absolute path
 * @param {Partial<import("./defaults").Settings>} [settings]
 * @returns {PlaybookOutline}
 */
function findPlaybookOutline(root, playbookFile, settings) {
  /** @type {OutlineState} */
  const state = {
    root,
    settings: { ...DEFAULTS, ...(settings || {}) },
    plays: [],
    strategy: null,
    skipped: 0,
    reads: 0,
    stack: new Set(),
  };
  outlinePlaybook(state, playbookFile);
  return { plays: state.plays, strategy: state.strategy, skipped: state.skipped };
}

/**
 * Every task name of an outline, in run order, duplicates kept -- a role used
 * by two plays is two runs of the same names.
 *
 * @param {PlaybookOutline} outline
 * @returns {string[]}
 */
function outlineTaskNames(outline) {
  return outline.plays.flatMap((play) => play.tasks.map((task) => task.name));
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
  findPlaybookOutline,
  findPlaybookTags,
  formatTagList,
  outlineTaskNames,
  parseTagList,
};
