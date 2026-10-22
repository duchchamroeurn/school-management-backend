// Generates random demo announcements (ការជូនដំណឹង) into a JSON file for `npm run db:seed:announcements`.
// Roles, classes and authors are read from the database, so every generated entry is importable:
//   - authors: active logins holding MANAGE_ANNOUNCEMENTS (e.g. demo.principal, admin)
//   - roles:   every role (system and custom)
//   - classes: the class sections of the ACTIVE academic year
//
//   npm run demo:announcements:generate                          # 50 announcements → data/announcements.json
//   npm run demo:announcements:generate -- --count 1000
//   npm run demo:announcements:generate -- --count 200 --seed 42 --out data/my-announcements.json
//
// About 60% are active now, 20% scheduled (publish in the future) and 20% already expired.
// --seed makes the output repeatable.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PERMISSIONS } from '../constants/permissions';
import { AcademicYearStatus, AnnouncementAudience, AnnouncementPriority, UserStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';

const TEMPLATES = [
  { title: 'ការប្រឡងឆមាសទី១ / Semester 1 exams', body: 'ការប្រឡងឆមាសទី១ នឹងចាប់ផ្តើមនៅថ្ងៃទី១៥ ខែមករា។\nSemester 1 exams start on 15 January.' },
  { title: 'Staff meeting on Friday', body: 'All teachers: staff meeting at 4 pm in the library. Please bring your laptops.' },
  { title: 'Field Trip / ដំណើរកម្សាន្ត', body: 'Reminder: Field trip next Monday. Bring a signed permission slip.\nកុំភ្លេច៖ ដំណើរកម្សាន្តនៅថ្ងៃច័ន្ទសប្តាហ៍ក្រោយ។' },
  { title: 'School Closed for Public Holiday', body: 'The school will be closed this Friday for the national holiday.' },
  { title: 'Tuition Payment Reminder / ការរំលឹកការបង់ប្រាក់', body: 'Please ensure all monthly tuition fees are paid by the 5th.\nសូមបង់ប្រាក់ថ្លៃសិក្សាប្រចាំខែឲ្យបានមុនថ្ងៃទី៥។' },
  { title: 'Library Book Returns', body: 'All borrowed library books must be returned before the end of the semester.' },
  { title: 'Khmer New Year Celebration / ពិធីបុណ្យចូលឆ្នាំខ្មែរ', body: 'Join us for the school celebration on Wednesday afternoon! ចូលរួមអបអរសាទរទាំងអស់គ្នា!' },
  { title: 'System Maintenance', body: 'The school portal will be down for maintenance from midnight to 2 AM.' },
];

// ── Options ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const count = Number(option('count') ?? 50);
const seed = option('seed') !== undefined ? Number(option('seed')) : Date.now();
const outFile = resolve(option('out') ?? 'data/announcements.json');

// ── Repeatable randomness (mulberry32) ──────────────────────────────────
let state = seed >>> 0;
function random() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min: number, max: number) => Math.floor(random() * (max - min + 1)) + min;
const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
/** `n` different items, in random order; never modifies `items` */
function sample<T>(items: readonly T[], n: number) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

/** publishInDays / expiresInDays for one of three states; expiry is always after publishing */
function schedule(): { publishInDays: number; expiresInDays: number | null } {
  const r = random();
  if (r < 0.2) {
    // expired: published 15–60 days ago, expired 1–10 days ago
    return { publishInDays: -int(15, 60), expiresInDays: -int(1, 10) };
  }
  if (r < 0.4) {
    // scheduled: publishes in 1–14 days, runs 7–30 days (or no end)
    const publishInDays = int(1, 14);
    return { publishInDays, expiresInDays: random() < 0.2 ? null : publishInDays + int(7, 30) };
  }
  // active: published today or up to 10 days ago, expires in 5–60 days (or no end)
  return { publishInDays: -int(0, 10), expiresInDays: random() < 0.2 ? null : int(5, 60) };
}

async function main() {
  if (!Number.isInteger(count) || count < 1 || count > 10_000) throw new Error('--count must be a whole number between 1 and 10000');
  if (!Number.isFinite(seed)) throw new Error('--seed must be a number');

  const [authors, roles, classes] = await Promise.all([
    prisma.user.findMany({
      where: {
        status: UserStatus.ACTIVE,
        userRoles: { some: { role: { rolePermissions: { some: { permission: { code: PERMISSIONS.ANNOUNCEMENT.MANAGE } } } } } },
      },
      select: { username: true },
      orderBy: { username: 'asc' },
    }),
    prisma.role.findMany({ select: { latinName: true }, orderBy: { latinName: 'asc' } }),
    prisma.classSection.findMany({
      where: { academicYear: { status: AcademicYearStatus.ACTIVE } },
      select: { sectionName: true, grade: { select: { gradeNumber: true } } },
      orderBy: [{ grade: { gradeNumber: 'asc' } }, { sectionName: 'asc' }],
    }),
  ]);
  if (!authors.length) throw new Error('No active login holds MANAGE_ANNOUNCEMENTS — run npm run db:seed (and the demo) first');
  const authorNames = authors.map((a) => a.username);
  const roleNames = roles.map((r) => r.latinName);
  const classNames = classes.map((c) => `${c.grade.gradeNumber}${c.sectionName}`);
  // Without an ACTIVE year there are no classes to address
  const audiences = classNames.length
    ? [AnnouncementAudience.EVERYONE, AnnouncementAudience.ROLES, AnnouncementAudience.CLASSES]
    : [AnnouncementAudience.EVERYONE, AnnouncementAudience.ROLES];
  const priorities = [AnnouncementPriority.NORMAL, AnnouncementPriority.NORMAL, AnnouncementPriority.NORMAL, AnnouncementPriority.IMPORTANT];

  const announcements = Array.from({ length: count }, (_, i) => {
    const template = pick(TEMPLATES);
    const audience = pick(audiences);
    return {
      title: `${template.title} #${i + 1}`,
      body: template.body,
      priority: pick(priorities),
      pinned: random() < 0.2,
      audience,
      ...(audience === AnnouncementAudience.ROLES && { roles: sample(roleNames, int(1, 3)) }),
      ...(audience === AnnouncementAudience.CLASSES && { classes: sample(classNames, int(1, 4)) }),
      author: pick(authorNames),
      ...schedule(),
    };
  });

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ announcements }, null, 2) + '\n', 'utf8');

  const tally = (f: (a: (typeof announcements)[number]) => boolean) => announcements.filter(f).length;
  console.log(`Wrote ${count} announcements to ${outFile} (seed ${seed})`);
  console.log(`  authors: ${authorNames.join(', ')}`);
  console.log(`  roles:   ${roleNames.join(', ')}`);
  console.log(`  classes: ${classNames.join(', ') || '(none — no ACTIVE academic year)'}`);
  console.log(
    `  active ${tally((a) => a.publishInDays <= 0 && (a.expiresInDays === null || a.expiresInDays > 0))}, ` +
      `scheduled ${tally((a) => a.publishInDays > 0)}, expired ${tally((a) => a.expiresInDays !== null && a.expiresInDays <= 0)} · ` +
      `important ${tally((a) => a.priority === AnnouncementPriority.IMPORTANT)}, pinned ${tally((a) => a.pinned)}`,
  );
  console.log('Import it with: npm run db:seed:announcements');
}

main()
  .catch((err) => {
    console.error(`✘ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
