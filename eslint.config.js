// Atlas Systems — canonical ESLint flat config for Cloudflare Workers.
// Copy verbatim into each Worker repo root as eslint.config.js.
//
// ESLint 9 flat config. Targets ES module Workers and the Workers runtime
// global surface (a browser-like subset plus the service-worker globals).
import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
    rules: {
      // Catch dead code and typos. Underscore-prefixed names are allowed
      // through for deliberately-unused args (e.g. (event, _env, ctx)).
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
];
