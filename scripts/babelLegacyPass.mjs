import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { transformAsync } from "@babel/core";
import presetEnvModule from "@babel/preset-env";
import { parse } from "@babel/parser";

// Second transpilation stage for Chromium 47 (Tizen 3.0).
//
// esbuild (see legacyScriptTarget in build.mjs) refuses to lower several
// constructs below chrome51, so it compiles at chrome56 and this pass lowers
// the remaining syntax that Chromium 47 cannot parse:
//   - destructuring (49)
//   - default parameters (49)
//   - exponentiation operator (52)
//   - async/await (55) -> generators (native since Chrome 39)
// `let`/`const`/`class` stay as-is: Chromium 47 runs them in strict mode only
// (BCD: "Strict mode is required" for class 42-48), and every bundle carries
// an esbuild "use strict" banner.

const presetEnv = presetEnvModule.default || presetEnvModule;
const CHROME_TARGET = "47";

// Bundles emitted by esbuild at chrome56 that need the extra lowering step.
const TRANSFORM_FILES = [
  "app.bundle.js",
  "assets/libs/ass.min.js",
  "assets/libs/quickjs-emscripten.global.js",
  "assets/runtime/plugin-worker.js",
  "assets/runtime/subtitle-autosync-worker.js"
];

export async function babelLegacyPass({ distDir }) {
  console.log(`lowering bundles to Chrome ${CHROME_TARGET} with Babel...`);

  for (const relativePath of TRANSFORM_FILES) {
    const filePath = path.join(distDir, relativePath);
    const source = await readFile(filePath, "utf8");
    const startedAt = Date.now();

    const result = await transformAsync(source, {
      configFile: false,
      babelrc: false,
      filename: filePath,
      sourceType: "script",
      compact: true,
      comments: false,
      presets: [
        [
          presetEnv,
          {
            targets: { chrome: CHROME_TARGET },
            modules: false,
            // Chromium 47 runs generator functions natively (Chrome 39), so
            // regenerator is unnecessary; its emitter also crashes on some
            // spread expressions. async/await is still lowered to generators
            // by transform-async-to-generator with an inline helper.
            exclude: ["transform-regenerator"]
          }
        ]
      ]
    });

    if (!result || typeof result.code !== "string") {
      throw new Error(`Babel produced no output for ${relativePath}`);
    }

    await writeFile(filePath, result.code, "utf8");
    // The esbuild sourcemap (debug builds only) no longer matches.
    await rm(`${filePath}.map`, { force: true });

    const elapsed = Date.now() - startedAt;
    console.log(
      `  ${relativePath}: ${source.length} -> ${result.code.length} bytes (${elapsed}ms)`
    );
  }
}

// ---------------------------------------------------------------------------
// Chrome 47 syntax verifier: parse every script in dist and fail the build if
// anything remains that Chromium 47 (Tizen 3.0) cannot parse. Babel cannot
// transform regex literals or a few edge constructs, so this is the guard
// rail that surfaces them before the app ever reaches the TV.
// ---------------------------------------------------------------------------

const FORBIDDEN_NODE_TYPES = new Map([
  ["ObjectPattern", "destructuring (Chrome 49)"],
  ["ArrayPattern", "destructuring (Chrome 49)"],
  ["AssignmentPattern", "default parameters (Chrome 49)"],
  ["OptionalMemberExpression", "optional chaining ?. (Chrome 80)"],
  ["OptionalCallExpression", "optional chaining ?. (Chrome 80)"],
  ["BigIntLiteral", "BigInt literal (Chrome 57)"],
  ["ImportMeta", "import.meta (Chrome 64)"],
  ["ClassProperty", "class fields (Chrome 72)"],
  ["ClassPrivateProperty", "private class fields (Chrome 74)"],
  ["ClassPrivateMethod", "private class methods (Chrome 84)"],
  ["StaticBlock", "class static blocks (Chrome 91)"],
  ["ImportDeclaration", "ES module import (bundle must be an IIFE)"],
  ["ExportNamedDeclaration", "ES module export (bundle must be an IIFE)"],
  ["ExportAllDeclaration", "ES module export (bundle must be an IIFE)"]
]);

function regexChrome47Issues(literal) {
  const issues = [];
  const { pattern = "", flags = "" } = literal;
  if (pattern.includes("(?<=") || pattern.includes("(?<!")) {
    issues.push("regex lookbehind (Chrome 62)");
  }
  if (/\(\?<[a-zA-Z]/.test(pattern)) {
    issues.push("regex named capture group (Chrome 64)");
  }
  if (pattern.includes("\\k<")) {
    issues.push("regex named backreference (Chrome 64)");
  }
  if (flags.includes("s")) {
    issues.push("regex dotAll flag s (Chrome 62)");
  }
  if (flags.includes("d")) {
    issues.push("regex hasIndices flag d (Chrome 64)");
  }
  if (flags.includes("v")) {
    issues.push("regex unicodeSets flag v (Chrome 112)");
  }
  if (pattern.includes("\\p{") || pattern.includes("\\P{")) {
    issues.push("regex unicode property escape (Chrome 64)");
  }
  return issues;
}

function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range" || key === "extra") {
      continue;
    }
    walkAst(node[key], visit);
  }
}

function findChrome47Issues(ast) {
  const issues = [];
  walkAst(ast, (node) => {
    const typeIssue = FORBIDDEN_NODE_TYPES.get(node.type);
    if (typeIssue) {
      issues.push(typeIssue);
      return;
    }
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression" || node.type === "ObjectMethod" ||
        node.type === "ClassMethod") {
      if (node.async) issues.push("async function (Chrome 55)");
    }
    if (node.type === "ForOfStatement" && node.await) {
      issues.push("for await...of (Chrome 63)");
    }
    if (node.type === "LogicalExpression" && node.operator === "??") {
      issues.push("nullish coalescing ?? (Chrome 80)");
    }
    if ((node.type === "BinaryExpression" || node.type === "AssignmentExpression") &&
        node.operator === "**") {
      issues.push("exponentiation operator ** (Chrome 52)");
    }
    if (node.type === "AssignmentExpression" &&
        (node.operator === "&&=" || node.operator === "||=" || node.operator === "??=")) {
      issues.push("logical assignment (Chrome 85)");
    }
    if (node.type === "ObjectExpression" &&
        node.properties.some((property) => property && property.type === "SpreadElement")) {
      issues.push("object spread {...x} (Chrome 60)");
    }
    if (node.type === "RegExpLiteral") {
      issues.push(...regexChrome47Issues(node));
    }
    if (node.type === "NumericLiteral" && node.extra && typeof node.extra.raw === "string" &&
        node.extra.raw.includes("_")) {
      issues.push("numeric separator 1_000 (Chrome 75)");
    }
  });
  return issues;
}

async function collectJsFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsFiles(entryPath)));
    } else if (entry.name.endsWith(".js")) {
      files.push(entryPath);
    }
  }
  return files;
}

function hasUseStrict(body) {
  return Boolean(
    body &&
    body.directives &&
    body.directives.some(
      (directive) => directive.value && directive.value.value === "use strict"
    )
  );
}

// Chromium 47 runs let/const/class only in strict mode (BCD: "Strict mode is
// required" for the Chrome 41-48 partial support window). Bundles built by
// esbuild carry a "use strict" banner and Babel lowers let/const for chrome47,
// so anything still declared in a sloppy scope is a parse error on the TV.
function findSloppyScopeIssues(ast) {
  const issues = [];

  function visit(node, strict) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, strict);
      return;
    }
    if (typeof node.type !== "string") return;

    let childStrict = strict;

    switch (node.type) {
      case "Program":
        childStrict = strict || hasUseStrict(node);
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ObjectMethod":
      case "ClassMethod":
        // A directive inside the function body makes that body strict.
        childStrict = strict || hasUseStrict(node.body);
        break;
      case "ArrowFunctionExpression":
        childStrict =
          strict ||
          (node.body && node.body.type === "BlockStatement"
            ? hasUseStrict(node.body)
            : false);
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        if (!strict) {
          issues.push("class in sloppy scope (Chrome 47 requires strict mode)");
        }
        childStrict = true; // class bodies are strict by specification
        break;
      case "VariableDeclaration":
        if (!strict && (node.kind === "let" || node.kind === "const")) {
          issues.push(
            `${node.kind} in sloppy scope (Chrome 47 requires strict mode)`
          );
        }
        break;
      default:
        break;
    }

    for (const key of Object.keys(node)) {
      if (
        key === "loc" ||
        key === "start" ||
        key === "end" ||
        key === "range" ||
        key === "extra" ||
        key === "directives"
      ) {
        continue;
      }
      visit(node[key], childStrict);
    }
  }

  visit(ast, false);
  return issues;
}

export async function verifyLegacySyntax({ distDir }) {
  console.log(`verifying Chrome ${CHROME_TARGET} syntax in dist...`);
  const files = (await collectJsFiles(distDir)).sort();
  const failures = [];

  for (const filePath of files) {
    const relativePath = path.relative(distDir, filePath);
    const source = await readFile(filePath, "utf8");
    let ast;
    try {
      ast = parse(source, { sourceType: "script" });
    } catch (error) {
      failures.push(`${relativePath}: parse error: ${error.message}`);
      continue;
    }
    const issues = Array.from(
      new Set([...findChrome47Issues(ast), ...findSloppyScopeIssues(ast)])
    );
    for (const issue of issues) {
      failures.push(`${relativePath}: ${issue}`);
    }
  }

  if (failures.length > 0) {
    const message = [
      `Chrome ${CHROME_TARGET} syntax verification failed (${failures.length} findings):`,
      ...failures.map((failure) => `  - ${failure}`)
    ].join("\n");
    throw new Error(message);
  }

  console.log(`  ${files.length} scripts OK (no Chrome ${CHROME_TARGET} blockers found)`);
  return files.length;
}
