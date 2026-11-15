/*
 * Playbook Runner dashboard -- the page side.
 *
 * It renders what the extension sends (the model, one outline per expanded
 * playbook, the command-line preview) and asks for things by message. It
 * decides nothing that reaches ansible: the extension rebuilds every message
 * and runs through the same path the palette commands use. The command line shown at
 * the bottom is built by the extension, not here.
 */

// @ts-check
"use strict";

(function () {
  const vscode = acquireVsCodeApi();

  /**
   * @typedef {object} Options
   * @property {string} tags
   * @property {string} limit
   * @property {boolean} check
   * @property {boolean} diff
   * @property {boolean} step
   * @property {number} verbosity
   */

  /**
   * One environment's inventory as the Inventory tab edits it. `added` marks
   * a group typed in on this page (its name is still editable); it is not
   * sent. Server groups carry an empty `children`.
   *
   * @typedef {[string, string]} Var
   * @typedef {{ name: string, vars: Var[] }} Host
   * @typedef {{ name: string, children: string[], hosts: Host[], vars: Var[], readOnly: boolean, added: boolean }} Group
   * @typedef {{ hash: string, serverGroups: Group[], services: Group[] }} Draft
   */

  const MAX_DRAFTS = 50;
  const MAX_ITEMS = 500;

  /** @param {unknown} value @returns {string[] | null} */
  function restoreStrings(value) {
    return Array.isArray(value) && value.length <= MAX_ITEMS && value.every((item) => typeof item === "string")
      ? value.map(String)
      : null;
  }

  /** @param {unknown} value @returns {Var[] | null} */
  function restoreVars(value) {
    if (!Array.isArray(value) || value.length > MAX_ITEMS) {
      return null;
    }
    /** @type {Var[]} */
    const vars = [];
    for (const item of value) {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || typeof item[1] !== "string") {
        return null;
      }
      vars.push([item[0], item[1]]);
    }
    return vars;
  }

  /** @param {unknown} value @returns {Group[] | null} */
  function restoreGroups(value) {
    if (!Array.isArray(value) || value.length > MAX_ITEMS) {
      return null;
    }
    /** @type {Group[]} */
    const groups = [];
    for (const item of value) {
      if (!item || typeof item !== "object" || typeof item.name !== "string" || !Array.isArray(item.hosts) || item.hosts.length > MAX_ITEMS) {
        return null;
      }
      const children = restoreStrings(item.children);
      const vars = restoreVars(item.vars);
      /** @type {Host[]} */
      const hosts = [];
      for (const host of item.hosts) {
        const hostVars = host && typeof host === "object" && typeof host.name === "string" ? restoreVars(host.vars) : null;
        if (!hostVars) {
          return null;
        }
        hosts.push({ name: host.name, vars: hostVars });
      }
      if (!children || !vars) {
        return null;
      }
      groups.push({ name: item.name, children, hosts, vars, readOnly: item.readOnly === true, added: item.added === true });
    }
    return groups;
  }

  /**
   * Inventory drafts from the saved page state: JSON that survived a reload,
   * possibly from an older page. A draft that does not have the exact shape
   * is dropped whole rather than half-restored.
   *
   * @param {unknown} value
   * @returns {Map<string, Draft>}
   */
  function restoreDrafts(value) {
    /** @type {Map<string, Draft>} */
    const drafts = new Map();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return drafts;
    }
    for (const [key, raw] of Object.entries(value).slice(0, MAX_DRAFTS)) {
      if (!raw || typeof raw !== "object" || typeof raw.hash !== "string" || !key.includes("\n")) {
        continue;
      }
      const serverGroups = restoreGroups(raw.serverGroups);
      const services = restoreGroups(raw.services);
      if (serverGroups && services) {
        drafts.set(key, { hash: raw.hash, serverGroups, services });
      }
    }
    return drafts;
  }

  const saved = /** @type {Record<string, any>} */ (vscode.getState() || {});
  const state = {
    /** @type {"runs" | "settings" | "inventory"} */
    tab: saved.tab === "settings" || saved.tab === "inventory" ? saved.tab : "runs",
    /** @type {Map<string, Draft>} folder path + "\n" + environment name -> unsaved inventory */
    drafts: restoreDrafts(saved.drafts),
    /** @type {string | null} */ folder: typeof saved.folder === "string" ? saved.folder : null,
    /** @type {string | null} */ environment: typeof saved.environment === "string" ? saved.environment : null,
    /** @type {string | null} */ service: typeof saved.service === "string" ? saved.service : null,
    filter: typeof saved.filter === "string" ? saved.filter : "",
    /** @type {string[]} */ expanded: Array.isArray(saved.expanded) ? saved.expanded.filter((x) => typeof x === "string") : [],
    /** @type {string | null} */ selected: typeof saved.selected === "string" ? saved.selected : null,
    /** @type {{ from: string | null, until: string | null }} */
    range: {
      from: saved.range && typeof saved.range.from === "string" ? saved.range.from : null,
      until: saved.range && typeof saved.range.until === "string" ? saved.range.until : null,
    },
    /** @type {Options} */
    opts: {
      tags: "",
      limit: "",
      check: false,
      diff: false,
      step: false,
      verbosity: 0,
      ...(saved.opts && typeof saved.opts === "object" ? saved.opts : {}),
    },
  };

  /** @type {any} */
  let model = null;
  /** @type {any[]} the settings as the extension last sent them */
  let settings = [];
  /** @type {Map<string, string>} setting key -> why the last save was refused */
  const settingErrors = new Map();
  /**
   * What is typed in a Settings field and not saved yet, by the field's
   * data-key. The page re-renders whole (a run ends, a file changes), and
   * without this a half-typed value would snap back to the saved one.
   *
   * @type {Map<string, string>}
   */
  const settingDrafts = new Map();

  /** @param {string} fieldKey @param {string} fallback */
  function draftOr(fieldKey, fallback) {
    return settingDrafts.has(fieldKey) ? String(settingDrafts.get(fieldKey)) : fallback;
  }

  /** @param {string} fieldKey */
  function keepDraft(fieldKey) {
    return (/** @type {Event} */ e) => {
      settingDrafts.set(fieldKey, /** @type {HTMLInputElement} */ (e.target).value);
    };
  }

  /** Forget the drafts of one setting's fields once it saved. @param {string} key */
  function dropDrafts(key) {
    for (const fieldKey of [...settingDrafts.keys()]) {
      if (fieldKey.endsWith(`:${key}`)) {
        settingDrafts.delete(fieldKey);
      }
    }
  }
  /** @type {Record<string, string[]>} */
  let setupTags = {};
  /** @type {Map<string, any>} playbook file -> outline, or "loading" */
  const outlines = new Map();
  /** @type {Map<string, { name: string, sources: string[] }[]>} playbook file -> its tags, run order */
  const playbookTags = new Map();
  /** @type {{ playbook: string, environment: string, commandLine: string, error: string | null } | null} */
  let preview = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let previewTimer;

  const app = /** @type {HTMLElement} */ (document.getElementById("app"));

  function persist() {
    vscode.setState({
      tab: state.tab,
      folder: state.folder,
      environment: state.environment,
      service: state.service,
      filter: state.filter,
      expanded: state.expanded,
      selected: state.selected,
      range: state.range,
      opts: state.opts,
      drafts: Object.fromEntries(state.drafts),
    });
  }

  // ── Tiny DOM helper ────────────────────────────────────────────────────

  /**
   * @param {string} tag
   * @param {Record<string, any> | null} [props]
   * @param {...(Node | string | null | undefined | false | (Node | string | null | undefined | false)[])} children
   * @returns {HTMLElement}
   */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) {
        continue;
      }
      if (key === "class") {
        el.className = value;
      } else if (key.startsWith("on")) {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === "text") {
        el.textContent = value;
      } else if (key === "value") {
        /** @type {HTMLInputElement} */ (el).value = value;
      } else if (key === "checked") {
        /** @type {HTMLInputElement} */ (el).checked = Boolean(value);
      } else {
        el.setAttribute(key, value === true ? "" : String(value));
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) {
        continue;
      }
      el.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return el;
  }

  /**
   * The runner figure ("run" from Tabler Icons, MIT), inline so it takes the
   * theme's text colour -- an <img> of the SVG would not.
   */
  function runnerFigure() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "runner-figure");
    svg.setAttribute("aria-hidden", "true");
    for (const d of [
      "M13 4m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
      "M4 17l5 1l.75 -1.5",
      "M15 21l0 -4l-4 -3l1 -6",
      "M7 12l0 -3l5 -1l3 3l3 1",
    ]) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  /** @param {string} name @param {string} [extra] */
  function icon(name, extra = "") {
    return h("span", { class: `codicon codicon-${name} ${extra}`, "aria-hidden": "true" });
  }

  // ── Model lookups ──────────────────────────────────────────────────────

  function currentFolder() {
    if (!model || !model.folders.length) {
      return null;
    }
    // Without a choice yet, a folder that has environments: in a multi-root
    // workspace the first folder may well be one without any.
    return (
      model.folders.find((/** @type {any} */ f) => f.path === state.folder) ||
      model.folders.find((/** @type {any} */ f) => f.environments.length) ||
      model.folders[0]
    );
  }

  /**
   * The workspace-folder switcher, shown whenever there is more than one --
   * also on the empty state, or a folder without environments would be a dead
   * end.
   *
   * @param {any} folder
   */
  function folderSelect(folder) {
    if (model.folders.length < 2) {
      return null;
    }
    return h(
      "select",
      {
        "aria-label": "Workspace folder",
        "data-key": "folder",
        onchange: (/** @type {Event} */ e) => {
          state.folder = /** @type {HTMLSelectElement} */ (e.target).value;
          changed();
        },
      },
      model.folders.map((/** @type {any} */ f) => h("option", { value: f.path, selected: f.path === folder.path }, f.name)),
    );
  }

  /** @param {any} folder */
  function currentEnvironment(folder) {
    if (!folder || !folder.environments.length) {
      return null;
    }
    const found = folder.environments.find((/** @type {any} */ e) => e.name === state.environment);
    return found || folder.environments.find((/** @type {any} */ e) => !e.isProduction) || folder.environments[0];
  }

  /** @param {any} environment */
  function visibleServices(environment) {
    const needle = state.filter.trim().toLowerCase();
    return environment.services.filter(
      (/** @type {any} */ s) =>
        (s.playbooks.length || s.vaultFile) && (!needle || s.name.toLowerCase().includes(needle)),
    );
  }

  /** @param {any} environment */
  function currentService(environment) {
    const services = visibleServices(environment);
    return services.find((/** @type {any} */ s) => s.name === state.service) || services[0] || null;
  }

  /** @param {any} service */
  function newestRun(service) {
    /** @type {any} */
    let newest = null;
    for (const playbook of service.playbooks) {
      if (playbook.latest && (!newest || playbook.latest.startedAt > newest.startedAt)) {
        newest = playbook.latest;
      }
    }
    return newest;
  }

  /** @param {number} ms */
  function ago(ms) {
    const minutes = Math.floor((Date.now() - ms) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return `${Math.floor(hours / 24)} d ago`;
  }

  /** @param {any} entry */
  function statusView(entry) {
    if (!entry) {
      return h("span", { class: "status" }, "never run");
    }
    const when = ago(entry.endedAt || entry.startedAt);
    const icons = {
      running: ["loading", "codicon-modifier-spin", "running…"],
      passed: ["pass-filled", "", when],
      failed: ["error", "", `failed ${when}`],
      cancelled: ["circle-slash", "", `cancelled ${when}`],
      unknown: ["question", "", `result unknown · ${when}`],
    };
    const [name, extra, text] = icons[/** @type {keyof typeof icons} */ (entry.status)] || icons.unknown;
    return h(
      "span",
      { class: `status ${entry.status}`, title: entry.message || undefined },
      icon(name, extra),
      text,
    );
  }

  // ── Range ──────────────────────────────────────────────────────────────

  /** @param {any} outline */
  function flatTasks(outline) {
    return outline.plays.flatMap((/** @type {any} */ play) => play.tasks);
  }

  /**
   * Indices of the range edges as the plugin will match them: from is the
   * first occurrence, until the first at or after it.
   *
   * @param {any[]} tasks
   */
  function rangeIndices(tasks) {
    const names = tasks.map((t) => t.name);
    const from = state.range.from ? names.indexOf(state.range.from) : 0;
    const until = state.range.until ? names.indexOf(state.range.until, Math.max(from, 0)) : names.length - 1;
    return { from, until, active: Boolean(state.range.from || state.range.until) };
  }

  /** @param {string} playbook */
  function select(playbook) {
    if (state.selected !== playbook) {
      state.selected = playbook;
      state.range = { from: null, until: null };
    }
  }

  /**
   * A click on a row: first click sets the start, the second the end (the
   * earlier of the two becomes the start), a third starts over.
   *
   * @param {string} playbook
   * @param {any[]} tasks
   * @param {number} index
   */
  function clickTask(playbook, tasks, index) {
    select(playbook);
    const name = tasks[index].name;
    const { from } = rangeIndices(tasks);
    if (!state.range.from) {
      state.range = { from: name, until: null };
    } else if (!state.range.until) {
      state.range = index < from ? { from: name, until: state.range.from } : { from: state.range.from, until: name };
    } else {
      state.range = { from: name, until: null };
    }
    changed();
  }

  /** @param {string} playbook @param {string | null} from @param {string | null} until */
  function setRange(playbook, from, until) {
    select(playbook);
    state.range = { from, until };
    changed();
  }

  // ── Options and preview ────────────────────────────────────────────────

  function runOptions() {
    /** @type {Record<string, unknown>} */
    const options = {};
    const o = state.opts;
    if (o.tags.trim()) options.tags = o.tags.trim();
    if (o.limit.trim()) options.limit = o.limit.trim();
    if (o.check) options.check = true;
    if (o.diff) options.diff = true;
    if (o.step) options.step = true;
    if (o.verbosity > 0) options.verbosity = o.verbosity;
    if (state.range.from) options.fromTask = state.range.from;
    if (state.range.until) options.untilTask = state.range.until;
    return options;
  }

  function selectedTarget() {
    const folder = currentFolder();
    const environment = currentEnvironment(folder);
    if (!folder || !environment || !state.selected) {
      return null;
    }
    for (const service of environment.services) {
      const playbook = service.playbooks.find((/** @type {any} */ p) => p.file === state.selected);
      if (playbook) {
        return { folder, environment, service, playbook };
      }
    }
    return null;
  }

  function requestPreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const target = selectedTarget();
      if (!target) {
        preview = null;
        return;
      }
      vscode.postMessage({
        type: "preview",
        folder: target.folder.path,
        environment: target.environment.name,
        playbook: target.playbook.file,
        options: runOptions(),
      });
    }, 150);
  }

  /**
   * Run a playbook of the shown environment straight away -- the extension
   * checks and confirms it like any other run.
   *
   * @param {string} playbook @param {Record<string, unknown>} options
   */
  function postRun(playbook, options) {
    const folder = currentFolder();
    const environment = currentEnvironment(folder);
    if (folder && environment) {
      vscode.postMessage({ type: "run", folder: folder.path, environment: environment.name, playbook, options });
    }
  }

  /** @param {string} tag */
  function toggleTag(tag) {
    const tags = state.opts.tags.split(",").map((t) => t.trim()).filter(Boolean);
    const at = tags.indexOf(tag);
    if (at >= 0) {
      tags.splice(at, 1);
    } else {
      tags.push(tag);
    }
    state.opts.tags = tags.join(",");
    changed();
  }

  function changed() {
    persist();
    render();
    requestPreview();
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  /** Runs | Settings | Inventory */
  function tabs() {
    /** @param {"runs" | "settings" | "inventory"} tab @param {string} name @param {string} label @param {boolean} [unsaved] */
    const tabButton = (tab, name, label, unsaved = false) =>
      h(
        "button",
        {
          role: "tab",
          "aria-selected": String(state.tab === tab),
          "data-key": `tab:${tab}`,
          onclick: () => {
            state.tab = tab;
            changed();
          },
        },
        icon(name),
        label,
        unsaved ? unsavedMark() : null,
      );
    return h(
      "div",
      { class: "segmented", role: "tablist", "aria-label": "View" },
      tabButton("runs", "play-circle", "Runs"),
      tabButton("settings", "settings-gear", "Settings"),
      tabButton("inventory", "server-environment", "Inventory", state.drafts.size > 0),
    );
  }

  // ── Settings tab ───────────────────────────────────────────────────────

  /**
   * Save a setting. Workspace unless the page asks for User; the extension
   * moves a machine setting to User whatever is asked, and validates the value.
   *
   * @param {any} setting @param {unknown} value @param {"workspace" | "user"} [target]
   */
  function saveSetting(setting, value, target) {
    vscode.postMessage({
      type: "setSetting",
      key: setting.key,
      value,
      target: target || (setting.machine ? "user" : "workspace"),
    });
  }

  /** @param {any} setting */
  function sourceOf(setting) {
    if (setting.workspaceValue !== undefined) {
      return "Workspace";
    }
    return setting.userValue !== undefined ? "User" : "default";
  }

  /** @param {any} setting */
  function settingEditor(setting) {
    const key = setting.key;
    if (setting.type === "boolean") {
      return h(
        "label",
        { class: "toggle" },
        h("input", {
          type: "checkbox",
          checked: Boolean(setting.value),
          "data-key": `setting:${key}`,
          onchange: (/** @type {Event} */ e) => saveSetting(setting, /** @type {HTMLInputElement} */ (e.target).checked),
        }),
        setting.value ? "on" : "off",
      );
    }

    if (setting.type === "string") {
      const commit = (/** @type {HTMLInputElement} */ input) => {
        if (input.value !== String(setting.value ?? "") || settingErrors.has(key)) {
          saveSetting(setting, input.value);
        }
      };
      return h("input", {
        type: "text",
        class: "setting-text",
        value: draftOr(`setting:${key}`, String(setting.value ?? "")),
        oninput: keepDraft(`setting:${key}`),
        placeholder: String(setting.defaultValue ?? ""),
        spellcheck: "false",
        "data-key": `setting:${key}`,
        // `change` fires on Enter and on blur alike -- one save either way.
        onchange: (/** @type {Event} */ e) => commit(/** @type {HTMLInputElement} */ (e.target)),
      });
    }

    if (setting.type === "list") {
      const items = Array.isArray(setting.value) ? setting.value : [];
      return h(
        "div",
        { class: "setting-list" },
        items.map((/** @type {string} */ item) =>
          h(
            "span",
            { class: "chip on" },
            item,
            h(
              "button",
              {
                class: "chip-remove",
                title: `Remove ${item}`,
                "aria-label": `Remove ${item}`,
                onclick: () => saveSetting(setting, items.filter((/** @type {string} */ other) => other !== item)),
              },
              icon("close"),
            ),
          ),
        ),
        h("input", {
          type: "text",
          class: "setting-add",
          placeholder: "add…",
          spellcheck: "false",
          "data-key": `setting-add:${key}`,
          value: draftOr(`setting-add:${key}`, ""),
          oninput: keepDraft(`setting-add:${key}`),
          onkeydown: (/** @type {KeyboardEvent} */ e) => {
            const input = /** @type {HTMLInputElement} */ (e.target);
            if (e.key === "Enter" && input.value.trim()) {
              // Kept as a draft until the save comes back: a refused one
              // leaves the text where it was typed.
              saveSetting(setting, [...items, input.value]);
            }
          },
        }),
      );
    }

    // map: environment -> password file
    /** @type {Record<string, string>} */
    const map = setting.value && typeof setting.value === "object" ? setting.value : {};
    /** @type {HTMLInputElement | null} */
    let nameInput = null;
    /** @type {HTMLInputElement | null} */
    let pathInput = null;
    const add = () => {
      if (nameInput && pathInput) {
        saveSetting(setting, { ...map, [nameInput.value]: pathInput.value });
      }
    };
    nameInput = /** @type {HTMLInputElement} */ (
      h("input", {
        type: "text",
        placeholder: "environment",
        spellcheck: "false",
        "data-key": `setting-map-name:${key}`,
        value: draftOr(`setting-map-name:${key}`, ""),
        oninput: keepDraft(`setting-map-name:${key}`),
      })
    );
    pathInput = /** @type {HTMLInputElement} */ (
      h("input", {
        type: "text",
        placeholder: "password file",
        spellcheck: "false",
        "data-key": `setting-map-path:${key}`,
        value: draftOr(`setting-map-path:${key}`, ""),
        oninput: keepDraft(`setting-map-path:${key}`),
        onkeydown: (/** @type {KeyboardEvent} */ e) => e.key === "Enter" && add(),
      })
    );
    return h(
      "div",
      { class: "setting-map" },
      Object.entries(map).map(([name, file]) =>
        h(
          "div",
          { class: "setting-map-row" },
          h("code", null, name),
          icon("arrow-right"),
          h("code", null, file),
          h(
            "button",
            {
              class: "icon-button",
              title: `Remove ${name}`,
              onclick: () => {
                const next = { ...map };
                delete next[name];
                saveSetting(setting, next);
              },
            },
            icon("close"),
          ),
        ),
      ),
      h(
        "div",
        { class: "setting-map-row" },
        nameInput,
        icon("arrow-right"),
        pathInput,
        h("button", { class: "icon-button", title: "Add", onclick: add }, icon("add"), h("span", { class: "label" }, "Add")),
      ),
    );
  }

  /** @param {any} setting */
  function settingRow(setting) {
    const source = sourceOf(setting);
    const error = settingErrors.get(setting.key);
    return h(
      "div",
      { class: `setting-row ${error ? "invalid" : ""}` },
      h(
        "div",
        { class: "setting-head" },
        h("code", { class: "setting-key" }, setting.key),
        h("span", { class: `badge source-${source.toLowerCase()}`, title: "Where the value in effect comes from" }, source),
        setting.machine
          ? h(
              "span",
              { class: "badge machine", title: "Names something that gets executed, so only your User settings may set it" },
              icon("shield"),
              "machine · saved to User",
            )
          : null,
      ),
      h("p", { class: "setting-description" }, setting.description),
      settingEditor(setting),
      error ? h("p", { class: "error" }, icon("error"), error) : null,
      h(
        "div",
        { class: "setting-actions" },
        setting.workspaceValue !== undefined
          ? h(
              "button",
              {
                class: "link",
                onclick: () => vscode.postMessage({ type: "resetSetting", key: setting.key, target: "workspace" }),
              },
              icon("discard"),
              "Reset workspace value",
            )
          : null,
        setting.userValue !== undefined
          ? h(
              "button",
              {
                class: "link",
                onclick: () => vscode.postMessage({ type: "resetSetting", key: setting.key, target: "user" }),
              },
              icon("discard"),
              "Reset user value",
            )
          : null,
        !setting.machine && setting.workspaceValue !== undefined
          ? h(
              "button",
              {
                class: "link",
                title: "Save this value to your User settings, for every workspace, and remove it from this workspace",
                // One message: the extension removes the workspace value only
                // after the User write succeeded.
                onclick: () => vscode.postMessage({ type: "moveSetting", key: setting.key }),
              },
              icon("account"),
              "Move to User settings",
            )
          : null,
      ),
    );
  }

  function settingsPane() {
    /** @type {Map<string, any[]>} */
    const groups = new Map();
    for (const setting of settings) {
      const list = groups.get(setting.group) || [];
      list.push(setting);
      groups.set(setting.group, list);
    }
    return h(
      "section",
      { class: "settings", "data-scroll": "settings" },
      h(
        "p",
        { class: "settings-intro" },
        "Changes are saved to this workspace's .vscode/settings.json; settings marked machine go to your User settings. ",
        h(
          "button",
          { class: "link", onclick: () => vscode.postMessage({ type: "openSettings" }) },
          icon("link-external"),
          "Open in VS Code Settings",
        ),
      ),
      [...groups].flatMap(([title, list]) => [h("h2", { class: "settings-group" }, title), ...list.map(settingRow)]),
    );
  }

  /** @param {any} folder @param {any} environment */
  function topbar(folder, environment) {
    return h(
      "header",
      { class: "topbar" },
      h("h1", null, runnerFigure(), "Playbook Runner"),
      tabs(),
      folderSelect(folder),
      h("span", { class: "spacer" }),
      h(
        "div",
        { class: "toolbar" },
        h(
          "button",
          {
            class: "icon-button",
            title: "Run the last playbook again, with the same options",
            "data-key": "rerun-last",
            onclick: () => vscode.postMessage({ type: "rerunLast" }),
          },
          icon("debug-rerun"),
          h("span", { class: "label" }, "Re-run last"),
        ),
        h(
          "button",
          {
            class: "icon-button",
            title: "Lay out a new service: playbooks/<name>/ and group_vars/<name>/",
            "data-key": "new-service",
            onclick: () => vscode.postMessage({ type: "createService", folder: folder.path }),
          },
          icon("new-folder"),
          h("span", { class: "label" }, "New service…"),
        ),
        h(
          "button",
          {
            class: "icon-button",
            title: `Rotate the passphrase of every vault in ${environment.name}`,
            "data-key": "rekey",
            onclick: () => vscode.postMessage({ type: "rekey", folder: folder.path, environment: environment.name }),
          },
          icon("key"),
          h("span", { class: "label" }, "Rekey vaults"),
        ),
      ),
      h(
        "div",
        { class: "segmented", role: "tablist", "aria-label": "Environment" },
        folder.environments.map((/** @type {any} */ env) =>
          h(
            "button",
            {
              role: "tab",
              class: env.isProduction ? "production" : "",
              "aria-selected": String(env.name === environment.name),
              "data-key": `env:${env.name}`,
              onclick: () => {
                state.environment = env.name;
                changed();
              },
            },
            h("span", { class: `env-dot ${env.isProduction ? "production" : ""}` }),
            env.name,
            state.drafts.has(draftKey(folder, env)) ? unsavedMark() : null,
          ),
        ),
      ),
      h(
        "div",
        { class: "toolbar", "aria-label": "Environments" },
        h(
          "button",
          {
            class: "icon-button",
            title: `Rename the environment ${environment.name}…`,
            "aria-label": `Rename the environment ${environment.name}`,
            "data-key": "rename-environment",
            onclick: () =>
              vscode.postMessage({ type: "renameEnvironment", folder: folder.path, environment: environment.name }),
          },
          icon("edit"),
        ),
        h(
          "button",
          {
            class: "icon-button",
            title: `Delete the environment ${environment.name}… (moved to the trash)`,
            "aria-label": `Delete the environment ${environment.name}`,
            "data-key": "delete-environment",
            onclick: () =>
              vscode.postMessage({ type: "deleteEnvironment", folder: folder.path, environment: environment.name }),
          },
          icon("trash"),
        ),
        h(
          "button",
          {
            class: "icon-button",
            title: "Lay out a new environment: an inventory and group_vars/, optionally with the groups of an existing one",
            "aria-label": "New environment",
            "data-key": "new-environment",
            onclick: () => vscode.postMessage({ type: "createEnvironment", folder: folder.path }),
          },
          icon("add"),
        ),
      ),
    );
  }

  /**
   * What a service row leads with: the result of its newest run, or what kind
   * of service it is when nothing has run yet.
   *
   * @param {any} service @param {any} newest
   */
  function serviceIcon(service, newest) {
    /** @type {Record<string, [string, string, string]>} status -> codicon, modifier, label */
    const byStatus = {
      running: ["loading", "codicon-modifier-spin", "running"],
      passed: ["pass-filled", "", "last run passed"],
      failed: ["error", "", "last run failed"],
      cancelled: ["circle-slash", "", "last run cancelled"],
      unknown: ["question", "", "result of the last run unknown"],
    };
    if (newest) {
      const [name, extra, label] = byStatus[newest.status] || byStatus.unknown;
      return h("span", { class: `service-icon ${newest.status}`, title: label }, icon(name, extra));
    }
    if (!service.playbooks.length) {
      return h("span", { class: "service-icon vars", title: "variables only, no playbooks" }, icon("symbol-variable"));
    }
    return h("span", { class: "service-icon never", title: "never run here" }, icon("circle-large-outline"));
  }

  /** @param {any} environment */
  function servicesPane(environment) {
    const services = visibleServices(environment);
    const current = currentService(environment);
    return h(
      "nav",
      { class: "services", "aria-label": "Services" },
      h("input", {
        type: "text",
        class: "filter",
        placeholder: "Filter services",
        "aria-label": "Filter services",
        "data-key": "filter",
        value: state.filter,
        oninput: (/** @type {Event} */ e) => {
          state.filter = /** @type {HTMLInputElement} */ (e.target).value;
          persist();
          render();
        },
      }),
      h(
        "ul",
        { role: "listbox", "aria-label": "Services", "data-nav": "services" },
        services.length
          ? services.map((/** @type {any} */ service) => {
              const newest = newestRun(service);
              return h(
                "li",
                null,
                h(
                  "button",
                  {
                    class: "service",
                    role: "option",
                    "aria-selected": String(current && service.name === current.name),
                    "data-key": `service:${service.name}`,
                    "data-nav-item": "",
                    onclick: () => {
                      // Tags belong to the service they were picked in;
                      // another service's playbooks rarely have them.
                      if (!current || service.name !== current.name) {
                        state.opts.tags = "";
                      }
                      state.service = service.name;
                      changed();
                    },
                  },
                  serviceIcon(service, newest),
                  h("span", { class: "name" }, service.name),
                  newest
                    ? h("span", { class: "when" }, newest.status === "running" ? "running…" : ago(newest.endedAt || newest.startedAt))
                    : service.playbooks.length > 1
                      ? h("span", { class: "count", title: `${service.playbooks.length} playbooks` }, String(service.playbooks.length))
                      : null,
                ),
              );
            })
          : h("li", { class: "empty" }, "No service matches"),
      ),
    );
  }

  /** @param {any} folder @param {any} environment @param {any} service */
  function detailPane(folder, environment, service) {
    if (!service) {
      return h("section", { class: "detail" }, h("p", { class: "empty" }, "No services here."));
    }
    return h(
      "section",
      { class: "detail", "data-scroll": "detail" },
      h(
        "div",
        { class: "detail-head" },
        h("h2", null, service.name),
        h(
          "span",
          { class: "meta" },
          service.playbooks.length
            ? `${service.playbooks.length} playbook${service.playbooks.length === 1 ? "" : "s"}`
            : "group_vars only",
          service.envFile
            ? h(
                "button",
                {
                  class: "link",
                  "data-key": `env-file:${service.name}`,
                  onclick: () =>
                    vscode.postMessage({ type: "open", folder: folder.path, playbook: "", file: service.envFile, line: 1 }),
                },
                icon("symbol-variable"),
                "env.yml",
              )
            : null,
          service.vaultFile
            ? h(
                "button",
                {
                  class: "link",
                  title: service.hasVault ? "ansible-vault edit, in a terminal of its own" : "ansible-vault create",
                  "data-key": `vault:${service.name}`,
                  onclick: () =>
                    vscode.postMessage({
                      type: "vault",
                      folder: folder.path,
                      environment: environment.name,
                      service: service.name,
                      action: service.hasVault ? "edit" : "create",
                    }),
                },
                icon(service.hasVault ? "lock" : "add"),
                service.hasVault ? "Edit vault" : "Create vault",
              )
            : null,
        ),
      ),
      service.playbooks.length
        ? service.playbooks.map((/** @type {any} */ playbook) => card(folder, environment, playbook))
        : h("p", { class: "empty" }, `No playbooks under playbooks/${service.name}/ — this service only has variables here.`),
    );
  }

  /** @param {any} folder @param {any} environment @param {any} playbook */
  function card(folder, environment, playbook) {
    const open = state.expanded.includes(playbook.file);
    const selected = state.selected === playbook.file;
    return h(
      "article",
      { class: `card ${selected ? "selected" : ""}` },
      h(
        "div",
        { class: "card-headline" },
      h(
        "button",
        {
          class: "card-head",
          "aria-expanded": String(open),
          "data-key": `card:${playbook.file}`,
          onclick: () => {
            select(playbook.file);
            state.expanded = open
              ? state.expanded.filter((f) => f !== playbook.file)
              : [...state.expanded, playbook.file];
            if (!open && !outlines.has(playbook.file)) {
              outlines.set(playbook.file, "loading");
              vscode.postMessage({ type: "outline", folder: folder.path, playbook: playbook.file });
            }
            changed();
          },
        },
        icon(open ? "chevron-down" : "chevron-right"),
        h(
          "span",
          { class: "card-title" },
          h("span", { class: "name" }, playbook.name),
          h("span", { class: "path" }, playbook.label),
        ),
        statusView(playbook.latest),
      ),
        h(
          "button",
          {
            class: "icon-button run-now",
            title: "Run now, no options",
            "aria-label": `Run ${playbook.name} now, no options`,
            "data-key": `run-now:${playbook.file}`,
            onclick: () => postRun(playbook.file, {}),
          },
          icon("play"),
        ),
      ),
      open ? cardBody(folder, playbook) : null,
    );
  }

  /**
   * The playbook's tags in run order: ▶ runs only that tag, a click on the
   * chip adds it to the run bar's --tags.
   *
   * @param {any} folder @param {any} playbook
   */
  function tagsLine(folder, playbook) {
    const tags = playbookTags.get(playbook.file) || [];
    if (!tags.length) {
      return null;
    }
    const marks = tagMarks(folder);
    return h(
      "div",
      { class: "tags-line" },
      h("span", { class: "tags-label" }, "Tags"),
      tags.map((tag) =>
        h(
          "span",
          { class: "tag-pair", title: tag.sources.length ? `from ${tag.sources.join(", ")}` : undefined },
          h(
            "button",
            {
              class: "icon-button",
              title: `Run only --tags ${tag.name}`,
              "aria-label": `Run only tag ${tag.name}`,
              onclick: () => postRun(playbook.file, { tags: tag.name }),
            },
            icon("play"),
          ),
          tagChip(playbook, tag.name, marks),
        ),
      ),
    );
  }

  /** @param {any} folder @param {any} playbook */
  function cardBody(folder, playbook) {
    const outline = outlines.get(playbook.file);
    if (!outline || outline === "loading") {
      return h("div", { class: "card-body" }, h("p", { class: "note" }, "Reading tasks…"));
    }
    const tasks = flatTasks(outline);
    if (!tasks.length) {
      return h(
        "div",
        { class: "card-body" },
        tagsLine(folder, playbook),
        h("p", { class: "note" }, "No named tasks found by the scanner. ▶ and the tags above still run it."),
      );
    }
    const selected = state.selected === playbook.file;
    const range = selected ? rangeIndices(tasks) : { from: -1, until: -1, active: false };
    const marks = tagMarks(folder);
    const setup = marks.setup;
    let index = -1;

    return h(
      "div",
      { class: "card-body", role: "tree", "aria-label": `Tasks of ${playbook.name}`, "data-nav": `tasks:${playbook.file}` },
      tagsLine(folder, playbook),
      outline.strategy
        ? h(
            "p",
            { class: "note warning" },
            icon("warning"),
            ` Task ranges are unavailable: this playbook sets strategy: ${outline.strategy}.`,
          )
        : null,
      outline.plays.flatMap((/** @type {any} */ play) => {
        // Tags every task of the play carries (the play's own, mostly) are
        // shown once on the play, not repeated on each row.
        const common = play.tasks.length
          ? play.tasks
              .map((/** @type {any} */ t) => new Set(t.tags))
              .reduce((/** @type {Set<string>} */ a, /** @type {Set<string>} */ b) => new Set([...a].filter((x) => b.has(x))))
          : new Set();
        return [
        h(
          "div",
          { class: "play-head" },
          play.name,
          h("span", { class: "hosts" }, play.hosts),
          [...common].map((tag) => tagChip(playbook, tag, marks)),
        ),
        ...play.tasks.map((/** @type {any} */ task) => {
          index += 1;
          const at = index;
          const inRange = range.active && at >= range.from && (range.until < 0 || at <= range.until);
          const isSetup = range.active && at < range.from && task.tags.some((/** @type {string} */ t) => setup.has(t));
          const skipped = range.active && !inRange && !isSetup;
          const only = Boolean(state.range.from) && state.range.from === state.range.until;
          const marker =
            selected && only && at === range.from
              ? "only"
              : selected && at === range.from && state.range.from
                ? "from"
                : selected && at === range.until && state.range.until
                  ? "until"
                  : isSetup
                    ? "setup"
                    : "";
          return taskRow(folder, playbook, tasks, task, at, {
            inRange,
            isSetup,
            skipped,
            marker,
            marks,
            canRange: !outline.strategy,
            ownTags: task.tags.filter((/** @type {string} */ t) => !common.has(t)),
          });
        }),
        ];
      }),
      outline.skipped
        ? h("p", { class: "note" }, `+${outline.skipped} unnamed task${outline.skipped === 1 ? "" : "s"} not listed`)
        : null,
    );
  }

  /**
   * What a tag chip is coloured by: the tags in the run bar's --tags, and the
   * folder's setup tags.
   *
   * @typedef {{ active: Set<string>, setup: Set<string> }} TagMarks
   * @param {any} folder
   * @returns {TagMarks}
   */
  function tagMarks(folder) {
    return {
      active: new Set(state.opts.tags.split(",").map((t) => t.trim()).filter(Boolean)),
      setup: new Set(setupTags[folder.path] || []),
    };
  }

  /**
   * A tag that adds itself to --tags when clicked, or removes itself again.
   * Selected tags are filled and ticked; tags that run without being selected
   * (a setup tag before a task range, ansible's own `always`) are yellow.
   *
   * @param {any} playbook @param {string} tag @param {TagMarks} marks
   */
  function tagChip(playbook, tag, marks) {
    const on = marks.active.has(tag);
    const always =
      tag === "always"
        ? "Ansible runs tasks tagged always on every run, whatever --tags says."
        : marks.setup.has(tag)
          ? "Setup tag: its tasks always run before a task range. A plain --tags run only includes it when it is selected."
          : "";
    const action = on ? `Remove ${tag} from --tags` : `Add ${tag} to --tags`;
    return h(
      "button",
      {
        class: `chip ${on ? "on" : ""} ${always ? "always" : ""}`,
        title: always ? `${always}\n${action}` : action,
        "aria-pressed": String(on),
        onclick: (/** @type {Event} */ e) => {
          e.stopPropagation();
          select(playbook.file);
          toggleTag(tag);
        },
      },
      tag,
    );
  }

  /**
   * @param {any} folder @param {any} playbook @param {any[]} tasks @param {any} task @param {number} at
   * @param {{ inRange: boolean, isSetup: boolean, skipped: boolean, marker: string, marks: TagMarks, canRange: boolean, ownTags: string[] }} view
   */
  function taskRow(folder, playbook, tasks, task, at, view) {
    const roleSplit = task.role ? task.name.slice(task.role.length + 3) : task.name;
    const stop = (/** @type {Event} */ e) => e.stopPropagation();
    return h(
      "div",
      {
        class: `row ${view.inRange ? "in-range" : ""} ${view.isSetup ? "setup" : ""} ${view.skipped ? "skipped" : ""}`,
        role: "treeitem",
        tabindex: "0",
        "data-key": `task:${playbook.file}:${at}`,
        "data-nav-item": "",
        title: view.isSetup ? "Runs before the range: it carries a setup tag" : undefined,
        onclick: () => view.canRange && clickTask(playbook.file, tasks, at),
        onkeydown: (/** @type {KeyboardEvent} */ e) => {
          if (e.key === "Enter" && e.target === e.currentTarget && view.canRange) {
            clickTask(playbook.file, tasks, at);
          }
        },
      },
      h("span", { class: "marker" }, view.marker),
      h(
        "span",
        { class: "task-name" },
        task.role ? h("span", { class: "role" }, `${task.role} :`) : null,
        h("span", null, roleSplit),
        view.ownTags.map((tag) => tagChip(playbook, tag, view.marks)),
      ),
      h(
        "span",
        { class: "actions", onclick: stop },
        view.canRange
          ? [
              h(
                "button",
                { class: "icon-button", title: "Only this task", onclick: () => setRange(playbook.file, task.name, task.name) },
                icon("debug-step-into"),
                h("span", { class: "label" }, "only"),
              ),
              h(
                "button",
                { class: "icon-button", title: "From this task", onclick: () => setRange(playbook.file, task.name, state.selected === playbook.file ? state.range.until : null) },
                icon("debug-start"),
                h("span", { class: "label" }, "from"),
              ),
              h(
                "button",
                {
                  class: "icon-button",
                  title: "Until this task",
                  onclick: () =>
                    setRange(playbook.file, state.selected === playbook.file ? state.range.from : null, task.name),
                },
                icon("debug-stop"),
                h("span", { class: "label" }, "until"),
              ),
            ]
          : null,
        h(
          "button",
          {
            class: "icon-button",
            title: "Open in the editor",
            onclick: () =>
              vscode.postMessage({ type: "open", folder: folder.path, playbook: playbook.file, file: task.file, line: task.line }),
          },
          icon("go-to-file"),
        ),
      ),
    );
  }

  /** @param {any} environment */
  function runbar(environment) {
    const target = selectedTarget();
    if (!target) {
      return h(
        "footer",
        { class: "runbar" },
        h("span", { class: "range" }, icon("info"), "Open a playbook to run it, or click its tasks to pick a range."),
      );
    }
    const production = environment.isProduction;
    const o = state.opts;
    const fresh = preview && preview.playbook === target.playbook.file && preview.environment === environment.name;
    const error = fresh && preview ? preview.error : null;

    /** @param {keyof Options} key @param {string} label @param {string} title */
    const toggle = (key, label, title) =>
      h(
        "label",
        { class: "toggle", title },
        h("input", {
          type: "checkbox",
          checked: Boolean(o[key]),
          "data-key": `opt:${key}`,
          onchange: (/** @type {Event} */ e) => {
            /** @type {any} */ (o)[key] = /** @type {HTMLInputElement} */ (e.target).checked;
            changed();
          },
        }),
        label,
      );

    /** @param {"tags" | "limit"} key @param {string} label @param {string} placeholder */
    const text = (key, label, placeholder) =>
      h(
        "label",
        { class: "field" },
        label,
        h("input", {
          type: "text",
          placeholder,
          value: o[key],
          "data-key": `opt:${key}`,
          oninput: (/** @type {Event} */ e) => {
            o[key] = /** @type {HTMLInputElement} */ (e.target).value;
            persist();
            requestPreview();
          },
          onchange: () => render(),
        }),
      );

    const rangeText = state.range.from && state.range.from === state.range.until
      ? [h("span", null, "only "), h("strong", null, state.range.from)]
      : [
          ...(state.range.from ? [h("span", null, "from "), h("strong", null, state.range.from)] : []),
          ...(state.range.until
            ? [h("span", null, state.range.from ? " until " : "until "), h("strong", null, state.range.until)]
            : []),
        ];

    return h(
      "footer",
      { class: `runbar ${production ? "production" : ""}` },
      h(
        "div",
        { class: "runbar-line" },
        h("span", { class: "target" }, target.playbook.label),
        state.range.from || state.range.until
          ? h(
              "span",
              { class: "range" },
              icon("list-filter"),
              rangeText,
              h(
                "button",
                {
                  class: "icon-button",
                  title: "Clear the task range",
                  "data-key": "clear-range",
                  onclick: () => {
                    state.range = { from: null, until: null };
                    changed();
                  },
                },
                icon("close"),
              ),
            )
          : h("span", { class: "range" }, "whole playbook"),
        h("span", { class: "spacer" }),
        text("tags", "tags", "deploy-app,…"),
        text("limit", "limit", "host or group"),
        h(
          "label",
          { class: "field" },
          "verbosity",
          h(
            "select",
            {
              "data-key": "opt:verbosity",
              onchange: (/** @type {Event} */ e) => {
                o.verbosity = Number(/** @type {HTMLSelectElement} */ (e.target).value);
                changed();
              },
            },
            [0, 1, 2, 3, 4].map((n) => h("option", { value: String(n), selected: o.verbosity === n }, n ? `-${"v".repeat(n)}` : "—")),
          ),
        ),
        toggle("check", "check", "--check: dry run"),
        toggle("diff", "diff", "--diff"),
        toggle("step", "step", "--step: confirm each task in the terminal"),
      ),
      h("pre", { class: "preview", "aria-label": "Command line" }, fresh && preview ? `$ ${preview.commandLine}` : "…"),
      h(
        "div",
        { class: "runbar-line" },
        error ? h("span", { class: "error" }, icon("error"), error) : null,
        h("span", { class: "spacer" }),
        h(
          "button",
          {
            class: `run ${production ? "production" : ""}`,
            "data-key": "run",
            disabled: !fresh || Boolean(error),
            onclick: () =>
              vscode.postMessage({
                type: "run",
                folder: target.folder.path,
                environment: environment.name,
                playbook: target.playbook.file,
                options: runOptions(),
              }),
          },
          icon("play"),
          `Run on ${environment.name}`,
        ),
      ),
    );
  }

  // ── Inventory tab ──────────────────────────────────────────────────────
  //
  // The page edits a draft per environment and sends all of it on Save. The
  // checks here are a convenience: the extension rebuilds the message,
  // validates the result again and asks before it writes anything.

  const SSH_FIELDS = [
    "ansible_host",
    "ansible_user",
    "ansible_port",
    "ansible_ssh_private_key_file",
    "ansible_ssh_common_args",
  ];
  const SSH_FIELD_SET = new Set(SSH_FIELDS);
  const PASSWORD_VARS = new Set(["ansible_password", "ansible_ssh_pass", "ansible_become_pass", "ansible_become_password"]);
  const GROUP_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const HOST_NAME = /^[A-Za-z0-9_.\-[\]:]+$/;
  const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

  /** @type {Map<string, string>} draft key -> why the last save was refused */
  const inventoryErrors = new Map();
  /** @type {Set<string>} expanded server groups, by draft key + index */
  const openGroups = new Set();
  /** @type {Set<string>} hosts whose form is open, by draft key + group + index */
  const openHosts = new Set();
  /** @type {string | null} the group whose ⋯ menu is open */
  let openMenu = null;

  /** @param {any} folder @param {any} environment */
  function draftKey(folder, environment) {
    return `${folder.path}\n${environment.name}`;
  }

  /** @returns {HTMLElement} */
  function unsavedMark() {
    return h("span", { class: "unsaved-mark", title: "Unsaved inventory changes", "aria-label": "unsaved changes" }, "●");
  }

  /** Forget drafts of environments the model no longer has. */
  function pruneDrafts() {
    if (!model) {
      return;
    }
    const known = new Set(
      model.folders.flatMap((/** @type {any} */ f) => f.environments.map((/** @type {any} */ e) => draftKey(f, e))),
    );
    let pruned = false;
    for (const key of [...state.drafts.keys()]) {
      if (!known.has(key)) {
        state.drafts.delete(key);
        inventoryErrors.delete(key);
        pruned = true;
      }
    }
    if (pruned) {
      persist();
    }
  }

  /** @param {any} group @returns {Group} */
  function copyGroup(group) {
    return {
      name: String(group.name),
      children: Array.isArray(group.children) ? group.children.map(String) : [],
      hosts: group.hosts.map((/** @type {any} */ host) => ({
        name: String(host.name),
        vars: host.vars.map((/** @type {any} */ v) => /** @type {Var} */ ([String(v[0]), String(v[1])])),
      })),
      vars: group.vars.map((/** @type {any} */ v) => /** @type {Var} */ ([String(v[0]), String(v[1])])),
      readOnly: Boolean(group.readOnly),
      added: false,
    };
  }

  /**
   * @typedef {object} InventoryContext
   * @property {string} key
   * @property {any} folder
   * @property {any} environment
   * @property {any} inventory   the model's view of the file
   * @property {Draft | null} draft
   * @property {boolean} frozen  a draft of a file that has changed since
   * @property {boolean} canEdit
   * @property {Group[]} serverGroups  what is shown: the draft's, or the file's
   * @property {Group[]} services
   */

  /** @param {any} folder @param {any} environment @returns {InventoryContext} */
  function inventoryContext(folder, environment) {
    const key = draftKey(folder, environment);
    const inventory = environment.inventory;
    const draft = state.drafts.get(key) || null;
    // A draft is never moved onto a new hash: it stays, frozen, to copy from.
    const frozen = Boolean(draft && (draft.hash !== inventory.hash || !inventory.editable));
    return {
      key,
      folder,
      environment,
      inventory,
      draft,
      frozen,
      canEdit: Boolean(inventory.editable) && !frozen,
      serverGroups: draft ? draft.serverGroups : inventory.serverGroups,
      services: draft ? draft.services : inventory.services,
    };
  }

  /**
   * Change the draft of the shown environment, making it from the file on the
   * first edit.
   *
   * @param {InventoryContext} ctx @param {(draft: Draft) => void} change
   */
  function mutate(ctx, change) {
    if (!ctx.canEdit) {
      return;
    }
    let draft = state.drafts.get(ctx.key);
    if (!draft) {
      draft = {
        hash: ctx.inventory.hash,
        serverGroups: ctx.inventory.serverGroups.map(copyGroup),
        services: ctx.inventory.services.map(copyGroup),
      };
      state.drafts.set(ctx.key, draft);
    }
    change(draft);
    persist();
    render();
  }

  /** @param {Var[]} vars @param {string} key @param {string} value */
  function setVar(vars, key, value) {
    const at = vars.findIndex((v) => v[0] === key);
    if (!value) {
      if (at >= 0) {
        vars.splice(at, 1);
      }
    } else if (at >= 0) {
      vars[at] = [key, value];
    } else {
      vars.push([key, value]);
    }
  }

  /** @param {Var[]} vars @param {string} key */
  function getVar(vars, key) {
    const found = vars.find((v) => v[0] === key);
    return found ? found[1] : "";
  }

  /** @param {string} file */
  function baseName(file) {
    return String(file).split(/[\\/]/).pop() || String(file);
  }

  /** @param {InventoryContext} ctx @returns {Map<string, number>} */
  function nameCounts(ctx) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    const groups = [...ctx.serverGroups, ...ctx.services];
    for (const group of groups) {
      counts.set(group.name, (counts.get(group.name) || 0) + 1);
    }
    for (const name of ctx.inventory.manualGroups || []) {
      // A read-only entry is the model's view of the manual group itself.
      if (!groups.some((group) => group.readOnly && group.name === name)) {
        counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
    return counts;
  }

  /** @param {string} name @param {Map<string, number>} counts @returns {string | null} */
  function groupNameProblem(name, counts) {
    if (!name) {
      return "Give the group a name.";
    }
    if (!GROUP_NAME.test(name)) {
      return `"${name}" is not a valid group name: letters, digits and _, not starting with a digit.`;
    }
    return (counts.get(name) || 0) > 1 ? `"${name}" is used by another group.` : null;
  }

  /** @param {Group} group @param {number} index @returns {string | null} */
  function hostNameProblem(group, index) {
    const host = group.hosts[index];
    if (!host) {
      return null;
    }
    if (!host.name) {
      return "The host has no name.";
    }
    if (!HOST_NAME.test(host.name)) {
      return `"${host.name}" is not a valid host name.`;
    }
    return group.hosts.findIndex((other) => other.name === host.name) !== index
      ? `${host.name} is listed twice in ${group.name}.`
      : null;
  }

  /** @param {string} key @param {string} groupName @returns {string | null} */
  function varProblem(key, groupName) {
    if (!key) {
      return "A variable has no name.";
    }
    if (PASSWORD_VARS.has(key)) {
      return `${key} is a password: keep it in the vault of ${groupName || "the group"}, not in the inventory.`;
    }
    return VAR_NAME.test(key) ? null : `"${key}" is not a valid variable name.`;
  }

  /** Everything the page would refuse in the draft. @param {InventoryContext} ctx @returns {string[]} */
  function draftProblems(ctx) {
    if (!ctx.draft) {
      return [];
    }
    /** @type {string[]} */
    const problems = [];
    const counts = nameCounts(ctx);
    for (const group of [...ctx.serverGroups, ...ctx.services]) {
      if (group.readOnly) {
        continue;
      }
      const label = group.name || "a new group";
      const invalid = group.added ? groupNameProblem(group.name, counts) : null;
      if (invalid) {
        problems.push(invalid);
      }
      for (const [key] of group.vars) {
        const problem = varProblem(key, group.name);
        if (problem) {
          problems.push(`Group ${label}: ${problem}`);
        }
      }
      group.hosts.forEach((host, index) => {
        const problem = hostNameProblem(group, index);
        if (problem) {
          problems.push(`Group ${label}: ${problem}`);
        }
        for (const [key] of host.vars) {
          const varIssue = varProblem(key, group.name);
          if (varIssue) {
            problems.push(`Host ${host.name || "(no name)"} in ${label}: ${varIssue}`);
          }
        }
      });
    }
    return [...new Set(problems)];
  }

  /** @param {string | null} text */
  function fieldWarning(text) {
    return text ? h("span", { class: "field-warning", role: "alert" }, icon("warning"), text) : null;
  }

  /**
   * A text input bound to the draft. Read-only (not disabled) when editing is
   * off, so a frozen draft's values can still be selected and copied.
   *
   * @param {InventoryContext} ctx
   * @param {{ key: string, value: string, placeholder?: string, label: string, editable: boolean, mono?: boolean, onInput: (draft: Draft, value: string) => void }} spec
   */
  function draftInput(ctx, spec) {
    return h("input", {
      type: "text",
      class: spec.mono === false ? "" : "mono",
      value: spec.value,
      placeholder: spec.placeholder || undefined,
      "aria-label": spec.label,
      spellcheck: "false",
      readonly: !spec.editable,
      "data-key": spec.key,
      oninput: (/** @type {Event} */ e) => {
        const value = /** @type {HTMLInputElement} */ (e.target).value;
        mutate(ctx, (draft) => spec.onInput(draft, value));
      },
    });
  }

  /**
   * @param {InventoryContext} ctx @param {"serverGroups" | "services"} kind @param {number} index
   * @returns {(draft: Draft) => Group | undefined}
   */
  function groupIn(ctx, kind, index) {
    return (draft) => draft[kind][index];
  }

  /**
   * Key/value rows. `skip` hides keys shown elsewhere (the SSH fields); the
   * row indices stay those of the full list.
   *
   * @param {InventoryContext} ctx
   * @param {(draft: Draft) => Var[] | undefined} varsOf
   * @param {Var[]} vars
   * @param {{ editable: boolean, keyBase: string, groupName: string, skip?: Set<string>, title: string }} spec
   */
  function varsEditor(ctx, varsOf, vars, spec) {
    const rows = vars.map(([key, value], index) =>
      spec.skip && spec.skip.has(key)
        ? null
        : h(
            "div",
            { class: "var-row" },
            draftInput(ctx, {
              key: `${spec.keyBase}:k:${index}`,
              value: key,
              placeholder: "name",
              label: "Variable name",
              editable: spec.editable,
              onInput: (draft, text) => {
                const entry = (varsOf(draft) || [])[index];
                if (entry) {
                  entry[0] = text;
                }
              },
            }),
            h("span", { class: "muted" }, "="),
            draftInput(ctx, {
              key: `${spec.keyBase}:v:${index}`,
              value,
              placeholder: "value",
              label: `Value of ${key || "the variable"}`,
              editable: spec.editable,
              onInput: (draft, text) => {
                const entry = (varsOf(draft) || [])[index];
                if (entry) {
                  entry[1] = text;
                }
              },
            }),
            spec.editable
              ? h(
                  "button",
                  {
                    class: "icon-button",
                    title: `Remove ${key || "this variable"}`,
                    "aria-label": `Remove ${key || "this variable"}`,
                    onclick: () => mutate(ctx, (draft) => (varsOf(draft) || []).splice(index, 1)),
                  },
                  icon("close"),
                )
              : null,
            fieldWarning(varProblem(key, spec.groupName)),
          ),
    );
    const shown = rows.filter(Boolean);
    return h(
      "div",
      { class: "vars-editor" },
      h("div", { class: "sub-head" }, spec.title),
      shown.length ? shown : h("p", { class: "note" }, "None."),
      spec.editable
        ? h(
            "button",
            {
              class: "link",
              "data-key": `${spec.keyBase}:add`,
              onclick: () => mutate(ctx, (draft) => (varsOf(draft) || []).push(["", ""])),
            },
            icon("add"),
            "Variable",
          )
        : null,
    );
  }

  /**
   * The Vault button of a group: only when a playbook-folder service of the
   * same name has a place for a vault.
   *
   * @param {InventoryContext} ctx @param {string} name
   */
  function vaultButton(ctx, name) {
    const service = ctx.environment.services.find((/** @type {any} */ s) => s.name === name && s.vaultFile);
    if (!service) {
      return null;
    }
    return h(
      "button",
      {
        class: "icon-button",
        title: service.hasVault
          ? `ansible-vault edit ${name}'s vault — the place for passwords`
          : `ansible-vault create ${name}'s vault — the place for passwords`,
        "data-key": `inv-vault:${name}`,
        onclick: () =>
          vscode.postMessage({
            type: "vault",
            folder: ctx.folder.path,
            environment: ctx.environment.name,
            service: name,
            action: service.hasVault ? "edit" : "create",
          }),
      },
      icon(service.hasVault ? "lock" : "add"),
      h("span", { class: "label" }, "Vault"),
    );
  }

  /**
   * ⋯ with Rename…/Delete… for a group that is in the file, or ✕ for one
   * added in the draft. Renaming and deleting go through the extension, which
   * asks and writes at once -- so not over an unsaved draft.
   *
   * @param {InventoryContext} ctx @param {"serverGroups" | "services"} kind @param {number} index @param {Group} group
   */
  function groupMenu(ctx, kind, index, group) {
    if (group.readOnly) {
      return null;
    }
    if (group.added) {
      return h(
        "button",
        {
          class: "icon-button",
          title: "Remove this new group",
          "aria-label": "Remove this new group",
          disabled: !ctx.canEdit,
          onclick: () =>
            mutate(ctx, (draft) => {
              const [removed] = draft[kind].splice(index, 1);
              if (removed && removed.name) {
                for (const service of draft.services) {
                  service.children = service.children.filter((child) => child !== removed.name);
                }
              }
              openGroups.delete(`${ctx.key}\n${kind}\n${index}`);
            }),
        },
        icon("close"),
      );
    }
    const menuKey = `${ctx.key}\n${kind}\n${group.name}`;
    const blocked = Boolean(ctx.draft);
    const open = openMenu === menuKey && !blocked;
    /** @param {"renameGroup" | "deleteGroup"} type */
    const send = (type) => {
      openMenu = null;
      vscode.postMessage({
        type,
        folder: ctx.folder.path,
        environment: ctx.environment.name,
        hash: ctx.inventory.hash,
        group: group.name,
      });
      render();
    };
    return h(
      "span",
      { class: "group-menu" },
      h(
        "button",
        {
          class: "icon-button",
          title: blocked ? "Save or discard first" : `Rename or delete ${group.name}`,
          "aria-label": blocked ? `Rename or delete ${group.name}: save or discard first` : `Rename or delete ${group.name}`,
          "aria-expanded": String(open),
          "data-key": `inv-menu:${kind}:${group.name}`,
          disabled: blocked,
          onclick: () => {
            openMenu = open ? null : menuKey;
            render();
          },
        },
        icon("ellipsis"),
      ),
      open
        ? h(
            "span",
            { class: "menu", role: "menu" },
            h("button", { class: "link", role: "menuitem", onclick: () => send("renameGroup") }, icon("edit"), "Rename…"),
            h("button", { class: "link", role: "menuitem", onclick: () => send("deleteGroup") }, icon("trash"), "Delete…"),
          )
        : null,
    );
  }

  /**
   * The name of a group: text, or an input for a group added in the draft.
   * Renaming an added group carries the services' children along.
   *
   * @param {InventoryContext} ctx @param {"serverGroups" | "services"} kind @param {number} index @param {Group} group @param {Map<string, number>} counts
   */
  function groupName(ctx, kind, index, group, counts) {
    if (!group.added) {
      return h("code", { class: "group-name" }, group.name);
    }
    return h(
      "span",
      { class: "group-name-edit" },
      draftInput(ctx, {
        key: `inv:${kind}:${index}:name`,
        value: group.name,
        placeholder: kind === "services" ? "service name" : "group name",
        label: kind === "services" ? "Name of the new service" : "Name of the new server group",
        editable: ctx.canEdit,
        onInput: (draft, text) => {
          const target = draft[kind][index];
          if (!target) {
            return;
          }
          const before = target.name;
          target.name = text;
          if (before) {
            for (const service of draft.services) {
              service.children = service.children.map((child) => (child === before ? text : child));
            }
          }
        },
      }),
      fieldWarning(groupNameProblem(group.name, counts)),
    );
  }

  const READ_ONLY_HINT = "part of a manual group — move it into the block to keep comments";

  /** @param {InventoryContext} ctx */
  function servicesSection(ctx) {
    const counts = nameCounts(ctx);
    const manualGroups = /** @type {string[]} */ (ctx.inventory.manualGroups || []);
    const taken = new Set([...ctx.serverGroups, ...ctx.services].map((g) => g.name));
    const unlisted = /** @type {string[]} */ (ctx.inventory.unlisted || []).filter((name) => !taken.has(name));

    const rows = ctx.services.map((service, index) => {
      const editable = ctx.canEdit && !service.readOnly;
      const choices = [
        ...new Set([
          ...ctx.serverGroups.map((g) => g.name),
          ...ctx.services.filter((_, other) => other !== index).map((g) => g.name),
          ...manualGroups,
          // A child that is no group any more stays visible, to be unticked.
          ...service.children,
        ]),
      ].filter((name) => name && name !== service.name);
      const members = service.children;
      return h(
        "div",
        { class: `inv-row service-row ${service.readOnly ? "read-only" : ""}` },
        h(
          "div",
          { class: "inv-row-head" },
          groupName(ctx, "services", index, service, counts),
          h("span", { class: "spacer" }),
          vaultButton(ctx, service.name),
          groupMenu(ctx, "services", index, service),
        ),
        h(
          "div",
          { class: "children", role: "group", "aria-label": `Groups in ${service.name || "the new service"}` },
          choices.length
            ? choices.map((choice) =>
                h(
                  "label",
                  { class: `child ${members.includes(choice) ? "on" : ""}` },
                  h("input", {
                    type: "checkbox",
                    checked: members.includes(choice),
                    disabled: !editable,
                    "data-key": `inv:services:${index}:child:${choice}`,
                    onchange: (/** @type {Event} */ e) => {
                      const on = /** @type {HTMLInputElement} */ (e.target).checked;
                      mutate(ctx, (draft) => {
                        const target = draft.services[index];
                        if (!target) {
                          return;
                        }
                        target.children = on
                          ? [...target.children.filter((c) => c !== choice), choice]
                          : target.children.filter((c) => c !== choice);
                      });
                    },
                  }),
                  choice,
                ),
              )
            : h("span", { class: "note" }, "No groups to choose from yet."),
        ),
        service.hosts.length || service.vars.length
          ? h(
              "p",
              { class: "note" },
              [
                service.hosts.length ? `${service.hosts.length} host${service.hosts.length === 1 ? "" : "s"}` : "",
                service.vars.length ? `${service.vars.length} variable${service.vars.length === 1 ? "" : "s"}` : "",
              ]
                .filter(Boolean)
                .join(" and "),
              " of its own — kept as they are; edit them in the file.",
            )
          : null,
        service.readOnly ? h("p", { class: "note" }, icon("lock"), ` ${READ_ONLY_HINT}`) : null,
      );
    });

    return h(
      "section",
      { class: "inv-section" },
      h(
        "div",
        { class: "inv-section-head" },
        h("h2", null, "Services (access control)"),
        h("span", { class: "spacer" }),
        ctx.canEdit
          ? h(
              "button",
              {
                class: "icon-button",
                "data-key": "inv-add-service",
                onclick: () =>
                  mutate(ctx, (draft) => {
                    draft.services.push({ name: "", children: [], hosts: [], vars: [], readOnly: false, added: true });
                  }),
              },
              icon("add"),
              h("span", { class: "label" }, "Service"),
            )
          : null,
      ),
      rows.length ? rows : h("p", { class: "note" }, "No services in the inventory yet."),
      unlisted.map((name) =>
        h(
          "div",
          { class: "inv-row unlisted" },
          h("code", { class: "group-name" }, name),
          h("span", { class: "note" }, "not in inventory —"),
          h(
            "button",
            {
              class: "link",
              disabled: !ctx.canEdit,
              "data-key": `inv-unlisted:${name}`,
              onclick: () =>
                mutate(ctx, (draft) => {
                  draft.services.push({ name, children: [], hosts: [], vars: [], readOnly: false, added: true });
                }),
            },
            icon("add"),
            "Add",
          ),
        ),
      ),
    );
  }

  /**
   * One host: a summary line, and the form when it is open.
   *
   * @param {InventoryContext} ctx @param {number} groupIndex @param {Group} group @param {number} index @param {boolean} editable
   */
  function hostView(ctx, groupIndex, group, index, editable) {
    const host = /** @type {Host} */ (group.hosts[index]);
    const formKey = `${ctx.key}\nserverGroups\n${groupIndex}\n${index}`;
    const open = openHosts.has(formKey);
    const keyBase = `inv:serverGroups:${groupIndex}:host:${index}`;
    const hostOf = (/** @type {Draft} */ draft) => {
      const target = draft.serverGroups[groupIndex];
      return target ? target.hosts[index] : undefined;
    };
    const first = group.hosts[0];
    const user = getVar(host.vars, "ansible_user");
    const key = getVar(host.vars, "ansible_ssh_private_key_file");
    const problem = hostNameProblem(group, index);
    const varIssue = host.vars.some(([k]) => varProblem(k, group.name));

    const summary = h(
      "div",
      { class: `host-line ${problem || varIssue ? "invalid" : ""}` },
      h("code", { class: "host-name" }, host.name || "(no name)"),
      h("span", { class: "muted" }, getVar(host.vars, "ansible_host")),
      user ? h("span", { class: "muted" }, `user ${user}`) : null,
      key ? h("span", { class: "muted" }, `key ${key}`) : null,
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: "icon-button",
          title: open ? "Close the form" : editable ? `Edit ${host.name}` : `Show ${host.name}`,
          "aria-expanded": String(open),
          "data-key": `${keyBase}:toggle`,
          onclick: () => {
            if (open) {
              openHosts.delete(formKey);
            } else {
              openHosts.add(formKey);
            }
            render();
          },
        },
        icon(open ? "chevron-up" : "edit"),
      ),
      editable
        ? h(
            "button",
            {
              class: "icon-button",
              title: `Remove ${host.name || "this host"} from ${group.name}`,
              "aria-label": `Remove ${host.name || "this host"}`,
              onclick: () =>
                mutate(ctx, (draft) => {
                  const target = draft.serverGroups[groupIndex];
                  if (target) {
                    target.hosts.splice(index, 1);
                  }
                  // The open forms are by index; the ones after it moved.
                  for (const other of [...openHosts]) {
                    if (other.startsWith(`${ctx.key}\nserverGroups\n${groupIndex}\n`)) {
                      openHosts.delete(other);
                    }
                  }
                }),
            },
            icon("close"),
          )
        : null,
    );
    if (!open) {
      return h("div", { class: "host" }, summary);
    }
    return h(
      "div",
      { class: "host open" },
      summary,
      h(
        "div",
        { class: "host-form" },
        h(
          "label",
          { class: "form-field" },
          h("span", { class: "form-label" }, "name"),
          draftInput(ctx, {
            key: `${keyBase}:name`,
            value: host.name,
            placeholder: "inventory hostname",
            label: "Host name",
            editable,
            onInput: (draft, text) => {
              const target = hostOf(draft);
              if (target) {
                target.name = text;
              }
            },
          }),
          fieldWarning(problem),
        ),
        SSH_FIELDS.map((field) =>
          h(
            "label",
            { class: "form-field" },
            h("span", { class: "form-label" }, field),
            draftInput(ctx, {
              key: `${keyBase}:ssh:${field}`,
              value: getVar(host.vars, field),
              placeholder: first ? getVar(first.vars, field) : "",
              label: field,
              editable,
              onInput: (draft, text) => {
                const target = hostOf(draft);
                if (target) {
                  setVar(target.vars, field, text);
                }
              },
            }),
          ),
        ),
        varsEditor(
          ctx,
          (draft) => {
            const target = hostOf(draft);
            return target ? target.vars : undefined;
          },
          host.vars,
          { editable, keyBase: `${keyBase}:var`, groupName: group.name, skip: SSH_FIELD_SET, title: "Other variables" },
        ),
      ),
    );
  }

  /** @param {InventoryContext} ctx */
  function serverGroupsSection(ctx) {
    const counts = nameCounts(ctx);
    const groups = ctx.serverGroups.map((group, index) => {
      const openKey = `${ctx.key}\nserverGroups\n${index}`;
      const open = openGroups.has(openKey);
      const editable = ctx.canEdit && !group.readOnly;
      const hostCount = `${group.hosts.length} host${group.hosts.length === 1 ? "" : "s"}`;
      return h(
        "div",
        { class: `inv-group ${group.readOnly ? "read-only" : ""}` },
        h(
          "div",
          { class: "inv-row-head" },
          h(
            "button",
            {
              class: "group-toggle",
              "aria-expanded": String(open),
              "aria-label": `${open ? "Collapse" : "Expand"} ${group.name || "the new group"}`,
              "data-key": `inv:serverGroups:${index}:toggle`,
              onclick: () => {
                if (open) {
                  openGroups.delete(openKey);
                } else {
                  openGroups.add(openKey);
                }
                render();
              },
            },
            icon(open ? "chevron-down" : "chevron-right"),
          ),
          groupName(ctx, "serverGroups", index, group, counts),
          h("span", { class: "muted" }, hostCount),
          group.readOnly ? h("span", { class: "badge" }, icon("lock"), "read-only") : null,
          h("span", { class: "spacer" }),
          vaultButton(ctx, group.name),
          groupMenu(ctx, "serverGroups", index, group),
        ),
        group.readOnly ? h("p", { class: "note" }, READ_ONLY_HINT) : null,
        open
          ? h(
              "div",
              { class: "inv-group-body" },
              group.hosts.length
                ? group.hosts.map((_, hostIndex) => hostView(ctx, index, group, hostIndex, editable))
                : h("p", { class: "note" }, "No hosts."),
              editable
                ? h(
                    "button",
                    {
                      class: "link",
                      "data-key": `inv:serverGroups:${index}:add-host`,
                      onclick: () =>
                        mutate(ctx, (draft) => {
                          const target = draft.serverGroups[index];
                          if (target) {
                            target.hosts.push({ name: "", vars: [] });
                            openHosts.add(`${ctx.key}\nserverGroups\n${index}\n${target.hosts.length - 1}`);
                          }
                        }),
                    },
                    icon("add"),
                    "Host",
                  )
                : null,
              varsEditor(
                ctx,
                (draft) => {
                  const target = groupIn(ctx, "serverGroups", index)(draft);
                  return target ? target.vars : undefined;
                },
                group.vars,
                { editable, keyBase: `inv:serverGroups:${index}:var`, groupName: group.name, title: "Group variables" },
              ),
            )
          : null,
      );
    });

    return h(
      "section",
      { class: "inv-section" },
      h(
        "div",
        { class: "inv-section-head" },
        h("h2", null, "Server groups"),
        ctx.draft && !ctx.frozen ? h("span", { class: "note" }, "Rename and delete: save or discard first.") : null,
        h("span", { class: "spacer" }),
        ctx.canEdit
          ? h(
              "button",
              {
                class: "icon-button",
                "data-key": "inv-add-server-group",
                onclick: () =>
                  mutate(ctx, (draft) => {
                    draft.serverGroups.push({ name: "", children: [], hosts: [], vars: [], readOnly: false, added: true });
                    openGroups.add(`${ctx.key}\nserverGroups\n${draft.serverGroups.length - 1}`);
                  }),
              },
              icon("add"),
              h("span", { class: "label" }, "Server group"),
            )
          : null,
      ),
      groups.length ? groups : h("p", { class: "note" }, "No server groups in the inventory yet."),
    );
  }

  /** @param {InventoryContext} ctx */
  function manualSection(ctx) {
    const blocks = /** @type {{ line: number, preview: string }[]} */ (ctx.inventory.manual || []);
    if (!blocks.length) {
      return null;
    }
    return h(
      "section",
      { class: "inv-section" },
      h("div", { class: "inv-section-head" }, h("h2", null, "Manual sections")),
      blocks.map((block) =>
        h(
          "div",
          { class: "inv-row manual" },
          h("span", { class: "muted" }, `line ${block.line}`),
          h("code", { class: "manual-preview" }, block.preview || "(empty)"),
          h("span", { class: "badge" }, icon("lock"), "read-only"),
          h("span", { class: "spacer" }),
          h(
            "button",
            {
              class: "link",
              "data-key": `inv-open:${block.line}`,
              onclick: () =>
                vscode.postMessage({
                  type: "openInventory",
                  folder: ctx.folder.path,
                  environment: ctx.environment.name,
                  line: block.line,
                }),
            },
            icon("go-to-file"),
            "Open in editor",
          ),
        ),
      ),
    );
  }

  /** Directories of the folder that could get an inventory. @param {any} folder */
  function candidatesNote(folder) {
    const candidates = /** @type {{ name: string, dir: string }[]} */ (folder.candidates || []);
    if (!candidates.length) {
      return null;
    }
    return h(
      "div",
      { class: "candidates" },
      candidates.map((candidate) =>
        h(
          "div",
          { class: "inv-row candidate" },
          icon("info"),
          h("span", null, h("code", null, candidate.name), " has no inventory file"),
          h(
            "button",
            {
              class: "link",
              title: candidate.dir,
              "data-key": `inv-create:${candidate.name}`,
              onclick: () => vscode.postMessage({ type: "createInventory", folder: folder.path, candidate: candidate.name }),
            },
            icon("add"),
            "Create inventory",
          ),
        ),
      ),
    );
  }

  /** @param {InventoryContext} ctx */
  function inventoryPane(ctx) {
    const file = baseName(ctx.environment.inventoryFile);
    const showGroups = ctx.inventory.editable || ctx.draft;
    return h(
      "section",
      { class: "inventory", "data-scroll": "inventory" },
      candidatesNote(ctx.folder),
      h(
        "p",
        { class: "inventory-file" },
        icon("file"),
        h("code", null, file),
        h(
          "button",
          {
            class: "link",
            title: ctx.environment.inventoryFile,
            "data-key": "inv-open-file",
            onclick: () =>
              vscode.postMessage({ type: "openInventory", folder: ctx.folder.path, environment: ctx.environment.name, line: 1 }),
          },
          icon("go-to-file"),
          "Open in editor",
        ),
      ),
      ctx.frozen
        ? h(
            "div",
            { class: "inv-banner", role: "status" },
            icon("warning"),
            h("strong", null, `${file} changed on disk`),
            " — your edits are kept to copy from, but cannot be saved over the new file. Discard loads it.",
          )
        : null,
      !ctx.inventory.editable
        ? h("p", { class: "note warning" }, icon("info"), ` ${ctx.inventory.reason || "This inventory cannot be edited here."}`)
        : null,
      showGroups ? [servicesSection(ctx), serverGroupsSection(ctx), manualSection(ctx)] : null,
    );
  }

  /** @param {InventoryContext} ctx */
  function saveBar(ctx) {
    const problems = draftProblems(ctx);
    const warnings = /** @type {string[]} */ (ctx.inventory.warnings || []);
    const error = inventoryErrors.get(ctx.key);
    const canSave = Boolean(ctx.draft) && ctx.canEdit && !problems.length;
    return h(
      "footer",
      { class: `runbar savebar ${ctx.environment.isProduction ? "production" : ""}` },
      warnings.length || problems.length
        ? h(
            "ul",
            { class: "inv-warnings" },
            warnings.map((text) => h("li", null, icon("warning"), text)),
            problems.map((text) => h("li", { class: "problem" }, icon("error"), text)),
          )
        : null,
      h(
        "div",
        { class: "runbar-line" },
        error ? h("span", { class: "error" }, icon("error"), error) : null,
        h("span", { class: "spacer" }),
        ctx.draft ? h("span", { class: "unsaved" }, unsavedMark(), " unsaved changes") : null,
        h(
          "button",
          {
            class: "icon-button",
            "data-key": "inv-discard",
            disabled: !ctx.draft,
            title: ctx.frozen ? `Drop the edits and load ${baseName(ctx.environment.inventoryFile)} as it is now` : "Drop the edits",
            onclick: () => {
              state.drafts.delete(ctx.key);
              inventoryErrors.delete(ctx.key);
              openMenu = null;
              persist();
              render();
            },
          },
          icon("discard"),
          h("span", { class: "label" }, "Discard"),
        ),
        h(
          "button",
          {
            class: `run ${ctx.environment.isProduction ? "production" : ""}`,
            "data-key": "inv-save",
            disabled: !canSave,
            title: problems.length ? "Fix the problems listed above first" : undefined,
            onclick: () => {
              const draft = ctx.draft;
              if (!draft) {
                return;
              }
              inventoryErrors.delete(ctx.key);
              // Read-only groups are taken from the file by the extension.
              const plain = (/** @type {Group} */ g) => ({
                name: g.name,
                hosts: g.hosts.map((host) => ({ name: host.name, vars: host.vars.map((v) => [v[0], v[1]]) })),
                vars: g.vars.map((v) => [v[0], v[1]]),
              });
              vscode.postMessage({
                type: "saveInventory",
                folder: ctx.folder.path,
                environment: ctx.environment.name,
                hash: draft.hash,
                serverGroups: draft.serverGroups.filter((g) => !g.readOnly).map(plain),
                services: draft.services
                  .filter((g) => !g.readOnly)
                  .map((g) => ({ ...plain(g), children: [...g.children] })),
              });
              render();
            },
          },
          icon("save"),
          `Save ${ctx.environment.name}`,
        ),
      ),
    );
  }

  function render() {
    const active = /** @type {HTMLElement | null} */ (document.activeElement);
    const focusKey = active && active.dataset ? active.dataset.key : undefined;
    const caret = active instanceof HTMLInputElement && active.type === "text" ? active.selectionStart : null;
    /** @type {Record<string, number>} */
    const scroll = {};
    for (const el of document.querySelectorAll("[data-scroll], .services ul")) {
      scroll[/** @type {HTMLElement} */ (el).dataset.scroll || "services"] = el.scrollTop;
    }

    app.replaceChildren(...view());

    for (const el of document.querySelectorAll("[data-scroll], .services ul")) {
      const key = /** @type {HTMLElement} */ (el).dataset.scroll || "services";
      if (scroll[key] !== undefined) {
        el.scrollTop = scroll[key];
      }
    }
    if (focusKey) {
      const target = /** @type {HTMLElement | null} */ (document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`));
      if (target) {
        target.focus();
        if (target instanceof HTMLInputElement && caret !== null) {
          target.setSelectionRange(caret, caret);
        }
      }
    }
  }

  /** @returns {HTMLElement[]} */
  function view() {
    if (!model) {
      return [h("p", { class: "loading" }, "Loading…")];
    }
    if (state.tab === "settings") {
      // Reachable whatever the folder looks like: a wrong inventoriesDir is
      // exactly when the settings are needed.
      return [
        h("header", { class: "topbar" }, h("h1", null, runnerFigure(), "Playbook Runner"), tabs()),
        h("div"),
        settingsPane(),
        h("div"),
      ];
    }
    const folder = currentFolder();
    if (!folder) {
      return [h("p", { class: "empty" }, "Open a folder with playbooks to see them.")];
    }
    const environment = currentEnvironment(folder);
    if (!environment) {
      return [
        h(
          "div",
          { class: "empty-state" },
          folderSelect(folder),
          h("h2", null, icon("search"), ` No Ansible environments found in ${folder.name}`),
          h(
            "p",
            null,
            "Playbook Runner looks for an inventory file (playbookRunner.inventoryFile) in each directory under playbookRunner.inventoriesDir.",
          ),
          h(
            "div",
            { class: "runbar-line" },
            h(
              "button",
              { class: "run", onclick: () => vscode.postMessage({ type: "getStarted", folder: folder.path }) },
              icon("rocket"),
              "Get started…",
            ),
            h(
              "button",
              {
                class: "icon-button",
                onclick: () => {
                  state.tab = "settings";
                  changed();
                },
              },
              icon("settings-gear"),
              "Open Settings",
            ),
            h(
              "button",
              { class: "icon-button", onclick: () => vscode.postMessage({ type: "createEnvironment", folder: folder.path }) },
              icon("add"),
              h("span", { class: "label" }, "New environment…"),
            ),
            h(
              "button",
              { class: "icon-button", onclick: () => vscode.postMessage({ type: "createService", folder: folder.path }) },
              icon("new-folder"),
              h("span", { class: "label" }, "New service…"),
            ),
          ),
          candidatesNote(folder),
        ),
      ];
    }
    const banner = environment.isProduction
      ? h("div", { class: "banner", role: "status" }, icon("warning"), h("strong", null, "production"), " — runs here ask for confirmation before they start.")
      : h("div");
    if (state.tab === "inventory") {
      const ctx = inventoryContext(folder, environment);
      return [topbar(folder, environment), banner, inventoryPane(ctx), saveBar(ctx)];
    }
    const service = currentService(environment);
    return [
      topbar(folder, environment),
      banner,
      h("main", { class: "layout" }, servicesPane(environment), detailPane(folder, environment, service)),
      runbar(environment),
    ];
  }

  // ── Keyboard: arrows move through a list ──────────────────────────────

  document.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") {
      return;
    }
    const current = /** @type {HTMLElement | null} */ (document.activeElement);
    const container = current && current.closest("[data-nav]");
    if (!current || !container || !current.hasAttribute("data-nav-item")) {
      return;
    }
    const items = /** @type {HTMLElement[]} */ ([...container.querySelectorAll("[data-nav-item]")]);
    const at = items.indexOf(current);
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : at + (event.key === "ArrowDown" ? 1 : -1);
    const target = items[Math.max(0, Math.min(items.length - 1, next))];
    if (target) {
      event.preventDefault();
      target.focus();
    }
  });

  // ── Messages from the extension ───────────────────────────────────────

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.type === "model") {
      model = message.model;
      setupTags = message.setupTags || {};
      settings = Array.isArray(message.settings) ? message.settings : [];
      pruneDrafts();
      render();
      requestPreview();
      // Outlines are re-read on a model refresh: a file changed on disk is
      // what triggers one.
      for (const file of state.expanded) {
        const folder = currentFolder();
        if (folder) {
          vscode.postMessage({ type: "outline", folder: folder.path, playbook: file });
        }
      }
    } else if (message.type === "outline") {
      outlines.set(message.playbook, message.outline);
      playbookTags.set(message.playbook, Array.isArray(message.tags) ? message.tags : []);
      render();
    } else if (message.type === "preview") {
      preview = message;
      render();
    } else if (message.type === "inventoryResult") {
      if (typeof message.folder !== "string" || typeof message.environment !== "string") {
        return;
      }
      const key = `${message.folder}\n${message.environment}`;
      if (message.error === null) {
        // Saved, or nothing to save: the file on disk is the truth again.
        state.drafts.delete(key);
        inventoryErrors.delete(key);
        persist();
      } else if (typeof message.error === "string") {
        inventoryErrors.set(key, message.error);
      }
      render();
    } else if (message.type === "settingResult") {
      if (message.error) {
        settingErrors.set(message.key, message.error);
      } else {
        settingErrors.delete(message.key);
        dropDrafts(message.key);
      }
      render();
    }
  });

  // The relative times go stale; a minute is as fine as they get.
  // The Settings tab shows no times, and a render there is only a chance to
  // disturb someone typing.
  setInterval(() => model && state.tab === "runs" && render(), 60000);

  vscode.postMessage({ type: "ready" });
})();
