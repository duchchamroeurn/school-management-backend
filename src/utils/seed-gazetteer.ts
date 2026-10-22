// Imports the gazetteer (ខេត្ត/រាជធានី › ស្រុក/ក្រុង/ខណ្ឌ › ឃុំ/សង្កាត់ › ភូមិ) from a JSON file (default:
// data/gazetteer.json). Get the official one with `npm run gazetteer:download`.
//
//   npm run db:seed:gazetteer                        # validate + import
//   npm run db:seed:gazetteer -- --dry-run           # validate only, show what would change
//   npm run db:seed:gazetteer -- path/to/file.json
//
// File: { provinces: [...], districts: [...], communes: [...], villages: [...] }, each entry
//   { code, type, khmerName, latinName }   — names without the prefix ("ភ្នំពេញ", not "រាជធានីភ្នំពេញ")
//   codes:  province 2 digits · district 4 · commune 6 · village 8, each starting with its parent's code
//   types:  province PROVINCE|CAPITAL · district DISTRICT|MUNICIPALITY|KHAN · commune COMMUNE|SANGKAT · village (none)
//
// Re-running it with a newer file adds new places and renames changed ones. Places missing from the file are
// kept (students may live there) and listed, so they can be checked.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CommuneType, DistrictType, ProvinceType } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';

const LEVELS = [
  { key: 'provinces', label: 'province', digits: 2, types: Object.values(ProvinceType) as string[], parent: undefined },
  { key: 'districts', label: 'district', digits: 4, types: Object.values(DistrictType) as string[], parent: 'provinces' },
  { key: 'communes', label: 'commune', digits: 6, types: Object.values(CommuneType) as string[], parent: 'districts' },
  { key: 'villages', label: 'village', digits: 8, types: [] as string[], parent: 'communes' },
] as const;
type LevelKey = (typeof LEVELS)[number]['key'];

interface Place {
  code: string;
  parentCode?: string;
  type?: string;
  khmerName: string;
  latinName: string;
}

const KHMER = /[ក-៿]/;
const CHUNK = 2000;

// Each level's table, with the parent column under one name
const table = {
  provinces: {
    findAll: () => prisma.province.findMany(),
    createMany: (rows: Place[]) => prisma.province.createMany({ data: rows.map(({ code, type, khmerName, latinName }) => ({ code, type: type as ProvinceType, khmerName, latinName })) }),
    update: (p: Place) => prisma.province.update({ where: { code: p.code }, data: { type: p.type as ProvinceType, khmerName: p.khmerName, latinName: p.latinName } }),
    parentOf: () => undefined,
  },
  districts: {
    findAll: () => prisma.district.findMany(),
    createMany: (rows: Place[]) =>
      prisma.district.createMany({ data: rows.map((p) => ({ code: p.code, provinceCode: p.parentCode!, type: p.type as DistrictType, khmerName: p.khmerName, latinName: p.latinName })) }),
    update: (p: Place) => prisma.district.update({ where: { code: p.code }, data: { type: p.type as DistrictType, khmerName: p.khmerName, latinName: p.latinName } }),
    parentOf: (row: { provinceCode: string }) => row.provinceCode,
  },
  communes: {
    findAll: () => prisma.commune.findMany(),
    createMany: (rows: Place[]) =>
      prisma.commune.createMany({ data: rows.map((p) => ({ code: p.code, districtCode: p.parentCode!, type: p.type as CommuneType, khmerName: p.khmerName, latinName: p.latinName })) }),
    update: (p: Place) => prisma.commune.update({ where: { code: p.code }, data: { type: p.type as CommuneType, khmerName: p.khmerName, latinName: p.latinName } }),
    parentOf: (row: { districtCode: string }) => row.districtCode,
  },
  villages: {
    findAll: () => prisma.village.findMany(),
    createMany: (rows: Place[]) => prisma.village.createMany({ data: rows.map((p) => ({ code: p.code, communeCode: p.parentCode!, khmerName: p.khmerName, latinName: p.latinName })) }),
    update: (p: Place) => prisma.village.update({ where: { code: p.code }, data: { khmerName: p.khmerName, latinName: p.latinName } }),
    parentOf: (row: { communeCode: string }) => row.communeCode,
  },
} as const;

function validate(json: unknown) {
  const problems: string[] = [];
  const places = {} as Record<LevelKey, Place[]>;
  const codes = {} as Record<LevelKey, Set<string>>;

  for (const level of LEVELS) {
    const entries = (json as Record<string, unknown> | null)?.[level.key];
    places[level.key] = [];
    codes[level.key] = new Set();
    if (!Array.isArray(entries) || !entries.length) {
      problems.push(`"${level.key}" must be a non-empty array`);
      continue;
    }
    entries.forEach((raw: Record<string, unknown>, i) => {
      const where = `${level.key}[${i}]${typeof raw?.code === 'string' ? ` ${raw.code}` : ''}`;
      const fail = (msg: string) => problems.push(`  ✘ ${where}: ${msg}`);
      if (typeof raw !== 'object' || raw === null) return fail('must be an object');
      const { code, type, khmerName, latinName } = raw;
      if (typeof code !== 'string' || !new RegExp(`^\\d{${level.digits}}$`).test(code)) return fail(`code must be ${level.digits} digits`);
      if (codes[level.key].has(code)) return fail('code appears twice');
      if (level.types.length && (typeof type !== 'string' || !level.types.includes(type))) return fail(`type must be one of ${level.types.join(', ')}`);
      if (typeof khmerName !== 'string' || !KHMER.test(khmerName) || khmerName.trim().length > 100) return fail('khmerName must be Khmer text (at most 100 characters)');
      if (typeof latinName !== 'string' || !latinName.trim() || latinName.trim().length > 100) return fail('latinName must be text (at most 100 characters)');
      const parentCode = level.parent ? code.slice(0, level.digits - 2) : undefined;
      if (level.parent && !codes[level.parent].has(parentCode!)) return fail(`its ${level.parent.slice(0, -1)} ${parentCode} is not in the file`);
      codes[level.key].add(code);
      places[level.key].push({ code, parentCode, type: level.types.length ? (type as string) : undefined, khmerName: khmerName.trim(), latinName: latinName.trim() });
    });
  }
  return { places, problems };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const filePath = resolve(args.find((a) => !a.startsWith('--')) ?? 'data/gazetteer.json');

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`${filePath} could not be read as JSON: ${(err as Error).message}\nDownload the gazetteer first: npm run gazetteer:download`);
  }
  const { places, problems } = validate(json);
  if (problems.length) {
    const shown = problems.slice(0, 50);
    throw new Error(`${problems.length} problem(s) in ${filePath} — nothing imported:\n${shown.join('\n')}${problems.length > 50 ? '\n  …' : ''}`);
  }
  console.log(
    `Read ${filePath}${dryRun ? ' (dry run)' : ''}: ` + LEVELS.map((l) => `${places[l.key].length} ${l.key}`).join(', '),
  );

  // Parents first, so every new row's parent already exists
  for (const level of LEVELS) {
    const t = table[level.key];
    const existing = new Map((await t.findAll()).map((row) => [row.code, row as Record<string, unknown>]));
    const fresh = places[level.key].filter((p) => !existing.has(p.code));
    const changed = places[level.key].filter((p) => {
      const row = existing.get(p.code);
      return row && (row.khmerName !== p.khmerName || row.latinName !== p.latinName || (p.type !== undefined && row.type !== p.type));
    });
    const moved = places[level.key].filter((p) => {
      const row = existing.get(p.code);
      return row && p.parentCode !== undefined && t.parentOf(row as never) !== p.parentCode;
    });
    if (moved.length) throw new Error(`${moved.length} ${level.key} would move to another parent (e.g. ${moved[0].code}); codes are expected to be stable`);
    const inFile = new Set(places[level.key].map((p) => p.code));
    const notInFile = [...existing.keys()].filter((code) => !inFile.has(code));

    if (!dryRun) {
      for (let i = 0; i < fresh.length; i += CHUNK) await t.createMany(fresh.slice(i, i + CHUNK));
      for (const p of changed) await t.update(p);
    }
    console.log(
      `  ${dryRun ? '~' : '✓'} ${level.key}: ${fresh.length} new, ${changed.length} renamed, ${places[level.key].length - fresh.length - changed.length} unchanged` +
        (notInFile.length ? ` · ${notInFile.length} in the database but not in the file (kept): ${notInFile.slice(0, 10).join(', ')}${notInFile.length > 10 ? ', …' : ''}` : ''),
    );
  }
  console.log(dryRun ? '\nDry run: nothing was changed.' : '\nGazetteer imported.');
}

main()
  .catch((err) => {
    console.error(`✘ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
