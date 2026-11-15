/**
 * Parsing and writing the INI inventory (`hosts.ini`) of one environment.
 *
 * Pure: no `vscode`, no disk. The Inventory tab edits the model this module
 * produces and writes `serializeInventory` of it back. Comments outside
 * "manual blocks" are not part of the model and are dropped on write (the
 * parser says so in `warnings`); manual blocks are carried through verbatim.
 */

"use strict";

const crypto = require("node:crypto");

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

const PASSWORD_VARS = new Set(["ansible_password", "ansible_ssh_pass", "ansible_become_pass", "ansible_become_password"]);

const SSH_FIELDS = [
  "ansible_host",
  "ansible_user",
  "ansible_port",
  "ansible_ssh_private_key_file",
  "ansible_ssh_common_args",
];

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
        errors.push(
          `${owner}: ${key} must not be written to the inventory; put it in the vault of group ${group} (group_vars/${group}/vault) instead.`,
        );
      }
      if (/[\r\n]/.test(value)) {
        errors.push(`${owner}: the value of ${key} must not contain a line break.`);
      }
    }
  };

  for (const group of groups) {
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
  const editable = fromEdit.filter((entry) => !entry.readOnly && !manualNames.has(entry.name));
  /** @type {T[]} */
  const result = [];
  let next = 0;
  for (const entry of onDisk) {
    if (entry.readOnly) {
      result.push(entry);
    } else {
      const replacement = editable[next++];
      if (replacement) {
        result.push(replacement);
      }
    }
  }
  result.push(...editable.slice(next));
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
 * Keys that were added, removed or changed between two var lists.
 *
 * @param {Var[]} before
 * @param {Var[]} after
 */
function changedKeys(before, after) {
  const keys = [...new Set([...before.map((entry) => entry[0]), ...after.map((entry) => entry[0])])];
  return keys.filter((key) => before.find((entry) => entry[0] === key)?.[1] !== after.find((entry) => entry[0] === key)?.[1]);
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
          lines.push(`${group.name}: ${host.name} changed (${changedKeys(was.vars, host.vars).join(", ")})`);
        }
      }
      const oldChildren = "children" in old ? old.children : [];
      const children = "children" in group ? group.children : [];
      for (const child of children.filter((name) => !oldChildren.includes(name))) {
        lines.push(`${group.name}: + ${child}`);
      }
      for (const child of oldChildren.filter((name) => !children.includes(name))) {
        lines.push(`${group.name}: \u2212 ${child}`);
      }
      if (!sameVars(old.vars, group.vars)) {
        lines.push(`${group.name}:vars changed`);
      }
    }
  };
  compare("server group", before.serverGroups, after.serverGroups);
  compare("service", before.services, after.services);
  return lines;
}

/** Text of a brand-new inventory file: just the empty manual block. */
function newInventoryText() {
  return `# Edited by Playbook Runner. Text between these two marker lines is kept as written:\n${MANUAL_BEGIN}\n${MANUAL_END}\n`;
}

module.exports = {
  MANUAL_BEGIN,
  MANUAL_END,
  PASSWORD_VARS,
  SSH_FIELDS,
  describeChanges,
  inventoryHash,
  mergeEdits,
  newInventoryText,
  parseInventory,
  serializeInventory,
  validateInventory,
};
