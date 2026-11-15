"use strict";

const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  {
    ignores: ["node_modules/**", "dist/**", "**/*.vsix", ".venv/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // Correctness.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-implicit-coercion": ["error", { boolean: false }],
      "no-return-await": "error",
      "no-throw-literal": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-var": "error",
      "prefer-const": "error",
      "require-atomic-updates": "error",

      // This extension builds shell command lines; the dynamic-execution
      // escape hatches have no business being in it.
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    // The dashboard's page script runs in the webview, not in node.
    files: ["media/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        acquireVsCodeApi: "readonly",
      },
    },
  },
  {
    // Tests deliberately assert on undefined-ish inputs.
    files: ["test/**/*.js"],
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];
