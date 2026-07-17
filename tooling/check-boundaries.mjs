import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

const rules = [
  {
    directory: join(root, 'apps', 'runtime'),
    forbidden: [
      /^@intentcanvas\/studio(?:\/|$)/,
      /(?:^|\/)apps\/studio(?:\/|$)/,
      /(?:^|\/)packages\/protocol\/src(?:\/|$)/
    ],
    message: 'Runtime must not import Studio implementation.'
  },
  {
    directory: join(root, 'apps', 'studio'),
    forbidden: [/^@intentcanvas\/runtime(?:\/|$)/, /(?:^|\/)apps\/runtime(?:\/|$)/],
    message: 'Studio must not import Runtime implementation.'
  },
  {
    directory: join(root, 'packages', 'bridge'),
    forbidden: [/^@intentcanvas\/(?:runtime|studio|cli|code-facts|plan-diff)(?:\/|$)/],
    message: 'Bridge must remain a standalone transport package.'
  },
  {
    directory: join(root, 'packages', 'code-facts'),
    forbidden: [/^@intentcanvas\/(?:runtime|studio|cli|bridge|plan-diff)(?:\/|$)/],
    message: 'Code Facts extraction must remain independent of product implementations.'
  },
  {
    directory: join(root, 'packages', 'plan-diff'),
    forbidden: [/^@intentcanvas\/(?:runtime|studio|cli|bridge|code-facts)(?:\/|$)/],
    message: 'Plan Diff may depend on Protocol, not product implementations.'
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

function importedSpecifiers(source) {
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu
  ];
  const specifiers = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

const violations = [];
for (const rule of rules) {
  for (const file of await filesUnder(rule.directory)) {
    const source = await readFile(file, 'utf8');
    const imports = importedSpecifiers(source);
    if (imports.some((specifier) => rule.forbidden.some((pattern) => pattern.test(specifier)))) {
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

const studioPackage = JSON.parse(
  await readFile(join(root, 'apps', 'studio', 'package.json'), 'utf8')
);
if (studioPackage.dependencies !== undefined || studioPackage.devDependencies !== undefined) {
  violations.push('apps/studio/package.json: Studio must remain dependency free.');
}

for (const packageDirectory of ['bridge', 'code-facts']) {
  const manifest = JSON.parse(
    await readFile(join(root, 'packages', packageDirectory, 'package.json'), 'utf8')
  );
  if (manifest.dependencies !== undefined || manifest.devDependencies !== undefined) {
    violations.push(
      `packages/${packageDirectory}/package.json: ${packageDirectory} must remain dependency free.`
    );
  }
}

const planDiffPackage = JSON.parse(
  await readFile(join(root, 'packages', 'plan-diff', 'package.json'), 'utf8')
);
const planDiffDependencies = Object.keys(planDiffPackage.dependencies ?? {});
if (planDiffDependencies.length !== 1 ||
    planDiffPackage.dependencies?.['@intentcanvas/protocol'] !== 'workspace:*') {
  violations.push(
    'packages/plan-diff/package.json: Plan Diff may depend only on @intentcanvas/protocol as workspace:*.'
  );
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Architecture boundaries are intact.');
}
