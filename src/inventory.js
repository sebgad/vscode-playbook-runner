/**
 * Parsing and writing the INI inventory (`hosts.ini`) of one environment.
 *
 * Pure: no `vscode`, no disk. The Inventory tab edits the model this module
 * produces and writes `serializeInventory` of it back. Comments outside
 * "manual blocks" are not part of the model and are dropped on write (the
 * parser says so in `warnings`); manual blocks are carried through verbatim.
 */

"use strict";

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
  for (let i = 0; i < line.length; i++) {
    const ch = /** @type {string} */ (line[i]);
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if ((ch === "#" || ch === ";") && (i === 0 || /\s/.test(/** @type {string} */ (line[i - 1])))) {
      return { text: line.slice(0, i).trim(), comment: true };
    }
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

/** @param {string} value */
function unquote(value) {
  const first = value[0];
  if (value.length >= 2 && (first === "'" || first === '"') && value.endsWith(first)) {
    return value.slice(1, -1);
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
  let duplicates = 0;
  /** @type {string | null} */
  let error = null;

  /** @type {{ line: number, lines: string[] } | null} */
  let block = null;
  /** @type {{ kind: "hosts" | "vars" | "children", group: GroupRecord | null }} */
  let context = { kind: "hosts", group: null };

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const marker = raw.trim();

    if (marker === MANUAL_BEGIN) {
      if (block) {
        error = error || `Manual block opened on line ${lineNumber} is nested inside the one opened on line ${block.line}.`;
        block.lines.push(raw);
      } else {
        block = { line: lineNumber, lines: [raw] };
      }
      return;
    }
    if (marker === MANUAL_END) {
      if (!block) {
        error = error || `Manual block end on line ${lineNumber} has no matching begin.`;
        return;
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
      block = null;
      return;
    }

    const { text: content, comment } = stripComment(raw);
    if (block) {
      block.lines.push(raw);
      const header = /^\[([^\]]+)\]$/.exec(content);
      if (header) {
        manualGroups.add(/** @type {string} */ (header[1]).replace(/:(vars|children)$/, ""));
      }
      return;
    }

    if (comment) {
      comments++;
    }
    if (!content) {
      return;
    }

    const header = /^\[([^\]]+)\]$/.exec(content);
    if (header) {
      const full = /** @type {string} */ (header[1]);
      if (seenHeaders.has(full)) {
        duplicates++;
      }
      seenHeaders.add(full);
      headers.push(full);
      const parts = /^(.*):(vars|children)$/.exec(full);
      const record = group(parts ? /** @type {string} */ (parts[1]) : full);
      const kind = parts ? /** @type {"vars" | "children"} */ (parts[2]) : "hosts";
      if (kind === "children") {
        record.isService = true;
      }
      context = { kind, group: record };
      return;
    }

    const record = context.group || group("ungrouped");
    context.group = record;
    if (context.kind === "vars") {
      const entry = splitVar(content);
      if (entry) {
        setVar(record.vars, entry);
      }
    } else if (context.kind === "children") {
      const member = tokenize(content)[0];
      if (member && !record.children.includes(member)) {
        record.children.push(member);
      }
    } else {
      const [name, ...rest] = tokenize(content);
      if (!name) {
        return;
      }
      let host = record.hosts.find((item) => item.name === name);
      if (!host) {
        host = { name, vars: [] };
        record.hosts.push(host);
      }
      for (const token of rest) {
        const entry = splitVar(token);
        if (entry) {
          setVar(host.vars, entry);
        }
      }
    }
  });

  if (block) {
    const open = /** @type {{ line: number }} */ (block);
    error = error || `Manual block opened on line ${open.line} is never closed.`;
  }

  /** @type {string[]} */
  const warnings = [];
  if (comments > 0) {
    warnings.push(`${comments} comment line(s) outside manual blocks will be removed`);
  }
  if (duplicates > 0) {
    warnings.push(`${duplicates} duplicate section(s) will be merged`);
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
    if (group.name !== "all" && (group.hosts.length > 0 || group.vars.length === 0)) {
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

module.exports = {
  MANUAL_BEGIN,
  MANUAL_END,
  parseInventory,
  serializeInventory,
};
