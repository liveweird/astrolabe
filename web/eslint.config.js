import js from '@eslint/js'
import globals from 'globals'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import sonarjs from 'eslint-plugin-sonarjs'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // schema.ts is generated (npm run gen:api) — type-checked by tsc, not style-linted.
  globalIgnores(['dist', 'coverage', 'src/api/schema.ts']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      sonarjs.configs.recommended,
      jsxA11y.flatConfigs.recommended,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Allow intentionally-unused bindings prefixed with `_` (e.g. destructuring a
      // field out of an object to omit it from a payload).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // ── Quality gates (the frontend counterpart of config/detekt/detekt.yml) ─────────
      // Policy: fix findings in code first; tune a rule here ONLY for a deliberate repo
      // idiom, with a comment naming it. No inline eslint-disable without a comment.

      // JSX conditional chains (`cond ? … : cond2 ? … : …`) are idiomatic React rendering.
      'sonarjs/no-nested-conditional': 'off',
      // Page/table components are single functions by React architecture (the SPA sibling
      // of the backend's *Routes.kt registrars) — backstop above today's max (25, re-measured 2026-09-30).
      'sonarjs/cognitive-complexity': ['error', 40],
      // The link builders' `${base}${x ? `?x=${…}` : ''}` shape (utils/*Links.ts) is the
      // documented URL-assembly idiom.
      'sonarjs/no-nested-template-literals': 'off',
      // Flags i18n key maps (PASSWORD_CHANGED: "passwordChanged") and test fixture
      // passwords; the SPA stores no credentials in code.
      'sonarjs/no-hardcoded-passwords': 'off',
      // Test names are literal sentences by convention (greppable by the checkup rituals);
      // test.each would generate dynamic names.
      'sonarjs/parameterized-tests': 'off',
      // http:// literals are dev/test fixtures only — production is single-origin behind
      // the Ktor server (HSTS + HTTPS redirect there).
      'sonarjs/no-clear-text-protocols': 'off',
      // Core size/complexity backstops — generous by design (React components are single
      // functions; these only catch future monsters, today's max: 360 lines (twelve test describe blocks sit at 300-360; the largest
      // production component is DataSourceDetails at 305, re-measured 2026-10-23) / cc 45 (2026-09-30).
      complexity: ['error', 50],
      'max-lines-per-function': ['error', { max: 360, skipBlankLines: true, skipComments: true }],
      'max-depth': ['error', 5],
      // The drill-down link builders (userXxxLink + DrillDownOpts tail params) carry 6.
      'max-params': ['error', 8],
    },
  },
  {
    // The ARIA grid pattern (the shared Timeline and its roving-grid hook test): the `role="grid"`
    // container is deliberately NOT a tab stop — `useRovingGrid` keeps exactly ONE tabIndex=0 on a
    // cell inside it and moves focus with the arrow keys (timeline.md "Accessibility model"), so
    // `tabIndex` on the container would add a second stop. Scoped to the two files that mount a
    // roving grid; any other `role="grid"` still has to be focusable.
    files: ['src/components/Timeline.tsx', 'src/hooks/useRovingGrid.test.tsx'],
    rules: {
      'jsx-a11y/interactive-supports-focus': 'off',
    },
  },
  {
    // Single-purpose entry pages: the sign-in form and its MFA code step (the email input unmounts
    // when the step swaps, so without autoFocus the keyboard focus would fall to <body>), the
    // password-reset request, and the create/edit-user form, whose first field is the page's one
    // task; plus the shell-focus hook's test, whose fixture fields must use the real `autoFocus` to
    // prove the hook leaves a page's own autofocus alone. Not a blanket: every other `autoFocus` (a
    // dialog uses Mantine's `data-autofocus`) is still a finding.
    files: [
      'src/hooks/useFocusMainOnNavigation.test.tsx',
      'src/pages/Login.tsx',
      'src/pages/ResetPassword.tsx',
      'src/components/UserFormFields.tsx',
    ],
    rules: {
      'jsx-a11y/no-autofocus': 'off',
    },
  },
  {
    // The build-time Node scripts (scripts/*.mjs, e.g. check-api.mjs) are linted with the same
    // recommended + sonarjs sets as the app code, but run on Node, not in a browser.
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended, sonarjs.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
])
