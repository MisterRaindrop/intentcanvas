import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

const rules = [
  {
    directory: join(root, 'apps', 'runtime'),
    forbidden: [
      /@intentcanvas\/studio/,
      /from\s+['"][^'"]*apps\/studio/,
      /from\s+['"][^'"]*packages\/protocol\/src/
    ],
    message: 'Runtime must not import Studio implementation.'
  },
  {
    directory: join(root, 'apps', 'studio'),
    forbidden: [/@intentcanvas\/runtime/, /from\s+['"][^'"]*apps\/runtime/],
    message: 'Studio must not import Runtime implementation.'
  }
];

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (['.js', '.mjs', '.ts', '.tsx'].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

const violations = [];
for (const rule of rules) {
  for (const file of await filesUnder(rule.directory)) {
    const source = await readFile(file, 'utf8');
    if (rule.forbidden.some((pattern) => pattern.test(source))) {
      violations.push(`${file}: ${rule.message}`);
    }
  }
}

const runtimePackage = JSON.parse(
  await readFile(join(root, 'apps', 'runtime', 'package.json'), 'utf8')
);
if (runtimePackage.dependencies?.['@intentcanvas/protocol'] !== 'workspace:*') {
  violations.push(
    'apps/runtime/package.json: Runtime must declare @intentcanvas/protocol as workspace:*.'
  );
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Architecture boundaries are intact.');
}
