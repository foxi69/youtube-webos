import assert from 'node:assert';

import eslintJs from '@eslint/js';
import type { ESLint, Linter } from 'eslint';
import stylistic from '@stylistic/eslint-plugin';
import prettierConfig from 'eslint-config-prettier';
import * as regexpPlugin from 'eslint-plugin-regexp';
import globals from 'globals';
import pkgJson from './package.json' with { type: 'json' };

const defaultSourceType: Linter.SourceType = 'module';
assert(pkgJson.type === defaultSourceType);

const configs = [
  eslintJs.configs.recommended,
  prettierConfig,
  regexpPlugin.configs['flat/recommended'],

  {
    plugins: {
      // Cast needed due to type mismatch even though this is the recommmended way to use the plugin.
      '@stylistic': stylistic as ESLint.Plugin
    },

    linterOptions: {
      reportUnusedDisableDirectives: 'error'
    },

    languageOptions: {
      sourceType: defaultSourceType,
      parserOptions: {
        ecmaFeatures: {
          impliedStrict: true
        }
      },
      globals: {
        ...globals.nodeBuiltin
      }
    },

    rules: {
      'no-var': 'error',
      'no-await-in-loop': 'error',
      'no-implicit-globals': ['error'],
      'no-unused-vars': ['error', { vars: 'local', argsIgnorePattern: '^_' }],
      'no-useless-rename': ['error'],
      'no-useless-computed-key': 'error',
      'no-useless-constructor': 'error',
      'no-useless-return': 'error',
      'arrow-body-style': ['error', 'as-needed'],
      'no-lonely-if': 'error',
      // Off: Object.hasOwn is Chromium 93+, polyfilled nowhere (the webOS 22
      // build has no polyfills), and the rule's fix broke webOS 3-6 and 22.
      'prefer-object-has-own': 'off',
      'no-restricted-properties': [
        'error',
        {
          object: 'Object',
          property: 'hasOwn',
          message: 'Object.hasOwn is Chromium 93+; use Object.prototype.hasOwnProperty.call (webOS 3-6 and 22).'
        }
      ],
      'prefer-exponentiation-operator': 'error',
      'prefer-regex-literals': ['error', { disallowRedundantWrapping: true }],
      'array-callback-return': [
        'error',
        { checkForEach: true, allowVoid: true }
      ],
      'no-constructor-return': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-useless-assignment': 'error',

      // @stylistic rules - needed as prettier doesn't handle these
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],

      /* eslint-plugin-regexp */
      'regexp/prefer-character-class': ['error', { minAlternatives: 2 }],
      'regexp/no-empty-alternative': 'error', // Set to warn in recommended config
      'regexp/no-lazy-ends': 'error', // Set to warn in recommended config
      'regexp/no-potentially-useless-backreference': 'error', // Set to warn in recommended config
      'regexp/confusing-quantifier': 'error', // Set to warn in recommended config
      'regexp/no-useless-flag': 'error', // Set to warn in recommended config
      'regexp/optimal-lookaround-quantifier': 'error' // Set to warn in recommended config
    }
  },

  {
    files: ['src/**/*'],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },

  {
    // Why doesn't ESLint do this by default is beyond me.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      // __dirname, require and the rest of a CommonJS module's own names.
      globals: {
        ...globals.node
      }
    }
  },

  {
    // Why doesn't ESLint do this by default is beyond me.
    files: ['**/*.mjs'],
    languageOptions: {
      sourceType: 'module'
    }
  },

  {
    // The bench tests run their cases one after another, on purpose: each
    // boots its own page and timers, and running them at once would mix them.
    files: ['bench/**'],
    rules: {
      'no-await-in-loop': 'off'
    }
  },

  {
    // The simulator tests: Node scripts that drive a simulator step by step.
    files: ['tools/simulator-tests/**'],
    languageOptions: {
      globals: {
        ...globals.node
      }
    },
    rules: {
      'no-await-in-loop': 'off'
    }
  },

  {
    // Runs inside the simulator's YouTube page, as a plain script.
    files: ['tools/simulator-tests/effects-page.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser
      }
    },
    rules: {
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
      // Object.hasOwn is Chromium 93+; the webOS 6 simulator is 79.
      'prefer-object-has-own': 'off'
    }
  },

  {
    // Written with `var` throughout: buffer-limit.js in ES5 on purpose (see
    // its header), and perf_mon.js, a dev tool left in the style it was
    // written in.
    files: ['src/perf_mon.js', 'src/hooks/buffer-limit.js'],
    rules: {
      'no-var': 'off'
    }
  },

  {
    // The emoji character class names Unicode symbol blocks by their
    // characters (EMOJI_CHAR_RE): the ranges are the point.
    files: ['src/adblock.js'],
    rules: {
      'regexp/no-obscure-range': 'off'
    }
  },

  {
    // `ignores` field must be in the very bottom config.
    // src/vendor: third-party code, kept as its authors wrote it.
    ignores: ['dist/**/*', '**/*-polyfill.*', 'src/vendor/**/*']
  }
] as const satisfies Linter.Config[];

export default configs;
