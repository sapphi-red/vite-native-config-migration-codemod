import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parseWarningOutput, resolveModuleSpecifier } from "./index.mjs";

const codemod = fileURLToPath(new URL("./index.mjs", import.meta.url));

test("resolves a bare parent directory to its index file", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "vite-native-config-codemod-"));
  const nested = path.join(directory, "nested");
  mkdirSync(nested);
  writeFileSync(path.join(directory, "index.ts"), "export {};\n");
  writeFileSync(path.join(directory, "helper.test.ts"), "export {};\n");

  expect(resolveModuleSpecifier(path.join(nested, "main.ts"), "..")).toBe("../index.ts");
  expect(resolveModuleSpecifier(path.join(directory, "main.ts"), "./helper.test")).toBe(
    "./helper.test.ts",
  );
});

test("uses the JavaScript parser for JSX dependencies", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "vite-native-config-codemod-"));
  const sourceFile = path.join(directory, "main.jsx");
  writeFileSync(path.join(directory, "helper.js"), "export const helper = true;\n");
  writeFileSync(path.join(directory, "dynamic.js"), "export const dynamic = true;\n");
  writeFileSync(
    sourceFile,
    `import { helper } from './helper';
export const load = () => import('./dynamic');
export const element = <div>{helper}</div>;
`,
  );
  const warnings = `(!) Your Vite config uses features that are unsupported by \`configLoader: 'native'\`, which is planned to become the default in a future major version of Vite:
  - import "./helper" without a file extension (main.jsx:1:24). Add the file extension
  - import "./dynamic" without a file extension (main.jsx:2:33). Add the file extension
Set \`VITE_CONFIG_NATIVE_IGNORE_WARNING=true\` to suppress this warning.
`;

  const result = spawnSync(process.execPath, [codemod], {
    cwd: directory,
    encoding: "utf8",
    input: warnings,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(sourceFile, "utf8")).toMatch(/from '\.\/helper\.js'/);
  expect(readFileSync(sourceFile, "utf8")).toMatch(/import\('\.\/dynamic\.js'\)/);
});

test("preserves multibyte source before an edited import", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "vite-native-config-codemod-"));
  const sourceFile = path.join(directory, "main.ts");
  writeFileSync(path.join(directory, "helper.ts"), "export const helper = true;\n");
  writeFileSync(
    sourceFile,
    `const label = '日本語';
import { helper } from './helper';
`,
  );
  const warnings = `(!) Your Vite config uses features that are unsupported by \`configLoader: 'native'\`, which is planned to become the default in a future major version of Vite:
  - import "./helper" without a file extension (main.ts:2:24). Add the file extension
Set \`VITE_CONFIG_NATIVE_IGNORE_WARNING=true\` to suppress this warning.
`;

  const result = spawnSync(process.execPath, [codemod, "--root", directory], {
    encoding: "utf8",
    input: warnings,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(sourceFile, "utf8")).toBe(
    `const label = '日本語';
import { helper } from './helper.ts';
`,
  );
});

test("places a semicolonless JSON import initializer before its first use", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "vite-native-config-codemod-"));
  const sourceFile = path.join(directory, "main.ts");
  writeFileSync(path.join(directory, "package.json"), '{"name":"fixture"}\n');
  writeFileSync(
    sourceFile,
    `import { name } from './package.json' with { type: 'json' }
console.log(name);
import fs from 'node:fs';
console.log(fs);
`,
  );
  const warnings = `(!) Your Vite config uses features that are unsupported by \`configLoader: 'native'\`, which is planned to become the default in a future major version of Vite:
  - named import from JSON module "./package.json" (main.ts:1:10). JSON modules only provide a default export per spec. Use the default import and access the property
Set \`VITE_CONFIG_NATIVE_IGNORE_WARNING=true\` to suppress this warning.
`;

  const result = spawnSync(process.execPath, [codemod, "--root", directory], {
    encoding: "utf8",
    input: warnings,
  });
  expect(result.status, result.stderr).toBe(0);
  const output = readFileSync(sourceFile, "utf8");
  expect(output.indexOf("const { name }")).toBeLessThan(output.indexOf("console.log(name)"));
});

test("adds native extensions and rewrites named JSON imports", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "vite-native-config-codemod-"));
  const sourceFile = path.join(directory, "main.ts");
  mkdirSync(path.join(directory, "folder"));
  writeFileSync(path.join(directory, "helper.ts"), "export const helper = true;\n");
  writeFileSync(path.join(directory, "types.ts"), "export interface Thing {}\n");
  writeFileSync(path.join(directory, "folder/index.ts"), "export const value = true;\n");
  writeFileSync(path.join(directory, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  mkdirSync(path.join(directory, "data"));
  writeFileSync(path.join(directory, "data/package.json"), '{"name":"data"}\n');
  writeFileSync(path.join(directory, "2024.json"), '{"name":"year"}\n');
  writeFileSync(
    sourceFile,
    `import { name as packageName, version } from './package.json' with { type: 'json' };
import { name as dataName } from './data/package.json' with { type: 'json' };
import { name as yearName } from './2024.json' with { type: 'json' };
import { helper } from './helper';
import type { Thing } from './types';
import { value } from './folder';
import fs from 'node:fs';

console.log(packageName, version, dataName, yearName, helper, value, fs, null as Thing | null);
`,
  );

  const warnings = `(!) Your Vite config uses features that are unsupported by \`configLoader: 'native'\`, which is planned to become the default in a future major version of Vite:
  - named import from JSON module "./package.json" (main.ts:1:10). JSON modules only provide a default export per spec. Use the default import and access the property
  - named import from JSON module "./data/package.json" (main.ts:2:10). JSON modules only provide a default export per spec. Use the default import and access the property
  - named import from JSON module "./2024.json" (main.ts:3:10). JSON modules only provide a default export per spec. Use the default import and access the property
  - import "./helper" without a file extension (main.ts:4:24). Add the file extension
  - import "./types" without a file extension (main.ts:5:28). Add the file extension
  - import "./folder" resolves to a directory index (main.ts:6:23). Import the index file directly
Set \`VITE_CONFIG_NATIVE_IGNORE_WARNING=true\` to suppress this warning.
`;
  expect(parseWarningOutput(warnings)).toHaveLength(6);

  const result = spawnSync(process.execPath, [codemod, "--root", directory], {
    encoding: "utf8",
    input: warnings,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/Migrated 6 reported imports in 1 file/);
  expect(readFileSync(sourceFile, "utf8")).toBe(
    `import packageJson from './package.json' with { type: 'json' };
import packageJson2 from './data/package.json' with { type: 'json' };
import _2024Json from './2024.json' with { type: 'json' };
import { helper } from './helper.ts';
import type { Thing } from './types.ts';
import { value } from './folder/index.ts';
import fs from 'node:fs';

const { name: packageName, version } = packageJson;
const { name: dataName } = packageJson2;
const { name: yearName } = _2024Json;

console.log(packageName, version, dataName, yearName, helper, value, fs, null as Thing | null);
`,
  );

  const secondRun = spawnSync(process.execPath, [codemod, "--root", directory], {
    encoding: "utf8",
    input: warnings,
  });
  expect(secondRun.status, secondRun.stderr).toBe(0);
  expect(secondRun.stdout).toMatch(/already compatible with Vite native config loading/);
});
