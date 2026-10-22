// Downloads Cambodia's gazetteer (provinces, districts, communes, villages with official NCDD codes) from the
// open Pumi API (https://github.com/dwilkie/pumi, MIT licence; data from the NCDD gazetteer) and writes it in
// the format `npm run db:seed:gazetteer` imports.
//
//   npm run gazetteer:download                                   # → data/gazetteer.json
//   npm run gazetteer:download -- --out data/gazetteer-2026.json
//   npm run gazetteer:download -- --source https://pumi.example.org/pumi
//
// Only needed when installing or when the official gazetteer changes; the server never calls the internet.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const source = (option('source') ?? 'https://pumi.onrender.com/pumi').replace(/\/+$/, '');
const outFile = resolve(option('out') ?? 'data/gazetteer.json');

// Pumi's administrative unit (English name) → our type
const TYPES: Record<string, string> = {
  Province: 'PROVINCE',
  Capital: 'CAPITAL',
  District: 'DISTRICT',
  Municipality: 'MUNICIPALITY',
  Section: 'KHAN',
  Commune: 'COMMUNE',
  Quarter: 'SANGKAT',
  Village: 'VILLAGE',
};

interface PumiLocation {
  id: string;
  name_km: string;
  name_en?: string | null;
  name_latin?: string | null;
  name_ungegn?: string | null;
  administrative_unit: { name_en: string };
}

const missingLatin: string[] = [];

async function download(level: string) {
  process.stdout.write(`  ${level}… `);
  // The free host may need a minute to wake up
  const res = await fetch(`${source}/${level}`, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`${source}/${level} answered ${res.status} ${res.statusText}`);
  const rows = (await res.json()) as PumiLocation[];
  if (!Array.isArray(rows) || !rows.length) throw new Error(`${source}/${level} returned no ${level}`);
  console.log(rows.length);
  return rows.map((row) => {
    const type = TYPES[row.administrative_unit?.name_en];
    if (!type) throw new Error(`${level} ${row.id}: unknown administrative unit "${row.administrative_unit?.name_en}"`);
    // A few places have no romanised name in the source: say so in the name, and list them to check
    let latinName = [row.name_en, row.name_latin, row.name_ungegn].map((n) => n?.trim()).find(Boolean);
    if (!latinName) {
      latinName = `(no Latin name) ${row.id}`;
      missingLatin.push(`${row.id} ${row.name_km}`);
    }
    return { code: row.id, ...(type !== 'VILLAGE' && { type }), khmerName: row.name_km?.trim(), latinName };
  });
}

async function main() {
  console.log(`Downloading the gazetteer from ${source}`);
  const [provinces, districts, communes, villages] = [
    await download('provinces'),
    await download('districts'),
    await download('communes'),
    await download('villages'),
  ];
  mkdirSync(dirname(outFile), { recursive: true });
  const file = { source, downloadedAt: new Date().toISOString(), provinces, districts, communes, villages };
  writeFileSync(outFile, JSON.stringify(file, null, 1) + '\n', 'utf8');
  console.log(`Wrote ${outFile}`);
  if (missingLatin.length) {
    console.log(`⚠ ${missingLatin.length} place(s) have no Latin name in the source; set "latinName" in the file if you know it:\n  ${missingLatin.join('\n  ')}`);
  }
  console.log('Import it with: npm run db:seed:gazetteer');
}

main().catch((err) => {
  console.error(`✘ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
