/** Check production dependency direction, without imposing arbitrary file-size limits. */
import { readdir, readFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// esbuild is owned by the extension workspace; do not rely on npm hoisting.
const { build } = createRequire(new URL('../../extension/package.json', import.meta.url))('esbuild');

const sourceRoots = ['agent/src', 'extension/src', 'shared'];

const inside = (file, dir) => file.startsWith(`${dir}/`);

const surfaces = ['sidepanel', 'background', 'content'];

const extensionSurface = file => [...surfaces, 'shared'].find(area => inside(file, `extension/src/${area}`));

export async function dependencyViolations(file, source) {
  // Use the same parser as the extension build. Type-only imports are erased and
  // deliberately excluded: this check protects executable host boundaries.
  const result = await build({
    stdin: {
      contents: source,
      sourcefile: file,
      loader: file.endsWith('.tsx') ? 'tsx' : /\.[cm]?ts$/.test(file) ? 'ts' : 'js',
    },
    bundle: true,
    external: ['*'],
    write: false,
    metafile: true,
    platform: 'neutral',
    format: 'esm',
    logLevel: 'silent',
  });

  const violations = [];

  function check(specifier) {
    const target = specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)) : null;
    const sourceSurface = extensionSurface(file);
    const targetSurface = target && extensionSurface(target);
    let reason;

    if (path.posix.isAbsolute(specifier) || path.win32.isAbsolute(specifier) || specifier.startsWith('file:')) reason = 'production imports must not depend on absolute machine paths';
    else if (target && inside(file, 'shared') && !inside(target, 'shared')) reason = 'shared must not depend on host implementations';
    else if (target && inside(file, 'agent/src') && inside(target, 'extension')) reason = 'agent must communicate with extension through shared contracts';
    else if (target && inside(file, 'extension/src') && inside(target, 'agent')) reason = 'extension must communicate with agent through shared contracts';
    else if (inside(file, 'extension/src') && specifier.startsWith('@sideagent/agent')
      && !(inside(file, 'extension/src/inproc') && specifier === '@sideagent/agent/browser-core')) reason = 'extension may use only the browser core package API from inproc';
    else if (sourceSurface && targetSurface && surfaces.includes(targetSurface) && sourceSurface !== targetSurface) reason = 'extension surfaces communicate through relay/contracts, not implementation imports';
    else if (target && !sourceRoots.some(root => inside(target, root))) reason = 'production must not import tests, scripts or generated artifacts';
    else if ((inside(file, 'shared') || inside(file, 'extension/src')) && isBuiltin(specifier)) reason = 'Node-only implementation belongs in agent';

    if (reason) violations.push(`${file}: ${specifier} — ${reason}`);
  }

  for (const input of Object.values(result.metafile.inputs)) {
    for (const dependency of input.imports) check(dependency.path);
  }

  return violations;
}

async function filesUnder(directory) {
  const files = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);

    if (entry.isDirectory()) files.push(...await filesUnder(name));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) files.push(name);
  }

  return files;
}

export async function checkBoundaries(root) {
  const failures = [];
  let files = 0;

  for (const dir of sourceRoots) {
    for (const filename of await filesUnder(path.join(root, dir))) {
      files++;
      failures.push(...await dependencyViolations(path.relative(root, filename).split(path.sep).join('/'), await readFile(filename, 'utf8')));
    }
  }

  return { files, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = await checkBoundaries(root);

  if (result.failures.length) {
    console.error(result.failures.join('\n'));
    process.exitCode = 1;
  } else console.log(`Architecture boundaries: ${result.files} production files passed.`);
}
