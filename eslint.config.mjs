import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Flat config, ESLint 9.
 *
 * Tuned for a repo that agents edit as much as humans do, which shifts what is
 * worth enforcing. Formatting is Prettier's job and is switched off here
 * entirely (`prettier` last) so the two never disagree -- a lint error about a
 * space is noise that trains people to ignore the linter.
 *
 * What is left are rules that catch real mistakes, with the type-aware set
 * turned on because this codebase passes `asOf` and nullable metric values
 * around and `strictNullChecks` violations are the bugs that actually happen.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      'packages/db/migrations/**',
      // The Python virtualenv vendors JavaScript (pip bundles urllib3, which
      // ships an emscripten worker). Nothing in there is ours.
      '**/.venv/**',
      'docs/screenshots/**',
      'tests/visual/__baselines__/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        /*
         * Explicit project list rather than `projectService: true`.
         *
         * The service is supposed to discover the nearest tsconfig per file,
         * but it did not pick up tests/visual/tsconfig.json and reported every
         * spec as "not found by the project service". Listing the three
         * projects is deterministic and says plainly which configs exist.
         */
        project: ['./tsconfig.json', './tests/visual/tsconfig.json', './apps/web/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused args are often deliberate in callbacks and proxy traps; a
      // leading underscore is the documented opt-out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // `any` is a real smell in query result types, where getting the shape
      // right is the whole point. Warn rather than error so it does not block a
      // commit on a legitimate escape hatch.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Floating promises in a metrics layer mean a query that silently never
      // ran. This one stays an error.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // postgres.js tagged templates return thenables that are not Promises,
      // and template literals legitimately interpolate numbers and dates.
      '@typescript-eslint/restrict-template-expressions': 'off',

      'no-console': 'off', // CLI scripts and the seed report progress on stdout.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  {
    // Tests assert against loosely typed query results and use non-null
    // assertions heavily; that is appropriate in a test and noise to flag.
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // The contract suite walks an OpenAPI document and arbitrary response
      // bodies. Both are untyped by nature -- the whole point is checking
      // whether they match a schema -- so the unsafe-* rules have nothing
      // useful to say there.
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },

  {
    // Config and loader files in plain .mjs are outside every tsconfig, so the
    // type-aware rules cannot run on them. Lint them syntactically instead of
    // failing to parse them.
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { project: null },
      // These run in Node, so `process` and friends are legitimate.
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },

  prettier,
);
