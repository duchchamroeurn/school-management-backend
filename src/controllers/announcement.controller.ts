import { Request, Response } from 'express';
import { Errors } from '../constants/errors';
import { PERMISSIONS } from '../constants/permissions';
import { AnnouncementAudience, AnnouncementPriority } from '../generated/prisma/client';
import * as announcementService from '../services/announcement.service';
import { bodyOf, optionalBoolean, optionalDateTime, optionalEnum, optionalString, optionalStringArray, pagination, queryString, required } from '../utils/validate';

const STATUSES = ['SCHEDULED', 'ACTIVE', 'EXPIRED'] as const;

// Plain text up to 5000 characters; inner line breaks are kept, outer spaces trimmed
function optionalBody(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw Errors.INVALID_FIELD('body', 'must be a non-empty string');
  if (value.trim().length > 5000) throw Errors.INVALID_FIELD('body', 'must be at most 5000 characters');
  return value.trim();
}

const nullableDateTime = (value: unknown, field: string) => (value === null || value === '' ? null : optionalDateTime(value, field));

function input(body: Record<string, unknown>) {
  return {
    title: optionalString(body.title, 'title', 150),
    body: optionalBody(body.body),
    priority: optionalEnum(body.priority, 'priority', Object.values(AnnouncementPriority)),
    pinned: optionalBoolean(body.pinned, 'pinned'),
    audience: optionalEnum(body.audience, 'audience', Object.values(AnnouncementAudience)),
    roleIds: optionalStringArray(body.roleIds, 'roleIds'),
    classSectionIds: optionalStringArray(body.classSectionIds, 'classSectionIds'),
    publishAt: optionalDateTime(body.publishAt, 'publishAt'),
    expiresAt: nullableDateTime(body.expiresAt, 'expiresAt'),
  };
}

const pageMeta = (page: number, pageSize: number, total: number) => ({ page, pageSize, total, totalPages: Math.ceil(total / pageSize) });

// GET /api/v1/announcements/feed?page=&pageSize= — any signed-in user: the announcements for them, with `read`
export async function feed(req: Request, res: Response) {
  const { page, pageSize, skip, take } = pagination(req.query, 50);
  const { items, total } = await announcementService.listFeed(req.user!.id, { skip, take });
  res.json({ status: 'success', data: items, meta: pageMeta(page, pageSize, total) });
}

// GET /api/v1/announcements/feed/unread-count
export async function unreadCount(req: Request, res: Response) {
  res.json({ status: 'success', data: { unread: await announcementService.countUnread(req.user!.id) } });
}

// POST /api/v1/announcements/feed/read-all
export async function readAll(req: Request, res: Response) {
  res.json({ status: 'success', data: await announcementService.markAllRead(req.user!.id) });
}

// POST /api/v1/announcements/:id/read — only an announcement the user can see
export async function read(req: Request<{ id: string }>, res: Response) {
  await announcementService.markRead(req.user!.id, req.params.id);
  res.status(204).end();
}

// GET /api/v1/announcements?status=SCHEDULED|ACTIVE|EXPIRED&page=&pageSize= — MANAGE_ANNOUNCEMENTS
export async function list(req: Request, res: Response) {
  const { page, pageSize, skip, take } = pagination(req.query);
  const status = optionalEnum(queryString(req.query.status, 'status'), 'status', STATUSES);
  const { items, total } = await announcementService.listAll({ status, skip, take });
  res.json({ status: 'success', data: items, meta: pageMeta(page, pageSize, total) });
}

// GET /api/v1/announcements/:id — one the user can see, or any with MANAGE_ANNOUNCEMENTS
export async function get(req: Request<{ id: string }>, res: Response) {
  const viewer = { userId: req.user!.id, canManage: req.user!.permissions.includes(PERMISSIONS.ANNOUNCEMENT.MANAGE) };
  res.json({ status: 'success', data: await announcementService.getAnnouncement(req.params.id, viewer) });
}

// POST /api/v1/announcements — MANAGE_ANNOUNCEMENTS
// { title, body, audience: EVERYONE|ROLES|CLASSES, roleIds?, classSectionIds?, priority?, pinned?, publishAt?, expiresAt? }
export async function create(req: Request, res: Response) {
  const data = input(bodyOf(req));
  const announcement = await announcementService.createAnnouncement(req.user!.id, {
    ...data,
    title: required(data.title, 'title'),
    body: required(data.body, 'body'),
    audience: required(data.audience, 'audience'),
  });
  res.status(201).json({ status: 'success', data: announcement });
}

// PATCH /api/v1/announcements/:id — MANAGE_ANNOUNCEMENTS
export async function update(req: Request<{ id: string }>, res: Response) {
  res.json({ status: 'success', data: await announcementService.updateAnnouncement(req.params.id, input(bodyOf(req))) });
}

// DELETE /api/v1/announcements/:id — MANAGE_ANNOUNCEMENTS
export async function remove(req: Request<{ id: string }>, res: Response) {
  await announcementService.deleteAnnouncement(req.params.id);
  res.status(204).end();
}
