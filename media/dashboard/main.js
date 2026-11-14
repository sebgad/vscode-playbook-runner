/*
 * Playbook Runner dashboard -- the page side.
 *
 * It renders what the extension sends (the model, one outline per expanded
 * playbook, the command-line preview) and asks for things by message. It
 * decides nothing that reaches ansible: the extension rebuilds every message
 * and runs through the same path the sidebar uses. The command line shown at
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

  const saved = /** @type {Record<string, any>} */ (vscode.getState() || {});
  const state = {
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
  /** @type {Record<string, string[]>} */
  let setupTags = {};
  /** @type {Map<string, any>} playbook file -> outline, or "loading" */
  const outlines = new Map();
  /** @type {{ playbook: string, environment: string, commandLine: string, error: string | null } | null} */
  let preview = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let previewTimer;

  const app = /** @type {HTMLElement} */ (document.getElementById("app"));

  function persist() {
    vscode.setState({
      folder: state.folder,
      environment: state.environment,
      service: state.service,
      filter: state.filter,
      expanded: state.expanded,
      selected: state.selected,
      range: state.range,
      opts: state.opts,
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

  /** @param {string} name @param {string} [extra] */
  function icon(name, extra = "") {
    return h("span", { class: `codicon codicon-${name} ${extra}`, "aria-hidden": "true" });
  }

  // ── Model lookups ──────────────────────────────────────────────────────

  function currentFolder() {
    if (!model || !model.folders.length) {
      return null;
    }
    return model.folders.find((/** @type {any} */ f) => f.path === state.folder) || model.folders[0];
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
      (/** @type {any} */ s) => s.playbooks.length && (!needle || s.name.toLowerCase().includes(needle)),
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

  /** @param {any} folder @param {any} environment */
  function topbar(folder, environment) {
    return h(
      "header",
      { class: "topbar" },
      h("h1", null, icon("run-all"), "Playbook Runner"),
      model.folders.length > 1
        ? h(
            "select",
            {
              "aria-label": "Workspace folder",
              "data-key": "folder",
              onchange: (/** @type {Event} */ e) => {
                state.folder = /** @type {HTMLSelectElement} */ (e.target).value;
                changed();
              },
            },
            model.folders.map((/** @type {any} */ f) =>
              h("option", { value: f.path, selected: f.path === folder.path }, f.name),
            ),
          )
        : null,
      h("span", { class: "spacer" }),
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
          ),
        ),
      ),
    );
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
                      state.service = service.name;
                      changed();
                    },
                  },
                  h("span", { class: `dot ${newest ? newest.status : ""}`, title: newest ? newest.status : "never run" }),
                  h("span", { class: "name" }, service.name),
                  h("span", { class: "when" }, newest ? ago(newest.endedAt || newest.startedAt) : ""),
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
      return h("section", { class: "detail" }, h("p", { class: "empty" }, "No services with playbooks here."));
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
          `${service.playbooks.length} playbook${service.playbooks.length === 1 ? "" : "s"}`,
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
          service.hasVault ? h("span", { title: "Edit it from the sidebar's Vault row" }, icon("lock"), " vault") : null,
        ),
      ),
      service.playbooks.map((/** @type {any} */ playbook) => card(folder, environment, playbook)),
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
      open ? cardBody(folder, playbook) : null,
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
        h("p", { class: "note" }, "No named tasks found by the scanner. Tags and ⚙ in the sidebar still run it."),
      );
    }
    const selected = state.selected === playbook.file;
    const range = selected ? rangeIndices(tasks) : { from: -1, until: -1, active: false };
    const setup = new Set(setupTags[folder.path] || []);
    const activeTags = new Set(state.opts.tags.split(",").map((t) => t.trim()).filter(Boolean));
    let index = -1;

    return h(
      "div",
      { class: "card-body", role: "tree", "aria-label": `Tasks of ${playbook.name}`, "data-nav": `tasks:${playbook.file}` },
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
          [...common].map((tag) => tagChip(playbook, tag, activeTags)),
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
            activeTags,
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
   * A tag that adds itself to --tags when clicked, or removes itself again.
   *
   * @param {any} playbook @param {string} tag @param {Set<string>} activeTags
   */
  function tagChip(playbook, tag, activeTags) {
    return h(
      "button",
      {
        class: `chip ${activeTags.has(tag) ? "on" : ""}`,
        title: activeTags.has(tag) ? `Remove ${tag} from --tags` : `Add ${tag} to --tags`,
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
   * @param {{ inRange: boolean, isSetup: boolean, skipped: boolean, marker: string, activeTags: Set<string>, canRange: boolean, ownTags: string[] }} view
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
        view.ownTags.map((tag) => tagChip(playbook, tag, view.activeTags)),
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
    const folder = currentFolder();
    if (!folder) {
      return [h("p", { class: "empty" }, "Open a folder with playbooks to see them.")];
    }
    const environment = currentEnvironment(folder);
    if (!environment) {
      return [h("p", { class: "empty" }, "No Ansible environments found in this folder.")];
    }
    const service = currentService(environment);
    return [
      topbar(folder, environment),
      environment.isProduction
        ? h("div", { class: "banner", role: "status" }, icon("warning"), h("strong", null, "production"), " — runs here ask for confirmation before they start.")
        : h("div"),
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
      render();
    } else if (message.type === "preview") {
      preview = message;
      render();
    }
  });

  // The relative times go stale; a minute is as fine as they get.
  setInterval(() => model && render(), 60000);

  vscode.postMessage({ type: "ready" });
})();
