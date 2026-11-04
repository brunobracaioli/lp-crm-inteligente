import js from '@eslint/js';
import type { Linter } from 'eslint';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Architecture boundaries (ADR-0001), enforced with `no-restricted-imports`:
 * - modules talk to each other only through `modules/<ctx>/public-api.ts`;
 * - `domain/` imports nothing outside its own module domain and `#/shared`;
 * - `application/` never imports infrastructure, presentation or I/O drivers;
 * - no parent-relative imports anywhere (use the `#/` subpath alias).
 */
const MODULES = ['lead-capture', 'crm', 'tracking', 'intelligence'];

const IO_PACKAGES = [
  'hono',
  'hono/*',
  'postgres',
  'pino',
  '@upstash/*',
  '@vercel/*',
  '@opentelemetry/*',
  'jose',
  'msw',
  'node:*',
];

// `#/…` specifiers are matched with `regex`: in gitignore-style `group` patterns a leading `#` is a
// comment, which would silently disable the rule.
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parentImportPattern = {
  regex: '^\\.\\./',
  message: 'Use the #/ subpath alias instead of parent-relative imports.',
};

const crossModulePattern = (moduleName: string) => ({
  regex: `^#/modules/(?!${escapeRegex(moduleName)}/)[^/]+/(?!public-api\\.ts$)`,
  message: 'Modules communicate only via modules/<ctx>/public-api.ts or outbox events (ADR-0001).',
});

const moduleBoundaryConfigs: Linter.Config[] = MODULES.flatMap((moduleName): Linter.Config[] => [
  {
    files: [`src/modules/${moduleName}/**/*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [parentImportPattern, crossModulePattern(moduleName)] },
      ],
    },
  },
  {
    files: [`src/modules/${moduleName}/domain/**/*.ts`],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            parentImportPattern,
            {
              regex: `^#/(?!modules/${escapeRegex(moduleName)}/domain/|shared/)`,
              message: 'domain/ imports only its own domain and #/shared (pure code, no I/O).',
            },
            { group: [...IO_PACKAGES, 'zod'], message: 'domain/ must not depend on I/O or Zod.' },
          ],
        },
      ],
    },
  },
  {
    files: [`src/modules/${moduleName}/application/**/*.ts`],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            parentImportPattern,
            crossModulePattern(moduleName),
            {
              regex: `^#/(platform/(?!crypto/)|modules/${escapeRegex(moduleName)}/(infrastructure|presentation)/)`,
              message:
                'application/ depends on ports, domain, #/shared and #/platform/crypto only.',
            },
            {
              group: IO_PACKAGES,
              message: 'application/ must not import I/O drivers; use a port.',
            },
          ],
        },
      ],
    },
  },
]);

export default defineConfig(
  // api/ holds only the Vercel entry shim that re-exports dist/ (see api/index.js).
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'api/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-console': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-imports': ['error', { patterns: [parentImportPattern] }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='unsafe']",
          message: 'sql.unsafe is forbidden — use tagged templates (ADR-0003).',
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  ...moduleBoundaryConfigs,
  {
    files: ['**/*.test.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
