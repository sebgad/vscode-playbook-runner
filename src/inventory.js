/**
 * Parsing and writing the INI inventory (`hosts.ini`) of one environment.
 *
 * Never requires `vscode`. Parsing and serializing are pure; only the group
 * rename/delete plans and `applyGroupRename` touch the disk. The Inventory tab edits the model this module
 * produces and writes `serializeInventory` of it back. Comments outside
 * "manual blocks" are not part of the model and are dropped on write (the
 * parser says so in `warnings`); manual blocks are carried through verbatim.
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { findEnvironments, findPlaybooks, isDirectory } = require("./discovery");

/** @typedef {[string, string]} Var */
/** @typedef {{ name: string, vars: Var[] }} Host */
/** @typedef {{ name: string, hosts: Host[], vars: Var[], readOnly: boolean }} ServerGroup */
/** @typedef {{ name: string, children: string[], hosts: Host[], vars: Var[], readOnly: boolean }} Service */
/**
 * @typedef {object} ManualBlock
 * @property {string} text Verbatim, markers included, no trailing EOL.
 * @property {number} line 1-based line of the begin marker.
 * @property {string[]} anchors Managed section headers (e.g. "podman_servers:vars")
 *   preceding the block, nearest first.
 */
/**
 * @typedef {object} Inventory
 * @property {ServerGroup[]} serverGroups
 * @property {Service[]} services
 * @property {ManualBlock[]} manual
 * @property {string[]} manualGroups Groups with a section inside a manual block.
 * @property {string[]} warnings
 * @property {string | null} error
 * @property {"\n" | "\r\n"} eol
 */

const MANUAL_BEGIN = "# playbook-runner: manual begin";
const MANUAL_END = "# playbook-runner: manual end";

/**
 * Cut an inline comment: `#` or `;` outside quotes, at the start of the line
 * or after whitespace.
 *
 * @param {string} line
 * @returns {{ text: string, comment: boolean }}
 */
function stripComment(line) {
  /** @type {string | null} */
  let quote = null;
  let previous = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if ((ch === "#" || ch === ";") && (i === 0 || /\s/.test(previous))) {
      return { text: line.slice(0, i).trim(), comment: true };
    }
    previous = ch;
  }
  return { text: line.trim(), comment: false };
}

/**
 * Split on whitespace outside quotes; quotes stay in the tokens.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  /** @type {string[]} */
  const tokens = [];
  let current = "";
  /** @type {string | null} */
  let quote = null;
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

/**
 * Whether Ansible would read the bare text as something other than a string.
 *
 * @param {string} inner
 */
function looksLikeLiteral(inner) {
  return NUMBER.test(inner) || ["True", "False", "None"].includes(inner) || /^[[{(]/.test(inner);
}

/**
 * Strip one pair of surrounding quotes, except where that would change the
 * value's type (`"22"` stays quoted: bare, Ansible reads an int).
 *
 * @param {string} value
 */
function unquote(value) {
  const first = value.charAt(0);
  if (value.length >= 2 && (first === "'" || first === '"') && value.endsWith(first)) {
    const inner = value.slice(1, -1);
    return looksLikeLiteral(inner) ? value : inner;
  }
  return value;
}

/**
 * `key=value` split on the first `=`; null without one.
 *
 * @param {string} text
 * @returns {Var | null}
 */
function splitVar(text) {
  const at = text.indexOf("=");
  if (at <= 0) {
    return null;
  }
  return [text.slice(0, at).trim(), unquote(text.slice(at + 1).trim())];
}

/**
 * Set a var, replacing an existing key in place (later wins).
 *
 * @param {Var[]} vars
 * @param {Var} entry
 */
function setVar(vars, entry) {
  const existing = vars.find((item) => item[0] === entry[0]);
  if (existing) {
    existing[1] = entry[1];
  } else {
    vars.push(entry);
  }
}

/**
 * @param {string} text
 * @returns {Inventory}
 */
function parseInventory(text) {
  const source = String(text || "");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  /**
   * @typedef {{ name: string, hosts: Host[], vars: Var[], children: string[], isService: boolean }} GroupRecord
   */
  /** @type {Map<string, GroupRecord>} */
  const groups = new Map();
  /** @param {string} name */
  const group = (name) => {
    let record = groups.get(name);
    if (!record) {
      record = { name, hosts: [], vars: [], children: [], isService: false };
      groups.set(name, record);
    }
    return record;
  };

  /** @type {ManualBlock[]} */
  const manual = [];
  /** @type {Set<string>} */
  const manualGroups = new Set();
  /** @type {Set<string>} */
  const seenHeaders = new Set();
  /** @type {string[]} */
  const headers = [];
  let comments = 0;
  let duplicateSections = 0;
  let duplicateEntries = 0;
  let unreadable = 0;
  /** @type {string | null} */
  let error = null;

  /** @type {{ line: number, lines: string[], opensSection: boolean } | null} */
  let block = null;
  // A block that opened a section moves where header-less lines belong.
  let afterSectionBlock = false;
  /** @type {{ kind: "hosts" | "vars" | "children", group: GroupRecord | null }} */
  let context = { kind: "hosts", group: null };
  /** Keys seen in the current section occurrence (hosts, var keys, members). */
  let sectionSeen = new Set();

  for (const [index, raw] of lines.entries()) {
    const lineNumber = index + 1;
    const marker = raw.trim();

    if (marker === MANUAL_BEGIN) {
      if (block) {
        error = error || `Manual block opened on line ${lineNumber} is nested inside the one opened on line ${block.line}.`;
        block.lines.push(raw);
      } else {
        block = { line: lineNumber, lines: [raw], opensSection: false };
      }
      continue;
    }
    if (marker === MANUAL_END) {
      if (!block) {
        error = error || `Manual block end on line ${lineNumber} has no matching begin.`;
        continue;
      }
      block.lines.push(raw);
      /** @type {string[]} */
      const anchors = [];
      for (const header of [...headers].reverse()) {
        if (!anchors.includes(header)) {
          anchors.push(header);
        }
      }
      manual.push({ text: block.lines.join("\n"), line: block.line, anchors });
      afterSectionBlock = afterSectionBlock || block.opensSection;
      block = null;
      continue;
    }

    const { text: content, comment } = stripComment(raw);
    const header = /^\[([^\]]+)\]$/.exec(content);
    if (block) {
      block.lines.push(raw);
      if (header) {
        block.opensSection = true;
        manualGroups.add((header[1] ?? "").replace(/:(vars|children)$/, ""));
      }
      continue;
    }

    if (comment) {
      comments++;
    }
    if (!content) {
      continue;
    }

    if (header) {
      const full = header[1] ?? "";
      if (seenHeaders.has(full)) {
        duplicateSections++;
      }
      seenHeaders.add(full);
      headers.push(full);
      afterSectionBlock = false;
      sectionSeen = new Set();
      const parts = /^(.*):(vars|children)$/.exec(full);
      const record = group(parts ? (parts[1] ?? "") : full);
      const kind = parts?.[2] === "vars" ? "vars" : parts?.[2] === "children" ? "children" : "hosts";
      if (kind === "children") {
        record.isService = true;
      }
      context = { kind, group: record };
      continue;
    }

    if (afterSectionBlock) {
      error = error || `Line ${lineNumber} follows a manual block that opens a section; start it with a section header.`;
      afterSectionBlock = false;
    }

    const record = context.group || group("ungrouped");
    context.group = record;
    if (context.kind === "vars") {
      const entry = splitVar(content);
      if (!entry) {
        unreadable++;
      } else {
        if (sectionSeen.has(entry[0])) {
          duplicateEntries++;
        }
        sectionSeen.add(entry[0]);
        setVar(record.vars, entry);
      }
    } else if (context.kind === "children") {
      const [member, ...extra] = tokenize(content);
      unreadable += extra.length;
      if (member !== undefined) {
        if (sectionSeen.has(member)) {
          duplicateEntries++;
        }
        sectionSeen.add(member);
        if (!record.children.includes(member)) {
          record.children.push(member);
        }
      }
    } else {
      const [name, ...rest] = tokenize(content);
      if (name === undefined) {
        continue;
      }
      if (sectionSeen.has(name)) {
        duplicateEntries++;
      }
      sectionSeen.add(name);
      let host = record.hosts.find((item) => item.name === name);
      if (!host) {
        host = { name, vars: [] };
        record.hosts.push(host);
      }
      /** @type {Set<string>} */
      const keys = new Set();
      for (const token of rest) {
        const entry = splitVar(token);
        if (!entry) {
          unreadable++;
          continue;
        }
        if (keys.has(entry[0])) {
          duplicateEntries++;
        }
        keys.add(entry[0]);
        setVar(host.vars, entry);
      }
    }
  }

  if (block) {
    error = error || `Manual block opened on line ${block.line} is never closed.`;
  }

  /** @type {string[]} */
  const warnings = [];
  if (comments > 0) {
    warnings.push(`${comments} comment line(s) outside manual blocks will be removed`);
  }
  if (duplicateSections > 0) {
    warnings.push(`${duplicateSections} duplicate section(s) will be merged`);
  }
  if (unreadable > 0) {
    warnings.push(`${unreadable} unreadable entr${unreadable === 1 ? "y" : "ies"} will be removed`);
  }
  if (duplicateEntries > 0) {
    warnings.push(`${duplicateEntries} duplicate entr${duplicateEntries === 1 ? "y" : "ies"} will be merged`);
  }

  const records = [...groups.values()];
  return {
    serverGroups: records
      .filter((record) => !record.isService)
      .map((record) => ({
        name: record.name,
        hosts: record.hosts,
        vars: record.vars,
        readOnly: manualGroups.has(record.name),
      })),
    services: records
      .filter((record) => record.isService)
      .map((record) => ({
        name: record.name,
        children: record.children,
        hosts: record.hosts,
        vars: record.vars,
        readOnly: manualGroups.has(record.name),
      })),
    manual,
    manualGroups: [...manualGroups],
    warnings,
    error,
    eol,
  };
}

/**
 * `v`, or `'v'` / `"v"` when the value would not survive a re-parse bare.
 *
 * @param {string} value
 */
function quoteValue(value) {
  const first = value.charAt(0);
  if (value.length >= 2 && (first === "'" || first === '"') && value.endsWith(first)) {
    // Already wrapped (kept so a string stays a string): write as is, unless
    // the quote char also occurs unescaped inside.
    if (!new RegExp(`(?<!\\\\)${first}`).test(value.slice(1, -1))) {
      return value;
    }
  }
  if (!/[\s'"#;]/.test(value)) {
    return value;
  }
  return value.includes("'") ? `"${value}"` : `'${value}'`;
}

/** @param {Var} entry */
function varText(entry) {
  return `${entry[0]}=${quoteValue(entry[1])}`;
}

/** @param {Host} host */
function hostLine(host) {
  return [host.name, ...host.vars.map(varText)].join(" ");
}

/**
 * @param {Inventory} inventory
 * @returns {string}
 */
function serializeInventory(inventory) {
  /** @type {{ header: string, lines: string[] }[]} */
  const sections = [];
  /**
   * @param {string} header
   * @param {string[]} body
   */
  const add = (header, body) => sections.push({ header, lines: [`[${header}]`, ...body] });

  for (const group of inventory.serverGroups) {
    if ((group.name !== "all" || group.hosts.length > 0) && (group.hosts.length > 0 || group.vars.length === 0)) {
      add(group.name, group.hosts.map(hostLine));
    }
  }
  for (const group of inventory.serverGroups) {
    if (group.vars.length > 0) {
      add(`${group.name}:vars`, group.vars.map(varText));
    }
  }
  for (const service of inventory.services) {
    if (service.hosts.length > 0) {
      add(service.name, service.hosts.map(hostLine));
    }
    add(`${service.name}:children`, service.children);
    if (service.vars.length > 0) {
      add(`${service.name}:vars`, service.vars.map(varText));
    }
  }

  /** @type {Map<string, string[]>} header -> block texts */
  const after = new Map();
  /** @type {string[]} */
  const top = [];
  for (const block of inventory.manual) {
    const anchor = block.anchors.find((header) => sections.some((section) => section.header === header));
    if (anchor === undefined) {
      top.push(block.text);
    } else {
      after.set(anchor, [...(after.get(anchor) || []), block.text]);
    }
  }

  /** @type {string[]} */
  const chunks = [...top];
  for (const section of sections) {
    chunks.push(section.lines.join("\n"), ...(after.get(section.header) || []));
  }
  if (chunks.length === 0) {
    return "";
  }
  return `${chunks.join("\n\n")}\n`.replace(/\n/g, inventory.eol);
}

/** @type {ReadonlySet<string>} */
const PASSWORD_VARS = new Set(["ansible_password", "ansible_ssh_pass", "ansible_become_pass", "ansible_become_password"]);

/** @type {readonly string[]} */
const SSH_FIELDS = Object.freeze([
  "ansible_host",
  "ansible_user",
  "ansible_port",
  "ansible_ssh_private_key_file",
  "ansible_ssh_common_args",
]);

const GROUP_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST_NAME = /^[A-Za-z0-9_.\-[\]:]+$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Everything that stops an inventory from being saved; [] means savable.
 *
 * @param {Inventory} inventory
 * @returns {string[]}
 */
function validateInventory(inventory) {
  /** @type {string[]} */
  const errors = [];
  if (inventory.error) {
    errors.push(inventory.error);
  }
  /** @type {(ServerGroup | Service)[]} */
  const groups = [...inventory.serverGroups, ...inventory.services];

  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const group of groups) {
    counts.set(group.name, (counts.get(group.name) || 0) + 1);
  }
  for (const name of inventory.manualGroups) {
    // A read-only entry is the model's view of the manual group itself.
    if (!groups.some((group) => group.readOnly && group.name === name)) {
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  for (const [name, count] of counts) {
    if (count > 1) {
      errors.push(`Group name "${name}" is used more than once.`);
    }
  }

  /** @type {Map<string, string>} host -> first group where it has vars */
  const hostVarGroups = new Map();
  /** @type {Set<string>} */
  const reportedHosts = new Set();
  /**
   * @param {string} group
   * @param {Var[]} vars
   * @param {string} owner
   */
  const checkVars = (group, vars, owner) => {
    for (const [key, value] of vars) {
      if (!VAR_NAME.test(key)) {
        errors.push(`${owner}: "${key}" is not a valid variable name.`);
      }
      if (PASSWORD_VARS.has(key)) {
        errors.push(`${owner}: ${key} is a password; keep it in the vault of ${group}, not in the inventory.`);
      }
      if (/[\r\n]/.test(value)) {
        errors.push(`${owner}: the value of ${key} must not contain a line break.`);
      }
    }
  };

  for (const group of groups) {
    if (group.readOnly) {
      continue;
    }
    if (!GROUP_NAME.test(group.name)) {
      errors.push(`"${group.name}" is not a valid group name. Ansible group names allow letters, digits and _.`);
    }
    checkVars(group.name, group.vars, `Group ${group.name}`);
    for (const host of group.hosts) {
      if (!HOST_NAME.test(host.name)) {
        errors.push(`"${host.name}" is not a valid host name (group ${group.name}).`);
      }
      checkVars(group.name, host.vars, `Host ${host.name} in ${group.name}`);
      if (host.vars.length > 0) {
        const first = hostVarGroups.get(host.name);
        if (first === undefined) {
          hostVarGroups.set(host.name, group.name);
        } else if (first !== group.name && !reportedHosts.has(host.name)) {
          reportedHosts.add(host.name);
          errors.push(`Host ${host.name} has variables in more than one group (${first}, ${group.name}); keep them in one.`);
        }
      }
    }
  }

  const known = new Set([...groups.map((group) => group.name), ...inventory.manualGroups]);
  for (const service of inventory.services) {
    for (const child of service.children) {
      if (!known.has(child)) {
        errors.push(`Service ${service.name} lists "${child}" as a child, but no such group exists.`);
      }
    }
  }

  /** @type {Map<string, string[]>} */
  const edges = new Map(inventory.services.map((service) => [service.name, service.children]));
  /** @type {Set<string>} */
  const done = new Set();
  /** @type {Set<string>} */
  const cyclic = new Set();
  /**
   * @param {string} name
   * @param {string[]} trail
   */
  const visit = (name, trail) => {
    if (trail.includes(name)) {
      if (!cyclic.has(name)) {
        cyclic.add(name);
        errors.push(`Services form a cycle: ${[...trail.slice(trail.indexOf(name)), name].join(" -> ")}.`);
      }
      return;
    }
    if (done.has(name)) {
      return;
    }
    for (const child of edges.get(name) || []) {
      visit(child, [...trail, name]);
    }
    done.add(name);
  };
  for (const name of edges.keys()) {
    visit(name, []);
  }

  return errors;
}

/** @param {string} text */
function inventoryHash(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

/**
 * `disk` with its editable groups and services replaced by those of `edited`.
 * Read-only entries and everything manual always come from disk.
 *
 * @template {ServerGroup | Service} T
 * @param {T[]} onDisk
 * @param {T[]} fromEdit
 * @param {Set<string>} manualNames
 * @returns {T[]}
 */
function mergeEntries(onDisk, fromEdit, manualNames) {
  /** @type {T[]} */
  const result = fromEdit.filter((entry) => !entry.readOnly && !manualNames.has(entry.name));
  // A read-only entry stays after the nearest disk neighbour that survives.
  for (const [index, entry] of onDisk.entries()) {
    if (!entry.readOnly) {
      continue;
    }
    let at = 0;
    for (let before = index - 1; before >= 0; before--) {
      const name = onDisk[before]?.name;
      const found = result.findIndex((item) => item.name === name);
      if (found >= 0) {
        at = found + 1;
        break;
      }
    }
    result.splice(at, 0, entry);
  }
  return result;
}

/**
 * @param {Inventory} disk
 * @param {{ serverGroups: ServerGroup[], services: Service[] }} edited
 * @returns {Inventory}
 */
function mergeEdits(disk, edited) {
  const manualNames = new Set(disk.manualGroups);
  return {
    serverGroups: mergeEntries(disk.serverGroups, edited.serverGroups, manualNames),
    services: mergeEntries(disk.services, edited.services, manualNames),
    manual: disk.manual,
    manualGroups: disk.manualGroups,
    warnings: disk.warnings,
    error: disk.error,
    eol: disk.eol,
  };
}

/**
 * @param {Var[]} before
 * @param {Var[]} after
 */
function sameVars(before, after) {
  return before.length === after.length && before.every((entry, i) => entry[0] === after[i]?.[0] && entry[1] === after[i]?.[1]);
}

/**
 * Keys whose values differ between two var lists (all occurrences compared).
 *
 * @param {Var[]} before
 * @param {Var[]} after
 */
function changedKeys(before, after) {
  const keys = [...new Set([...before.map((entry) => entry[0]), ...after.map((entry) => entry[0])])];
  /** @param {Var[]} vars @param {string} key */
  const values = (vars, key) => JSON.stringify(vars.filter((entry) => entry[0] === key).map((entry) => entry[1]));
  return keys.filter((key) => values(before, key) !== values(after, key));
}

/**
 * Same members, different order.
 *
 * @param {string[]} before
 * @param {string[]} after
 */
function reordered(before, after) {
  return (
    before.length === after.length &&
    before.every((name) => after.includes(name)) &&
    before.some((name, i) => name !== after[i])
  );
}

/**
 * Human-readable lines for what saving `after` over `before` changes.
 *
 * @param {Inventory} before
 * @param {Inventory} after
 * @returns {string[]}
 */
function describeChanges(before, after) {
  /** @type {string[]} */
  const lines = [];
  /**
   * @param {string} kind
   * @param {(ServerGroup | Service)[]} was
   * @param {(ServerGroup | Service)[]} now
   */
  const compare = (kind, was, now) => {
    for (const group of now) {
      if (!was.some((item) => item.name === group.name)) {
        lines.push(`+ ${kind} ${group.name}`);
      }
    }
    for (const old of was) {
      const group = now.find((item) => item.name === old.name);
      if (!group) {
        lines.push(`\u2212 ${kind} ${old.name}`);
        continue;
      }
      for (const host of group.hosts) {
        if (!old.hosts.some((item) => item.name === host.name)) {
          lines.push(`${group.name}: + host ${host.name}`);
        }
      }
      for (const host of old.hosts) {
        if (!group.hosts.some((item) => item.name === host.name)) {
          lines.push(`${group.name}: \u2212 host ${host.name}`);
        }
      }
      for (const host of group.hosts) {
        const was = old.hosts.find((item) => item.name === host.name);
        if (was && !sameVars(was.vars, host.vars)) {
          const keys = changedKeys(was.vars, host.vars);
          lines.push(`${group.name}: ${host.name} changed (${keys.length > 0 ? keys.join(", ") : "order"})`);
        }
      }
      if (reordered(old.hosts.map((item) => item.name), group.hosts.map((item) => item.name))) {
        lines.push(`${group.name}: hosts reordered`);
      }
      const oldChildren = "children" in old ? old.children : [];
      const children = "children" in group ? group.children : [];
      for (const child of children.filter((name) => !oldChildren.includes(name))) {
        lines.push(`${group.name}: + ${child}`);
      }
      for (const child of oldChildren.filter((name) => !children.includes(name))) {
        lines.push(`${group.name}: \u2212 ${child}`);
      }
      if (reordered(oldChildren, children)) {
        lines.push(`${group.name}: children reordered`);
      }
      if (!sameVars(old.vars, group.vars)) {
        lines.push(`${group.name}:vars changed`);
      }
    }
  };
  compare("server group", before.serverGroups, after.serverGroups);
  compare("service", before.services, after.services);
  /** @param {{ name: string }[]} list */
  const nameList = (list) => list.map((item) => item.name);
  if (
    reordered(nameList(before.serverGroups), nameList(after.serverGroups)) ||
    reordered(nameList(before.services), nameList(after.services))
  ) {    lines.push("groups reordered");
  }
  return lines;
}

/** Text of a brand-new inventory file: just the empty manual block. */
function newInventoryText() {
  return `# Edited by Playbook Runner. Text between these two marker lines is kept as written:\n${MANUAL_BEGIN}\n${MANUAL_END}\n`;
}

/**
 * Every playbook (path relative to `root`, sorted) with a `hosts:` line that
 * names `group`, alone or in a pattern such as `a:immich`, `!immich` or a list.
 *
 * @param {string} root
 * @param {import("./defaults").Settings} settings
 * @param {string} group
 * @returns {string[]}
 */
function playbooksNamingGroup(root, settings, group) {
  /** @type {string[]} */
  const found = [];
  for (const playbookGroup of findPlaybooks(root, settings)) {
    for (const playbook of playbookGroup.playbooks) {
      let text = "";
      try {
        text = fs.readFileSync(playbook.file, "utf8");
      } catch {
        continue;
      }
      const names = text.split(/\r?\n/).some((line) => {
        const match = /^\s*(?:-\s+)?hosts:\s*(.+?)\s*$/.exec(line);
        if (!match || match[1] === undefined) {
          return false;
        }
        const value = match[1].replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
        return value
          .split(/[:,]/)
          .some((part) => part.trim().replace(/^[&!]+/, "").replace(/^\[+|\]+$/g, "").replace(/^(["'])(.*)\1$/, "$2").trim() === group);
      });
      if (names) {
        found.push(path.relative(root, playbook.file));
      }
    }
  }
  return found.sort();
}

/**
 * @typedef {object} GroupRenamePlan
 * @property {string} environment
 * @property {string} from
 * @property {string} to
 * @property {string} text New inventory text.
 * @property {string | null} groupVarsFrom group_vars directory to move, if there is one.
 * @property {string} groupVarsTo
 * @property {string[]} groupVarsFiles File-form group vars (`<name>.yml` ...); reported, not moved.
 * @property {string[]} services Services that list the group as a child.
 * @property {string[]} playbooks Playbooks naming the group (they are not edited).
 * @property {string[]} otherEnvironments Other environments that have a group of that name.
 * @property {number[]} manualReferences Lines of manual blocks that mention the group; left untouched.
 */

/**
 * @typedef {object} GroupDeletePlan
 * @property {string} environment
 * @property {string} name
 * @property {string} text New inventory text.
 * @property {string | null} groupVars group_vars directory of the group, if it exists (left on disk).
 * @property {string[]} groupVarsFiles File-form group vars; left on disk.
 * @property {string[]} services Services that listed the group.
 * @property {string[]} emptied Those services that end up with no children and no hosts.
 * @property {string[]} playbooks Playbooks naming the group.
 * @property {number[]} manualReferences Lines of manual blocks that mention the group; left untouched.
 */

const GROUP_VARS_FILE_EXTENSIONS = [".yml", ".yaml", ".json"];

/**
 * @param {string} dir
 * @param {string} name
 * @returns {string[]}
 */
function groupVarsFilesOf(dir, name) {
  return GROUP_VARS_FILE_EXTENSIONS.map((extension) => path.join(dir, `${name}${extension}`)).filter((file) =>
    fs.existsSync(file),
  );
}

/**
 * @param {Inventory} inventory
 * @param {string} name
 * @returns {number[]}
 */
function manualReferencesTo(inventory, name) {
  const pattern = new RegExp(`(^|[\\s\\[:,])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[\\s\\]:,=])`);
  return inventory.manual
    .filter((block) =>
      block.text.split(/\r?\n/).some((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith("#") && !trimmed.startsWith(";") && pattern.test(line);
      }),
    )
    .map((block) => block.line);
}

/**
 * @param {string} diskText
 * @param {string} name
 * @param {string} verb
 * @returns {Inventory}
 */
function parseForGroupChange(diskText, name, verb) {
  const inventory = parseInventory(diskText);
  if (inventory.error) {
    throw new Error(`The inventory cannot be read, so the group is left alone: ${inventory.error}`);
  }
  if (inventory.manualGroups.includes(name)) {
    throw new Error(`"${name}" is defined in a manual block; edit the text yourself to ${verb} it.`);
  }
  const group = [...inventory.serverGroups, ...inventory.services].find((item) => item.name === name);
  if (!group) {
    throw new Error(`"${name}" is not a group of this inventory.`);
  }
  if (group.readOnly) {
    throw new Error(`"${name}" cannot be edited here; edit the inventory text to ${verb} it.`);
  }
  return inventory;
}

/**
 * @param {string} root
 * @param {import("./defaults").Settings} settings
 * @param {import("./discovery").Environment} environment
 * @param {string} diskText
 * @param {string} from
 * @param {string} to
 * @returns {GroupRenamePlan}
 */
function planGroupRename(root, settings, environment, diskText, from, to) {
  if (from === to) {
    throw new Error("The name is unchanged.");
  }
  const inventory = parseForGroupChange(diskText, from, "rename");
  if (!GROUP_NAME.test(to)) {
    throw new Error(`"${to}" is not a valid group name (letters, digits and underscores; not starting with a digit).`);
  }
  const taken = [...inventory.serverGroups, ...inventory.services].some((item) => item.name === to);
  if (taken || inventory.manualGroups.includes(to)) {
    throw new Error(`A group named "${to}" already exists.`);
  }
  const groupVarsTo = path.join(environment.groupVarsDir, to);
  if (fs.existsSync(groupVarsTo)) {
    throw new Error(`${groupVarsTo} already exists, so "${from}" cannot be renamed to "${to}".`);
  }
  const [blocking] = groupVarsFilesOf(environment.groupVarsDir, to);
  if (blocking) {
    throw new Error(`${blocking} already exists, so "${from}" cannot be renamed to "${to}".`);
  }
  const groupVarsFromPath = path.join(environment.groupVarsDir, from);

  /** @type {string[]} */
  const services = [];
  /** @param {string} header */
  const moveHeader = (header) =>
    header === from ? to : header.startsWith(`${from}:`) ? to + header.slice(from.length) : header;
  const renamed = {
    ...inventory,
    serverGroups: inventory.serverGroups.map((group) => (group.name === from ? { ...group, name: to } : group)),
    services: inventory.services.map((service) => {
      const name = service.name === from ? to : service.name;
      if (!service.children.includes(from)) {
        return { ...service, name };
      }
      services.push(service.name);
      return { ...service, name, children: service.children.map((child) => (child === from ? to : child)) };
    }),
    manual: inventory.manual.map((block) => ({ ...block, anchors: block.anchors.map(moveHeader) })),
  };

  /** @type {string[]} */
  const otherEnvironments = [];
  for (const other of findEnvironments(root, settings)) {
    if (other.name === environment.name) {
      continue;
    }
    try {
      const parsed = parseInventory(fs.readFileSync(other.inventory, "utf8"));
      if ([...parsed.serverGroups, ...parsed.services].some((item) => item.name === from)) {
        otherEnvironments.push(other.name);
      }
    } catch {
      // An unreadable sibling inventory is not this plan's problem.
    }
  }

  return {
    environment: environment.name,
    from,
    to,
    text: serializeInventory(renamed),
    groupVarsFrom: isDirectory(groupVarsFromPath) ? groupVarsFromPath : null,
    groupVarsTo,
    groupVarsFiles: groupVarsFilesOf(environment.groupVarsDir, from),
    services,
    playbooks: playbooksNamingGroup(root, settings, from),
    otherEnvironments,
    manualReferences: manualReferencesTo(inventory, from),
  };
}

/**
 * @param {string} root
 * @param {import("./defaults").Settings} settings
 * @param {import("./discovery").Environment} environment
 * @param {string} diskText
 * @param {string} name
 * @returns {GroupDeletePlan}
 */
function planGroupDelete(root, settings, environment, diskText, name) {
  const inventory = parseForGroupChange(diskText, name, "delete");
  /** @type {string[]} */
  const services = [];
  /** @type {string[]} */
  const emptied = [];
  const next = {
    ...inventory,
    serverGroups: inventory.serverGroups.filter((group) => group.name !== name),
    services: inventory.services
      .filter((service) => service.name !== name)
      .map((service) => {
        if (!service.children.includes(name)) {
          return service;
        }
        services.push(service.name);
        const children = service.children.filter((child) => child !== name);
        if (children.length === 0 && service.hosts.length === 0) {
          emptied.push(service.name);
        }
        return { ...service, children };
      }),
  };
  const groupVars = path.join(environment.groupVarsDir, name);
  return {
    environment: environment.name,
    name,
    text: serializeInventory(next),
    groupVars: isDirectory(groupVars) ? groupVars : null,
    groupVarsFiles: groupVarsFilesOf(environment.groupVarsDir, name),
    services,
    emptied,
    playbooks: playbooksNamingGroup(root, settings, name),
    manualReferences: manualReferencesTo(inventory, name),
  };
}

/**
 * Write the new inventory, then move the group_vars directory. The target is
 * re-checked first (it may have appeared since planning), and the text goes
 * before the move: a failed write then changes nothing at all.
 *
 * @param {GroupRenamePlan} plan
 * @param {string} inventoryPath
 */
function applyGroupRename(plan, inventoryPath) {
  if (plan.groupVarsFrom && fs.existsSync(plan.groupVarsTo)) {
    throw new Error(`${plan.groupVarsTo} now exists; nothing was changed.`);
  }
  fs.writeFileSync(inventoryPath, plan.text);
  if (plan.groupVarsFrom) {
    try {
      fs.renameSync(plan.groupVarsFrom, plan.groupVarsTo);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `The inventory was already changed, but the group_vars directory was not moved (${plan.groupVarsFrom} to ${plan.groupVarsTo}): ${reason}`,
      );
    }
  }
}

module.exports = {
  MANUAL_BEGIN,
  MANUAL_END,
  PASSWORD_VARS,
  SSH_FIELDS,
  applyGroupRename,
  describeChanges,
  inventoryHash,
  mergeEdits,
  newInventoryText,
  parseInventory,
  planGroupDelete,
  planGroupRename,
  playbooksNamingGroup,
  serializeInventory,
  validateInventory,
};
