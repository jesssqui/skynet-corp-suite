// The two people who use the suite. Every account (auth module) is one of these,
// and every synced change records which one made it (sync module). 'system' is
// the server itself and is never an account.
export const ACTORS = Object.freeze(['owner', 'partner']);
