// Imports announcements (ការជូនដំណឹង) from a JSON file (default: data/announcements.json), through the same
// service as POST /announcements. Generate a demo file with `npm run demo:announcements:generate`.
//
//   npm run db:seed:announcements                       # validate + import
//   npm run db:seed:announcements -- --dry-run          # validate only
//   npm run db:seed:announcements -- path/to/file.json
//
// Entry: { title, body, priority?, pinned?, audience, roles?, classes?, author?, publishInDays?, expiresInDays? }
//   roles   — role names (audience ROLES), e.g. ["Teacher", "Registrar"]
//   classes — class names in the ACTIVE academic year (audience CLASSES), e.g. ["7A", "8B"]
//   author  — a username holding MANAGE_ANNOUNCEMENTS (default "admin")
//   publishInDays / expiresInDays — days from now (negative = in the past); expiresInDays null = never expires
// Announcements whose title already exists are skipped, so it can be re-run.
import { PERMISSIONS } from '../constants/permissions';
import { MAX_BODY_LENGTH } from '../controllers/announcement.controller';
import { AcademicYearStatus, AnnouncementAudience, AnnouncementPriority, UserStatus } from '../generated/prisma/client';
import { prisma } from '../lib/prisma';
import { AnnouncementInput, createAnnouncement } from '../services/announcement.service';
import { runImport } from './import-runner';
import { optionalBoolean, optionalEnum, optionalString, optionalStringArray, optionalText, required } from './validate';

const DAY_MS = 86_400_000;
const MAX_DAYS = 3650;

type ImportedAnnouncement = AnnouncementInput & { authorId: string; authorName: string };

function days(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || Math.abs(value as number) > MAX_DAYS) throw new Error(`${field} must be a whole number of days (±${MAX_DAYS})`);
  return value as number;
}

async function main() {
  // Names in the file → database ids, loaded once (toInput must be synchronous)
  const [authors, roles, classes] = await Promise.all([
    prisma.user.findMany({
      where: {
        status: UserStatus.ACTIVE,
        userRoles: { some: { role: { rolePermissions: { some: { permission: { code: PERMISSIONS.ANNOUNCEMENT.MANAGE } } } } } },
      },
      select: { id: true, username: true },
    }),
    prisma.role.findMany({ select: { id: true, latinName: true } }),
    prisma.classSection.findMany({
      where: { academicYear: { status: AcademicYearStatus.ACTIVE } },
      select: { id: true, sectionName: true, grade: { select: { gradeNumber: true } } },
    }),
  ]);
  const authorIds = new Map(authors.map((a) => [a.username, a.id]));
  const roleIds = new Map(roles.map((r) => [r.latinName.toLowerCase(), r.id]));
  const classIds = new Map(classes.map((c) => [`${c.grade.gradeNumber}${c.sectionName}`.toUpperCase(), c.id]));
  const now = Date.now();

  const resolveAll = (names: string[], ids: Map<string, string>, normalise: (n: string) => string, what: string) => {
    const unknown = names.filter((n) => !ids.has(normalise(n)));
    if (unknown.length) throw new Error(`unknown ${what}: ${unknown.join(', ')} (known: ${[...ids.keys()].join(', ') || 'none'})`);
    return names.map((n) => ids.get(normalise(n))!);
  };

  await runImport<ImportedAnnouncement, Awaited<ReturnType<typeof createAnnouncement>>>({
    label: 'announcement',
    defaultFile: 'data/announcements.json',
    keyName: 'title',
    entriesOf: (json) => (Array.isArray(json) ? json : (json as { announcements?: unknown })?.announcements),
    labelOf: (raw) => String(raw.title ?? ''),
    toInput: (raw) => {
      const audience = required(optionalEnum(raw.audience, 'audience', Object.values(AnnouncementAudience)), 'audience');
      const authorName = optionalString(raw.author, 'author') ?? 'admin';
      const authorId = authorIds.get(authorName);
      if (!authorId) throw new Error(`author "${authorName}" is not an active login with MANAGE_ANNOUNCEMENTS`);

      const roleNames = optionalStringArray(raw.roles, 'roles');
      const classNames = optionalStringArray(raw.classes, 'classes');
      if (audience !== AnnouncementAudience.ROLES && roleNames) throw new Error('roles is only for audience ROLES');
      if (audience !== AnnouncementAudience.CLASSES && classNames) throw new Error('classes is only for audience CLASSES');
      if (audience === AnnouncementAudience.ROLES && !roleNames?.length) throw new Error('audience ROLES needs at least one role in roles');
      if (audience === AnnouncementAudience.CLASSES && !classNames?.length) throw new Error('audience CLASSES needs at least one class in classes');

      const publishInDays = days(raw.publishInDays, 'publishInDays') ?? 0;
      const expiresInDays = days(raw.expiresInDays, 'expiresInDays');
      if (expiresInDays !== undefined && expiresInDays <= publishInDays) throw new Error('expiresInDays must be after publishInDays');

      return {
        title: required(optionalString(raw.title, 'title', 150), 'title'),
        body: required(optionalText(raw.body, 'body', MAX_BODY_LENGTH), 'body'),
        priority: optionalEnum(raw.priority, 'priority', Object.values(AnnouncementPriority)),
        pinned: optionalBoolean(raw.pinned, 'pinned'),
        audience,
        roleIds: roleNames && resolveAll(roleNames, roleIds, (n) => n.toLowerCase(), 'role(s)'),
        classSectionIds: classNames && resolveAll(classNames, classIds, (n) => n.toUpperCase(), 'class(es) in the ACTIVE year'),
        publishAt: new Date(now + publishInDays * DAY_MS),
        expiresAt: expiresInDays === undefined ? null : new Date(now + expiresInDays * DAY_MS),
        authorId,
        authorName,
      };
    },
    keyOf: (input) => input.title,
    findExisting: async (titles) =>
      new Map(
        (await prisma.announcement.findMany({ where: { title: { in: titles } }, select: { title: true, publishAt: true } })).map((a) => [
          a.title,
          `an announcement published ${a.publishAt.toISOString().slice(0, 10)}`,
        ]),
      ),
    create: ({ authorId, authorName: _authorName, ...input }) => createAnnouncement(authorId, input),
    describe: (a) => `${a.title}  [${a.audience}${a.priority === AnnouncementPriority.IMPORTANT ? ', IMPORTANT' : ''}${a.pinned ? ', pinned' : ''}]`,
  });
}

main();
