// Splits the Chrome 47 application bundle into several classic <script> files.
//
// Why: Chrome 47 (Tizen 3.0) runs V8 4.5, which has no Ignition bytecode
// interpreter. When esbuild emits `format: "iife"`, the WHOLE bundle becomes a
// single ~4 MB function, and V8 must fully parse and full-code-generate that
// function in one pass the moment it is called. On a 2017 TV SoC that takes
// minutes and exhausts the renderer's memory, so the process is killed before
// a single module statement executes (observed on the UN58MU6120: boot stalls
// at the first statement outside the wrapper and the renderer dies ~30 s in).
// Modern V8 compiles incrementally, which is why the same bundle works on a PC.
//
// The fix restores the granularity old browsers need: unwrap the iife
// statement level and emit N sequential classic scripts. Scripts share the
// global scope and execute in the original statement order, so semantics are
// preserved, while each file is parsed and code-generated separately.
//
// Split points are never placed inside a module: the esbuild/Babel build
// injects a `B:mod:<path>` title marker at the start of every module body
// (build.mjs marker plugin), and chunks only break right before a module
// marker. Module-internal hoisting and use-before-define therefore stay
// within a single script, exactly as before.
//
// Runs as a Tizen packaging step (scripts/package-tizen.mjs) on the staged
// app.bundle.js after the Babel Chrome 47 pass.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "@babel/parser";

const MODULE_MARKER = 'B:mod:';
const CHUNK_MARKER_PREFIX = 'try{document.title="B:chunk';
// Window properties that a top-level `var`/`let` must never shadow: unforgeable
// names are a SyntaxError at global scope, and the rest would break the page.
const WINDOW_RESERVED_NAMES = new Set([
  "top", "name", "location", "length", "origin", "parent", "self", "status",
  "history", "screen", "closed", "frames", "menubar", "toolbar", "locationbar",
  "scrollbar", "personalbar", "directories", "close", "focus", "blur", "open",
  "print", "stop", "find", "moveBy", "moveTo", "resizeBy", "resizeTo", "scroll",
  "scrollBy", "scrollTo", "scrollX", "scrollY", "pageXOffset", "pageYOffset",
  "innerWidth", "innerHeight", "outerWidth", "outerHeight", "window", "document",
  "navigator", "console", "performance", "localStorage", "sessionStorage",
  "eval", "arguments", "undefined", "NaN", "Infinity", "globalThis", "crypto",
  "fetch", "WebSocket", "Image", "alert", "postMessage", "getComputedStyle",
  "requestAnimationFrame", "setTimeout", "setInterval", "clearTimeout",
  "clearInterval", "queueMicrotask", "structuredClone"
]);

function isWrapperStatement(statement) {
  if (statement.type !== "ExpressionStatement") return false;
  const expression = statement.expression;
  if (expression.type !== "CallExpression" || expression.arguments.length > 0) {
    return false;
  }
  const callee = expression.callee;
  if (
    callee.type !== "ArrowFunctionExpression" &&
    callee.type !== "FunctionExpression"
  ) {
    return false;
  }
  return callee.body.type === "BlockStatement";
}

function collectIdentifierNames(node, into) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collectIdentifierNames(child, into);
    return;
  }
  if (node.type === "Identifier") {
    into.add(node.name);
    return;
  }
  if (
    node.type === "ObjectPattern" ||
    node.type === "ArrayPattern" ||
    node.type === "AssignmentPattern" ||
    node.type === "RestElement" ||
    node.type === "ObjectProperty" ||
    node.type === "RestProperty" ||
    node.type === "SpreadProperty"
  ) {
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
      collectIdentifierNames(node[key], into);
    }
  }
}

// All names a statement declares at script scope: top-level declarations plus
// `var`s hoisted out of nested blocks (but never out of nested functions,
// which keep their own scope after the split).
function collectScriptScopeNames(statement, into) {
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node.type !== "string") return;
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      if (node.type === "FunctionDeclaration" && node.id) into.add(node.id.name);
      return; // nested functions keep their own scope in every variant
    }
    if (node.type === "VariableDeclaration") {
      for (const declarator of node.declarations) {
        collectIdentifierNames(declarator.id, into);
      }
      return;
    }
    if (node.type === "ClassDeclaration" && node.id) {
      into.add(node.id.name);
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
      visit(node[key]);
    }
  };
  visit(statement);
}

function findWrapper(programBody, sourceLength) {
  let wrapper = null;
  let wrapperIndex = -1;
  for (let i = 0; i < programBody.length; i += 1) {
    const statement = programBody[i];
    if (!isWrapperStatement(statement)) continue;
    if (!wrapper || statement.end - statement.start > wrapper.end - wrapper.start) {
      wrapper = statement;
      wrapperIndex = i;
    }
  }
  if (!wrapper) {
    throw new Error(
      "splitLegacyBundle: no iife wrapper found in app.bundle.js (esbuild output changed shape?)"
    );
  }
  if (wrapper.end - wrapper.start < sourceLength * 0.4) {
    throw new Error(
      `splitLegacyBundle: largest wrapper covers only ${wrapper.end - wrapper.start} of ${sourceLength} bytes`
    );
  }
  return { wrapper, wrapperIndex };
}

function chunkFileName(index) {
  // Chunk 1 keeps the canonical name so every existing reference (onerror
  // handlers, service asserts) keeps pointing at the first script.
  return index === 1 ? "app.bundle.js" : `app.chunk${index}.js`;
}

export async function splitLegacyBundle({ stagingDir, targetBytes = 300 * 1024 }) {
  const filePath = path.join(stagingDir, "app.bundle.js");
  const source = await readFile(filePath, "utf8");
  const startedAt = Date.now();

  const ast = parse(source, { sourceType: "script" });
  const { wrapper, wrapperIndex } = findWrapper(ast.program.body, source.length);

  const statements = [
    ...ast.program.body.slice(0, wrapperIndex).map((node) => ({ node, inWrapperBody: false })),
    ...wrapper.expression.callee.body.body.map((node) => ({ node, inWrapperBody: true })),
    ...ast.program.body.slice(wrapperIndex + 1).map((node) => ({ node, inWrapperBody: false }))
  ];

  for (const entry of statements) {
    if (entry.node.type === "ReturnStatement" || entry.node.type === "BreakStatement" ||
        entry.node.type === "ContinueStatement") {
      throw new Error(
        `splitLegacyBundle: top-level ${entry.node.type} cannot survive the iife unwrap`
      );
    }
    entry.source = source.slice(entry.node.start, entry.node.end);
    entry.isModuleMarker = entry.source.includes(MODULE_MARKER);
  }

  // Shadow check: names that were function-scoped inside the wrapper become
  // global here. Collisions with window properties would be a SyntaxError (for
  // unforgeable names) or silently break the page, and collisions between the
  // wrapper body and the code around it would redeclare bindings.
  const innerNames = new Set();
  const outerNames = new Set();
  for (const entry of statements) {
    collectScriptScopeNames(entry.node, entry.inWrapperBody ? innerNames : outerNames);
  }
  const reserved = [...innerNames, ...outerNames].filter((name) => WINDOW_RESERVED_NAMES.has(name));
  if (reserved.length > 0) {
    throw new Error(
      `splitLegacyBundle: top-level names would shadow window properties: ${reserved.join(", ")}`
    );
  }
  const redeclared = [...innerNames].filter((name) => outerNames.has(name));
  if (redeclared.length > 0) {
    throw new Error(
      `splitLegacyBundle: bindings redeclared after the unwrap: ${redeclared.join(", ")}`
    );
  }

  // Partition: only ever break right before a module marker, so a module's
  // statements always stay together inside one script (hoisting semantics).
  const groups = [];
  let current = [];
  let currentBytes = 0;
  for (const entry of statements) {
    if (entry.isModuleMarker && current.length > 0 && currentBytes >= targetBytes) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += entry.source.length + 2;
  }
  if (current.length > 0) groups.push(current);

  const chunkNames = [];
  for (let i = 0; i < groups.length; i += 1) {
    const chunkIndex = i + 1;
    const fileName = chunkFileName(chunkIndex);
    const body = groups[i]
      .map((entry) => `${entry.source};`)
      .join("\n");
    const contents = `"use strict";\n${CHUNK_MARKER_PREFIX}${chunkIndex}";}catch(_){}\n${body}\n`;
    await writeFile(path.join(stagingDir, fileName), contents, "utf8");
    // Fail the package here, not on the TV: each chunk must be a standalone
    // valid strict-mode script.
    parse(contents, { sourceType: "script" });
    chunkNames.push(fileName);
  }

  const elapsed = Date.now() - startedAt;
  const sizes = groups.map((group) =>
    group.reduce((sum, entry) => sum + entry.source.length + 2, 0)
  );
  console.log(
    `bundle split into ${chunkNames.length} scripts (${sizes.join(" + ")} bytes, ${elapsed}ms): ` +
      chunkNames.join(", ")
  );
  return chunkNames;
}
