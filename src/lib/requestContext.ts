// Per-request context (request id, client IP and signed-in user), available anywhere in the request's async
// call chain without passing it through every function. Used by the logger and the audit log.
// Outside a request (seed and import scripts) there is no context, and audit entries have no actor.
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { NextFunction, Request, Response } from 'express';

export interface RequestContext {
  requestId: string;
  ip?: string;
  actor?: { id: string; username: string }; // set by authenticate()
}

const storage = new AsyncLocalStorage<RequestContext>();

export const currentContext = () => storage.getStore();

// A reverse proxy or the frontend may pass its own id so one request can be traced across systems
const VALID_REQUEST_ID = /^[\w.:-]{1,100}$/;

// Mount before the routes. Echoes the request id in the X-Request-Id response header.
export const requestContext = (req: Request, res: Response, next: NextFunction) => {
  const incoming = req.get('x-request-id');
  const requestId = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', requestId);
  storage.run({ requestId, ip: req.ip }, next);
};
