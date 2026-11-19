#!/usr/bin/env node
// Repository checks that run in CI (and can be run locally: `node .github/scripts/check.mjs`).
// No dependencies — plain Node only.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let failures = 0;

const ok = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg) => { failures++; console.error(`  FAIL  ${msg}`); };
const section = (name) => console.log(`\n${name}`);

function read(rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

/* ---- 1. manifest.json ---- */
section('manifest.json');

let manifest = null;
const rawManifest = read('manifest.json');
if (!rawManifest) {
  fail('manifest.json is missing');
} else {
  try {
    manifest = JSON.parse(rawManifest);
    ok('valid JSON');
  } catch (e) {
    fail(`invalid JSON — ${e.message}`);
  }
}

if (manifest) {
  if (manifest.manifest_version === 3) ok('manifest_version is 3');
  else fail(`manifest_version is ${manifest.manifest_version}, expected 3`);

  if (typeof manifest.name === 'string' && manifest.name.trim()) ok(`name: ${manifest.name}`);
  else fail('name is missing');

  if (/^\d+\.\d+\.\d+$/.test(manifest.version || '')) ok(`version: ${manifest.version}`);
  else fail(`version "${manifest.version}" is not semver x.y.z`);

  if (typeof manifest.description === 'string' && manifest.description.trim()) ok('description present');
  else fail('description is missing');

  // Every file the manifest points at must exist in the repo.
  const referenced = new Set();
  if (manifest.background?.service_worker) referenced.add(manifest.background.service_worker);
  if (manifest.options_page) referenced.add(manifest.options_page);
  for (const v of Object.values(manifest.action?.default_icon || {})) referenced.add(v);
  for (const v of Object.values(manifest.icons || {})) referenced.add(v);
  for (const cs of manifest.content_scripts || []) {
    for (const f of cs.js || []) referenced.add(f);
    for (const f of cs.css || []) referenced.add(f);
  }

  for (const file of referenced) {
    if (existsSync(join(root, file))) ok(`referenced file exists: ${file}`);
    else fail(`referenced file is missing: ${file}`);
  }
}

/* ---- 2. version consistency across READMEs ---- */
section('version consistency');

if (manifest?.version) {
  for (const readme of ['README.md', 'README.zh-CN.md']) {
    const text = read(readme);
    if (text == null) { fail(`${readme} is missing`); continue; }
    const m = text.match(/badge\/version-([0-9]+\.[0-9]+\.[0-9]+)-/);
    if (!m) fail(`${readme} has no version badge`);
    else if (m[1] === manifest.version) ok(`${readme} badge matches ${manifest.version}`);
    else fail(`${readme} badge says ${m[1]}, manifest says ${manifest.version}`);
  }

  const changelog = read('CHANGELOG.md');
  if (changelog == null) fail('CHANGELOG.md is missing');
  else if (changelog.includes(`## [${manifest.version}]`)) ok(`CHANGELOG.md has a ${manifest.version} section`);
  else fail(`CHANGELOG.md has no "## [${manifest.version}]" section`);
}

/* ---- 3. source syntax ---- */
section('source syntax');

for (const file of ['content.js', 'background.js', 'options.js']) {
  const text = read(file);
  if (text == null) { fail(`${file} is missing`); continue; }
  try {
    // Compile without executing — equivalent to `node --check`.
    new vm.Script(text, { filename: file });
    ok(`${file} parses`);
  } catch (e) {
    fail(`${file} — ${e.message}`);
  }
}

section(failures ? `FAILED (${failures} problem${failures === 1 ? '' : 's'})` : 'ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
