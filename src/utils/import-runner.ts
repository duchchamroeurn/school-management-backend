// Shared runner for the JSON data imports (db:seed:students, db:seed:staff).
// 1. Validate every entry first (same rules as the API); if any is invalid, import nothing.
// 2. Skip entries whose unique key (birth certificate / national ID) is already registered.
// 3. Create the rest in file order through the normal service layer.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prisma } from '../lib/prisma';
import { HttpError } from './httpError';

export interface ImportConfig<Input, Created> {
  label: string; // e.g. "student"
  defaultFile: string; // e.g. "data/students.json"
  keyName: string; // unique field, e.g. "birthCertificateNo"
  toInput: (raw: Record<string, unknown>) => Input; // throws on invalid data
  keyOf: (input: Input) => string;
  findExisting: (keys: string[]) => Promise<Map<string, string>>; // key → description of existing record
  create: (input: Input) => Promise<Created>;
  describe: (created: Created) => string;
}

export async function runImport<Input, Created>(config: ImportConfig<Input, Created>) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const filePath = resolve(args.find((a) => !a.startsWith('--')) ?? config.defaultFile);

  try {
    let entries: unknown;
    try {
      entries = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new Error(`${filePath} could not be read as JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(entries)) throw new Error(`${filePath} must contain a JSON array`);
    console.log(`Read ${entries.length} ${config.label}(s) from ${filePath}${dryRun ? ' (dry run)' : ''}`);

    // 1. Validate everything before touching the database
    const problems: string[] = [];
    const valid: { line: string; input: Input }[] = [];
    const seenKeys = new Map<string, string>();
    entries.forEach((raw, i) => {
      const line = `#${i + 1} ${(raw as Record<string, unknown>)?.latinName ?? ''}`.trim();
      try {
        if (typeof raw !== 'object' || raw === null) throw new Error('must be an object');
        const input = config.toInput(raw as Record<string, unknown>);
        const key = config.keyOf(input);
        const twin = seenKeys.get(key);
        if (twin) throw new Error(`${config.keyName} ${key} is also used by ${twin}`);
        seenKeys.set(key, line);
        valid.push({ line, input });
      } catch (err) {
        problems.push(`  ✘ ${line}: ${(err as Error).message}`);
      }
    });
    if (problems.length) {
      console.error(`\n${problems.length} invalid entr${problems.length === 1 ? 'y' : 'ies'} — nothing imported:\n${problems.join('\n')}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ✓ all ${valid.length} entries are valid`);

    // 2. Skip records already registered
    const existing = await config.findExisting(valid.map((v) => config.keyOf(v.input)));
    const toCreate = valid.filter((v) => !existing.has(config.keyOf(v.input)));
    for (const v of valid.filter((v) => existing.has(config.keyOf(v.input)))) {
      console.log(`  – skip ${v.line}: already registered as ${existing.get(config.keyOf(v.input))}`);
    }
    if (dryRun) {
      console.log(`\nDry run: ${toCreate.length} would be created, ${existing.size} skipped.`);
      return;
    }

    // 3. Create in file order
    const failed: string[] = [];
    let created = 0;
    for (const { line, input } of toCreate) {
      try {
        console.log(`  + ${config.describe(await config.create(input))}`);
        created++;
      } catch (err) {
        failed.push(`  ✘ ${line}: ${err instanceof HttpError ? `${err.code} — ${err.message}` : (err as Error).message}`);
      }
    }
    console.log(`\nDone: ${created} created, ${existing.size} skipped (already registered), ${failed.length} failed.`);
    if (failed.length) {
      console.error(failed.join('\n'));
      process.exitCode = 1;
    }
  } catch (err) {
    console.error((err as Error).message ?? err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
