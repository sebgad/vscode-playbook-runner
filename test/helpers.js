/**
 * Shared test helpers.
 */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Assert that a lookup found something, and hand it back narrowed.
 *
 * `Array.prototype.find` returning undefined is a failed expectation, not a
 * reason for the next line to throw "cannot read properties of undefined".
 *
 * @template T
 * @param {T | undefined | null} value
 * @param {string} what
 * @returns {T}
 */
function required(value, what) {
  assert.ok(value !== undefined && value !== null, `expected to find ${what}`);
  return value;
}

/**
 * Build a throwaway repository from a list of relative paths, and register its
 * removal. A path ending in "/" becomes an empty directory.
 *
 * @param {string[]} files
 * @param {{ prefix?: string }} [opts]
 * @returns {string} the root directory
 */
function makeFixture(files, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), opts.prefix || "homelab-"));
  for (const relative of files) {
    const full = path.join(root, relative);
    if (relative.endsWith("/")) {
      fs.mkdirSync(full, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "");
  }
  return root;
}

/** @param {string} root */
function removeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

module.exports = { makeFixture, removeFixture, required };
