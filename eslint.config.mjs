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
  { ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', 'packages/db/migrations/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Config files are not in any tsconfig's `include` (tsc does not pick
          // up .mjs without allowJs), so the project service has no type
          // information for them. Listing them here lets the default project
          // supply it instead of erroring.
          // vitest.config.mts is deliberately absent: it IS in tsconfig's
          // include, and listing a file in both is itself an error.
          allowDefaultProject: ['eslint.config.mjs'],
        },
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
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  prettier,
);
