// Tiny console logger: one line per event, with a level and a module tag.
// Docker keeps stdout, so `docker compose logs suite` shows everything.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(tag = 'suite', level = process.env.LOG_LEVEL || 'info') {
  const min = LEVELS[level] ?? LEVELS.info;
  const out = (lvl) => (...args) => {
    if (LEVELS[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${tag}]`;
    (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(line, ...args);
  };
  return {
    debug: out('debug'),
    info: out('info'),
    warn: out('warn'),
    error: out('error'),
    child: (sub) => createLogger(`${tag}:${sub}`, level),
  };
}
