// The module registration list. Order matters: migrations run in this order, so
// a module that others build on comes first. To add a module, create
// modules/<name>/index.js (see health/ for the shape) and add it here.
import auth from './auth/index.js';
import health from './health/index.js';
import sync from './sync/index.js';

// auth comes first: app.js puts its guard in front of every route.
// sync comes before every module that registers synced entities with it.
export const modules = [auth, health, sync];
