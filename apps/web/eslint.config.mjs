import agentCoreConfig from '@agentcore/config/eslint';
import globals from 'globals';

export default [
  ...agentCoreConfig,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    ignores: [
      '.next/**',
      'next-env.d.ts',
      'test-results/**',
      'playwright-report/**',
    ],
  },
];
