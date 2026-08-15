import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  // Ignore patterns
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      // Build output whose directory name `**/dist/**` does not match.
      "**/dist-test/**",
      // The VS Code the integration suite downloads — 1.8 GB, and 291 of its own JS/TS files sit
      // outside `node_modules/` and `dist/`, so nothing above excluded them. Type-aware linting of
      // a bundled editor exhausted the heap: `eslint .` died at a 4 GB limit and still at 10 GB,
      // which made the whole lint gate unusable rather than merely slow (measured 2026-08-09).
      "**/.vscode-test/**",
      "**/build/**",
      "**/.gradle/**",
      "**/.idea/**",
      "**/coverage/**",
      "**/*.d.ts",
      // Unowned paths — not linted
      ".venv/**",
      "integrations/**",
      // A vendored upstream checkout, including its own test-fixture repositories. Its style is not
      // this project's to enforce, and its fixtures are deliberately odd — one `.js` under them has
      // no tsconfig at all, which the type-aware parser reports as a parsing error.
      "serena-upstream/**",
      "jetbrains-plugin/**",
      ".github/**",
      ".serena/**",
      ".slim/**",
      "docs/**",
      "examples/**",
    ],
  },

  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript strict type-checked rules
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // `strictTypeChecked` forbids a number in a template literal; the standard config allows one.
      // The rule earns its strictness against values whose string form is a guess — an object
      // becoming "[object Object]", a null becoming "null". A number's is exact and intended, and
      // every site this rejected here was a diagnostic message interpolating a depth or an epoch
      // (`${depth}`, `${workspaceEpoch}`). Wrapping those in `String(...)` would add noise and buy
      // no safety, so the allowance is stated once here rather than at five call sites.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },

  // Protocol package: enforce independence from IDE-specific and Serena code
  {
    files: ["packages/protocol/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "vscode",
              message:
                "packages/protocol must not import VS Code types. The protocol package must be IDE-independent.",
            },
            {
              name: "@types/vscode",
              message:
                "packages/protocol must not import @types/vscode. The protocol package must be IDE-independent.",
            },
            {
              name: "@serena",
              message:
                "packages/protocol must not import Serena code. The protocol package must be integration-independent.",
            },
          ],
          patterns: [
            {
              group: ["vscode/*", "@types/vscode/*"],
              message:
                "packages/protocol must not import VS Code submodules. The protocol package must be IDE-independent.",
            },
            {
              group: ["@serena/*", "serena/*"],
              message:
                "packages/protocol must not import Serena code. The protocol package must be integration-independent.",
            },
            {
              group: ["com.intellij.*", "org.jetbrains.*"],
              message:
                "packages/protocol must not import JetBrains SDK types. The protocol package must be IDE-independent.",
            },
          ],
        },
      ],
    },
  },

  // Test files: relax rules and disable type-checked linting.
  // vscode-extension typechecks its tests via tsconfig.test.json; the remaining
  // packages exclude tests from their tsconfigs, so type info is unavailable here.
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/tests/**/*.ts", "**/test/**/*.ts"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: false,
        program: null,
        project: false,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // Source files: allow underscore-prefixed unused parameters (e.g. VS Code activate context)
  {
    files: ["packages/*/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Config files: allow non-type-checked
  {
    files: ["**/*.config.ts", "**/*.config.mts", "**/*.config.js", "**/*.config.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: false,
        program: null,
        project: false,
      },
    },
  },

  // CommonJS utility scripts are not part of the TypeScript project graph.
  {
    files: ["**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: false,
        program: null,
        project: false,
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
