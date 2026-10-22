// One command to install a complete demo school for a given school level:
//
//   npm run demo:install -- --level lower      # អនុវិទ្យាល័យ, grades 7–9
//   npm run demo:install -- --level upper      # វិទ្យាល័យ, grades 10–12
//   npm run demo:install -- --level combined   # grades 7–12 (default)
//   (shortcuts: npm run demo:install:lower | demo:install:upper | demo:install:combined)
//
// Steps: base seed → gazetteer (downloaded and imported if the database has none) → clear previous demo → level COMBINED (only adds grades, so never blocked, and
// widest age range for importing) → import data/students.json (missing photos, birth certificate scans and
// villages get demo placeholders) + data/staff.json → switch to the
// requested level → build the demo school. Re-runnable; refuses to run with NODE_ENV=production.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LEVEL_LABEL } from '../constants/school-levels';
import { SchoolLevel } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { updateSchoolSettings } from '../services/school-settings.service';
import { HttpError } from './httpError';

const ROOT = resolve(__dirname, '../..');

const LEVEL_ALIASES: Record<string, SchoolLevel> = {
  lower: SchoolLevel.LOWER_SECONDARY,
  upper: SchoolLevel.UPPER_SECONDARY,
  combined: SchoolLevel.COMBINED,
  lower_secondary: SchoolLevel.LOWER_SECONDARY,
  upper_secondary: SchoolLevel.UPPER_SECONDARY,
};

function parseLevel(): SchoolLevel {
  const args = process.argv.slice(2);
  const flag = args.find((a) => a.startsWith('--level'));
  const raw = flag?.includes('=') ? flag.split('=')[1] : flag ? args[args.indexOf(flag) + 1] : 'combined';
  const level = LEVEL_ALIASES[(raw ?? '').toLowerCase()];
  if (!level) throw new Error(`--level must be one of: lower, upper, combined (got "${raw}")`);
  return level;
}

function run(step: string, script: string, ...args: string[]) {
  console.log(`\n▶ ${step}`);
  const result = spawnSync('npx', ['tsx', `src/utils/${script}`, ...args], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Step failed: ${step}`);
}

async function setLevel(step: string, level: SchoolLevel) {
  console.log(`\n▶ ${step}`);
  try {
    const { gradesAdded, gradesRemoved } = await updateSchoolSettings({ level });
    console.log(
      `  ✓ ${LEVEL_LABEL[level]}` +
        (gradesAdded.length ? ` · grades added: ${gradesAdded.join(', ')}` : '') +
        (gradesRemoved.length ? ` · grades removed: ${gradesRemoved.join(', ')}` : ''),
    );
  } catch (err) {
    // Only non-demo classes can block this (demo classes were cleared first)
    if (err instanceof HttpError) throw new Error(`${err.code}: ${err.message} — these classes are not demo data, remove them first`);
    throw err;
  }
}

// Students need villages for their addresses: import the gazetteer once (downloading it if there is no file)
async function ensureGazetteer(step: string) {
  if ((await prisma.village.count()) > 0) {
    console.log(`\n▶ ${step}\n  ✓ already imported`);
    return;
  }
  if (!existsSync(resolve(ROOT, 'data/gazetteer.json'))) run(`${step}: download`, 'download-gazetteer.ts');
  run(`${step}: import`, 'seed-gazetteer.ts');
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to install demo data with NODE_ENV=production');
  const level = parseLevel();
  console.log(`Installing demo school: ${LEVEL_LABEL[level]}`);

  run('1/7 Base data (permissions, roles, settings, subjects, admin)', 'seed.ts');
  await ensureGazetteer('2/7 Gazetteer (provinces, districts, communes, villages)');
  run('3/7 Clear previous demo data', 'seed-demo.ts', '--reset', '--confirm', '--clear');
  await setLevel('4/7 Temporarily COMBINED (all grades) for importing', SchoolLevel.COMBINED);
  // Students without documents or village codes in the file get demo placeholders
  run('5/7 Import students (data/students.json)', 'seed-students.ts', '--demo-placeholders');
  run('5/7 Import staff (data/staff.json)', 'seed-staff.ts');
  await setLevel(`6/7 Switch to ${level}`, level);
  run('7/7 Build demo school', 'seed-demo.ts');

  console.log(`\n✅ Demo installed: ${LEVEL_LABEL[level]}. Log in as demo.principal / demo.registrar / demo.teacher (password above).`);
}

main()
  .catch((err) => {
    console.error(`\n✘ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
