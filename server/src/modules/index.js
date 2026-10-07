// The module registration list. Order matters: migrations run in this order, so
// a module that others build on comes first. To add a module, create
// modules/<name>/index.js (see health/ for the shape) and add it here.
import health from './health/index.js';

export const modules = [health];
