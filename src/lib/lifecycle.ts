// Set once the server starts shutting down, so the health check reports it and keep-alive clients reconnect elsewhere
let shuttingDown = false;

export const markShuttingDown = () => {
  shuttingDown = true;
};

export const isShuttingDown = () => shuttingDown;
