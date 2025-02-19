import { basename, resolve, join, dirname } from 'path';

import { declare } from '@babel/helper-plugin-utils';
import jsxSyntax from '@babel/plugin-syntax-jsx';
import template from '@babel/template';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { unique, preserveLeadingComments } from '@compiled/utils';

import { visitClassNamesPath } from './class-names';
import { visitCssMapPath } from './css-map';
import { visitCssPropPath } from './css-prop';
import { visitStyledPath } from './styled';
import type { State } from './types';
import { appendRuntimeImports } from './utils/append-runtime-imports';
import { Cache } from './utils/cache';
import {
  isCompiledCSSCallExpression,
  isCompiledCSSTaggedTemplateExpression,
  isCompiledKeyframesCallExpression,
  isCompiledKeyframesTaggedTemplateExpression,
  isCompiledStyledCallExpression,
  isCompiledStyledTaggedTemplateExpression,
  isCompiledCSSMapCallExpression,
} from './utils/is-compiled';
import { normalizePropsUsage } from './utils/normalize-props-usage';
import { visitXcssPropPath } from './xcss-prop';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../package.json');
const JSX_SOURCE_ANNOTATION_REGEX = /\*?\s*@jsxImportSource\s+([^\s]+)/;
const JSX_ANNOTATION_REGEX = /\*?\s*@jsx\s+([^\s]+)/;
const DEFAULT_IMPORT_SOURCE = '@compiled/react';

let globalCache: Cache | undefined;

export default declare<State>((api) => {
  api.assertVersion(7);

  return {
    name: packageJson.name,
    inherits: jsxSyntax,
    pre(state) {
      const rootPath = state.opts.root ?? this.cwd;

      this.sheets = {};
      this.cssMap = {};
      let cache: Cache;

      if (this.opts.cache === true) {
        globalCache = new Cache();
        cache = globalCache;
      } else {
        cache = new Cache();
      }

      cache.initialize({ ...this.opts, cache: !!this.opts.cache });

      this.cache = cache;
      this.includedFiles = [];
      this.pathsToCleanup = [];
      this.pragma = {};
      this.usesXcss = false;
      this.importSources = [
        DEFAULT_IMPORT_SOURCE,
        ...(this.opts.importSources
          ? this.opts.importSources.map((origin) => {
              if (origin[0] === '.') {
                // We've found a relative path, transform it to be fully qualified.
                return join(rootPath, origin);
              }

              return origin;
            })
          : []),
      ];

      if (typeof this.opts.resolver === 'object') {
        this.resolver = this.opts.resolver;
      } else if (typeof this.opts.resolver === 'string') {
        this.resolver = require(require.resolve(this.opts.resolver, {
          paths: [rootPath],
        }));
      }

      this.transformCache = new WeakMap();
    },
    visitor: {
      Program: {
        enter(_, state) {
          const { file } = state;

          if (file.ast.comments) {
            for (const comment of file.ast.comments) {
              const jsxSourceMatches = JSX_SOURCE_ANNOTATION_REGEX.exec(comment.value);
              const jsxMatches = JSX_ANNOTATION_REGEX.exec(comment.value);

              // jsxPragmas currently only run on the top-level compiled module,
              // hence we don't interrogate this.importSources.
              if (jsxSourceMatches && jsxSourceMatches[1] === DEFAULT_IMPORT_SOURCE) {
                // jsxImportSource pragma found - turn on CSS prop!
                state.compiledImports = {};
                state.pragma.jsxImportSource = true;
              }

              if (jsxMatches && jsxMatches[1] === 'jsx') {
                state.pragma.jsx = true;
              }
            }
          }

          // Default to true
          const processXcss = state.opts.processXcss ?? true;

          if (processXcss && /(x|X)css={/.test(file.code)) {
            // xcss prop was found, turn on Compiled but just for xcss
            state.usesXcss = true;
          }
        },
        exit(path, state) {
          if (!state.compiledImports && !state.usesXcss) {
            return;
          }

          const {
            pragma,
            opts: { importReact: shouldImportReact = true },
          } = state;

          preserveLeadingComments(path);

          appendRuntimeImports(path, state);

          const hasPragma = pragma.jsxImportSource || pragma.jsx;

          if (!hasPragma && shouldImportReact && !path.scope.getBinding('React')) {
            // React is missing - add it in at the last moment!
            path.unshiftContainer('body', template.ast(`import * as React from 'react'`));
          }

          if (state.compiledImports?.styled && !path.scope.getBinding('forwardRef')) {
            // forwardRef is missing - add it in at the last moment!
            path.unshiftContainer('body', template.ast(`import { forwardRef } from 'react'`));
          }

          const filename = basename(state.filename ?? '') || 'File';
          const version = process.env.TEST_PKG_VERSION || packageJson.version;

          path.addComment('leading', ` ${filename} generated by ${packageJson.name} v${version} `);

          // Add a line break after the comment
          path.unshiftContainer('body', t.noop());

          // Callback when included files have been added.
          if (this.includedFiles.length && this.opts.onIncludedFiles) {
            this.opts.onIncludedFiles(unique(this.includedFiles));
          }

          // Cleanup paths that have been marked.
          state.pathsToCleanup.forEach((clean) => {
            switch (clean.action) {
              case 'remove': {
                clean.path.remove();
                return;
              }

              case 'replace': {
                clean.path.replaceWith(t.nullLiteral());
                return;
              }

              default:
                return;
            }
          });
        },
      },
      ImportDeclaration(path, state) {
        const userLandModule = path.node.source.value;

        const isCompiledModule = this.importSources.some((compiledModuleOrigin) => {
          if (userLandModule === DEFAULT_IMPORT_SOURCE || compiledModuleOrigin === userLandModule) {
            return true;
          }

          if (
            state.filename &&
            userLandModule[0] === '.' &&
            userLandModule.endsWith(basename(compiledModuleOrigin))
          ) {
            // Relative import that might be a match, resolve the relative path and compare.
            const fullpath = resolve(dirname(state.filename), userLandModule);
            return fullpath === compiledModuleOrigin;
          }

          return false;
        });

        if (!isCompiledModule) {
          return;
        }

        // The presence of the module enables CSS prop
        state.compiledImports = state.compiledImports || {};

        // Go through each import and enable each found API
        path.get('specifiers').forEach((specifier) => {
          if (!state.compiledImports || !specifier.isImportSpecifier()) {
            // Bail out early
            return;
          }

          (['styled', 'ClassNames', 'css', 'keyframes', 'cssMap'] as const).forEach((apiName) => {
            if (
              state.compiledImports &&
              t.isIdentifier(specifier.node?.imported) &&
              specifier.node?.imported.name === apiName
            ) {
              // Enable the API with the local name
              state.compiledImports[apiName] = specifier.node.local.name;
              specifier.remove();
            }
          });
        });

        if (path.node.specifiers.length === 0) {
          path.remove();
        }
      },
      'TaggedTemplateExpression|CallExpression'(
        path: NodePath<t.TaggedTemplateExpression> | NodePath<t.CallExpression>,
        state: State
      ) {
        if (isCompiledCSSMapCallExpression(path.node, state)) {
          visitCssMapPath(path, { context: 'root', state, parentPath: path });
          return;
        }

        const hasStyles =
          isCompiledCSSTaggedTemplateExpression(path.node, state) ||
          isCompiledStyledTaggedTemplateExpression(path.node, state) ||
          isCompiledCSSCallExpression(path.node, state) ||
          isCompiledStyledCallExpression(path.node, state);

        if (hasStyles) {
          normalizePropsUsage(path);
        }

        const isCompiledUtil =
          isCompiledCSSTaggedTemplateExpression(path.node, state) ||
          isCompiledKeyframesTaggedTemplateExpression(path.node, state) ||
          isCompiledCSSCallExpression(path.node, state) ||
          isCompiledKeyframesCallExpression(path.node, state);

        if (isCompiledUtil) {
          state.pathsToCleanup.push({ path, action: 'replace' });
          return;
        }

        const isCompiledComponent =
          isCompiledStyledTaggedTemplateExpression(path.node, state) ||
          isCompiledStyledCallExpression(path.node, state);

        if (isCompiledComponent) {
          visitStyledPath(path, { context: 'root', state, parentPath: path });
          return;
        }
      },
      JSXElement(path, state) {
        if (!state.compiledImports?.ClassNames) {
          return;
        }

        visitClassNamesPath(path, { context: 'root', state, parentPath: path });
      },
      JSXOpeningElement(path, state) {
        if (state.usesXcss) {
          visitXcssPropPath(path, { context: 'root', state, parentPath: path });
        }

        if (state.compiledImports) {
          visitCssPropPath(path, { context: 'root', state, parentPath: path });
        }
      },
    },
  };
});
