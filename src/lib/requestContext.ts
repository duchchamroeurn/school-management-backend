// Per-request context (client IP and signed-in user), available anywhere in the request's async call
// chain without passing it through every function. Used by the audit log to record who did what.
// Outside a request (seed and import scripts) there is no context, and audit entries have no actor.
import { AsyncLocalStorage } from 'node:async_hooks';
import { NextFunction, Request, Response } from 'express';

export interface RequestContext {
  ip?: string;
  actor?: { id: string; username: string }; // set by authenticate()
}

const storage = new AsyncLocalStorage<RequestContext>();

export const currentContext = () => storage.getStore();

// Mount before the routes
export const requestContext = (req: Request, _res: Response, next: NextFunction) => {
  storage.run({ ip: req.ip }, next);
};
