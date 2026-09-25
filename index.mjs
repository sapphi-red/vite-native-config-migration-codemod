#!/usr/bin/env node

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import { Lang, parse } from "@ast-grep/napi";

const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const astGrepRules = {
  moduleSpecifiers: {
    all: [
      { kind: "string_fragment" },
      { regex: "^(?:\\.{1,2}(?:/|$)|/)" },
      {
        inside: {
          stopBy: "end",
          any: [
            { kind: "import_statement" },
            { kind: "export_statement" },
            {
              all: [{ kind: "call_expression" }, { has: { kind: "import" } }],
            },
          ],
        },
      },
    ],
  },
  namedJsonImports: {
    all: [
      { kind: "import_statement" },
      { has: { kind: "named_imports", stopBy: "end" } },
      {
        has: {
          all: [{ kind: "string_fragment" }, { regex: "\\.json$" }],
          stopBy: "end",
        },
      },
    ],
  },
  imports: { kind: "import_statement" },
};

function parseArgs(argv) {
  const options = {
    warningRoot: process.cwd(),
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--root") {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      options.warningRoot = path.resolve(value);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

export function parseWarningOutput(output) {
  const lines = stripVTControlCharacters(output).split(/\r?\n/);
  const headerIndex = lines.findIndex((line) =>
    line.includes(
      "Your Vite config uses features that are unsupported by `configLoader: 'native'`",
    ),
  );
  if (headerIndex < 0)
    throw new Error("no Vite native config compatibility warning found in input");

  const warnings = [];
  const unsupported = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.includes("VITE_CONFIG_NATIVE_IGNORE_WARNING=true")) break;
    if (!line.trimStart().startsWith("- ")) continue;

    let match = line.match(
      /^\s*- import "([^"]+)" (without a file extension|resolves to a directory index) \((.+):(\d+):(\d+)\)\./,
    );
    if (match) {
      warnings.push({
        type: match[2] === "without a file extension" ? "extensionless" : "directory-index",
        specifier: match[1],
        file: match[3],
        line: Number(match[4]),
        column: Number(match[5]),
      });
      continue;
    }

    match = line.match(/^\s*- named import from JSON module "([^"]+)" \((.+):(\d+):(\d+)\)\./);
    if (match) {
      warnings.push({
        type: "named-json",
        specifier: match[1],
        file: match[2],
        line: Number(match[3]),
        column: Number(match[4]),
      });
      continue;
    }
    unsupported.push(line.trim());
  }

  if (unsupported.length > 0) {
    throw new Error(
      `unsupported Vite warning${unsupported.length === 1 ? "" : "s"}:\n${unsupported.join("\n")}`,
    );
  }
  if (warnings.length === 0)
    throw new Error("the Vite warning block contains no supported findings");
  return warnings;
}

function astGrepLanguage(filename) {
  if (/\.tsx$/i.test(filename)) return Lang.Tsx;
  if (/\.[cm]?ts$/i.test(filename)) return Lang.TypeScript;
  if (/\.[cm]?jsx?$/i.test(filename)) return Lang.JavaScript;
  throw new Error(`unsupported config dependency extension: ${filename}`);
}

function astGrepMatches(rule, files) {
  return files.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    const root = parse(astGrepLanguage(file), source).root();
    return root.findAll({ rule }).map((node) => {
      const range = node.range();
      return {
        file,
        text: node.text(),
        range: {
          start: range.start,
          end: range.end,
          byteOffset: {
            start: Buffer.byteLength(source.slice(0, range.start.index)),
            end: Buffer.byteLength(source.slice(0, range.end.index)),
          },
        },
      };
    });
  });
}

function isFile(filepath) {
  return existsSync(filepath) && statSync(filepath).isFile();
}

export function resolveModuleSpecifier(importer, specifier) {
  const lastSegment = specifier.slice(specifier.lastIndexOf("/") + 1);
  if (/\.[cm]?[jt]sx?$/.test(lastSegment)) return undefined;

  const resolved = path.isAbsolute(specifier)
    ? specifier
    : path.resolve(path.dirname(importer), specifier);
  const candidates = [];

  for (const extension of sourceExtensions) {
    if (isFile(resolved + extension)) candidates.push(specifier + extension);
  }

  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    const base = specifier.endsWith("/") ? specifier : `${specifier}/`;
    for (const extension of sourceExtensions) {
      if (isFile(path.join(resolved, `index${extension}`))) {
        candidates.push(`${base}index${extension}`);
      }
    }
  }

  if (candidates.length !== 1) {
    const reason = candidates.length === 0 ? "could not resolve it" : "resolved it ambiguously";
    throw new Error(`${importer}: ${reason}: ${JSON.stringify(specifier)}`);
  }
  return candidates[0];
}

function jsonBindingName(specifier, source, reservedBindings) {
  const filename = path.basename(specifier, ".json");
  const words = filename.split(/[^a-zA-Z0-9_$]+/).filter(Boolean);
  let base = `${words[0] || "data"}${words
    .slice(1)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join("")}Json`;
  if (!/^[a-zA-Z_$]/.test(base)) base = `_${base}`;
  let binding = base;
  let suffix = 2;
  while (reservedBindings.has(binding) || new RegExp(`\\b${binding}\\b`).test(source)) {
    binding = `${base}${suffix++}`;
  }
  reservedBindings.add(binding);
  return binding;
}

function rewriteNamedJsonImport(statement, source, reservedBindings) {
  const match = statement.match(
    /^import\s+\{([\s\S]*?)\}\s+from\s+(['"])([^'"]+\.json)\2(\s+with\s+\{[\s\S]*?\})?\s*;?$/,
  );
  if (!match) throw new Error(`unsupported named JSON import: ${statement}`);

  const [, imports, quote, specifier, attributes] = match;
  const properties = imports
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const alias = part.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
      if (alias) return `${alias[1]}: ${alias[2]}`;
      if (/^[\w$]+$/.test(part)) return part;
      throw new Error(`unsupported JSON import binding: ${part}`);
    });
  const binding = jsonBindingName(specifier, source, reservedBindings);
  const importAttributes = attributes || ` with { type: ${quote}json${quote} }`;
  return {
    importStatement: `import ${binding} from ${quote}${specifier}${quote}${importAttributes};`,
    initializer: `const { ${properties.join(", ")} } = ${binding};`,
  };
}

function addEdit(editsByFile, filename, edit) {
  const edits = editsByFile.get(filename) || [];
  if (!edits.some((existing) => existing.start === edit.start && existing.end === edit.end)) {
    edits.push(edit);
    editsByFile.set(filename, edits);
  }
}

function isTrivia(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/g, "").trim() === "";
}

function initializerOffset(source, imports, start) {
  let offset = start;
  for (const importMatch of imports) {
    if (importMatch.range.byteOffset.start < offset) continue;
    if (!isTrivia(source.slice(offset, importMatch.range.byteOffset.start))) break;
    offset = importMatch.range.byteOffset.end;
  }
  return offset;
}

function findAtLocation(matches, warning, filename) {
  const candidates = matches.filter(
    (match) => path.resolve(match.file) === filename && match.text === warning.specifier,
  );
  if (candidates.length <= 1) return candidates[0];
  return (
    candidates.find(
      (match) =>
        match.range.start.line === warning.line - 1 && match.range.start.column === warning.column,
    ) || candidates.find((match) => match.range.start.line === warning.line - 1)
  );
}

export function runCodemod(argv = process.argv.slice(2), input) {
  const { warningRoot } = parseArgs(argv);
  const warningOutput = input ?? readFileSync(0, "utf8");
  const warnings = parseWarningOutput(warningOutput);
  const resolvedWarnings = warnings.map((warning) => ({
    ...warning,
    filename: path.resolve(warningRoot, warning.file),
  }));
  const missingFiles = resolvedWarnings.filter((warning) => !isFile(warning.filename));
  if (missingFiles.length > 0) {
    throw new Error(
      `reported file not found (use --root to set Vite's root): ${missingFiles[0].filename}`,
    );
  }

  const files = [...new Set(resolvedWarnings.map((warning) => warning.filename))];
  const moduleMatches = astGrepMatches(astGrepRules.moduleSpecifiers, files);
  const jsonMatches = astGrepMatches(astGrepRules.namedJsonImports, files);
  const importMatches = astGrepMatches(astGrepRules.imports, files);
  const editsByFile = new Map();
  const jsonInitializers = new Map();
  const jsonBindings = new Map();
  let migrationCount = 0;

  for (const warning of resolvedWarnings) {
    if (warning.type === "named-json") {
      const candidates = jsonMatches.filter(
        (match) =>
          (path.resolve(match.file) === warning.filename &&
            match.text.includes(`'${warning.specifier}'`)) ||
          (path.resolve(match.file) === warning.filename &&
            match.text.includes(`"${warning.specifier}"`)),
      );
      const match =
        candidates.length <= 1
          ? candidates[0]
          : candidates.find((candidate) => candidate.range.start.line === warning.line - 1);
      if (!match) {
        const source = readFileSync(warning.filename, "utf8");
        const defaultImportExists = importMatches.some(
          (candidate) =>
            path.resolve(candidate.file) === warning.filename &&
            !/^import\s+\{/.test(candidate.text) &&
            (candidate.text.includes(`'${warning.specifier}'`) ||
              candidate.text.includes(`"${warning.specifier}"`)),
        );
        if (!defaultImportExists && source.includes(warning.specifier)) {
          throw new Error(
            `${warning.filename}:${warning.line}: named JSON re-exports are not supported`,
          );
        }
        continue;
      }
      const source = readFileSync(warning.filename, "utf8");
      const reservedBindings = jsonBindings.get(warning.filename) || new Set();
      const replacement = rewriteNamedJsonImport(match.text, source, reservedBindings);
      jsonBindings.set(warning.filename, reservedBindings);
      addEdit(editsByFile, warning.filename, {
        start: match.range.byteOffset.start,
        end: match.range.byteOffset.end,
        replacement: replacement.importStatement,
      });
      const initializers = jsonInitializers.get(warning.filename) || [];
      initializers.push({
        after: match.range.byteOffset.end,
        text: replacement.initializer,
      });
      jsonInitializers.set(warning.filename, initializers);
      migrationCount++;
      continue;
    }

    const match = findAtLocation(moduleMatches, warning, warning.filename);
    if (!match) {
      const source = readFileSync(warning.filename, "utf8");
      if (source.includes(`'${warning.specifier}'`) || source.includes(`"${warning.specifier}"`)) {
        throw new Error(
          `${warning.filename}:${warning.line}: ast-grep could not locate ${JSON.stringify(warning.specifier)}`,
        );
      }
      continue;
    }
    addEdit(editsByFile, warning.filename, {
      start: match.range.byteOffset.start,
      end: match.range.byteOffset.end,
      replacement: resolveModuleSpecifier(warning.filename, warning.specifier),
    });
    migrationCount++;
  }

  for (const [filename, initializers] of jsonInitializers) {
    const source = readFileSync(filename, "utf8");
    const imports = importMatches
      .filter((match) => path.resolve(match.file) === filename)
      .sort((a, b) => a.range.byteOffset.start - b.range.byteOffset.start);
    const initializersByOffset = new Map();
    for (const initializer of initializers) {
      const offset = initializerOffset(source, imports, initializer.after);
      const texts = initializersByOffset.get(offset) || [];
      texts.push(initializer.text);
      initializersByOffset.set(offset, texts);
    }
    for (const [offset, texts] of initializersByOffset) {
      addEdit(editsByFile, filename, {
        start: offset,
        end: offset,
        replacement: `\n\n${texts.join("\n")}`,
      });
    }
  }

  if (migrationCount === 0) {
    console.log("All reported imports are already compatible with Vite native config loading.");
    return 0;
  }

  for (const [filename, edits] of editsByFile) {
    let source = readFileSync(filename);
    edits.sort((a, b) => b.start - a.start);
    for (const edit of edits) {
      source = Buffer.concat([
        source.subarray(0, edit.start),
        Buffer.from(edit.replacement),
        source.subarray(edit.end),
      ]);
    }
    writeFileSync(filename, source);
  }

  console.log(
    `Migrated ${migrationCount} reported import${migrationCount === 1 ? "" : "s"} in ${
      editsByFile.size
    } file${editsByFile.size === 1 ? "" : "s"}.`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCodemod();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
