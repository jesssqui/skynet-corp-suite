// The two people who use the suite. Every account (auth module) is one of these,
// and every synced change records which one made it (sync module). 'system' is
// the server itself and is never an account.
export const ACTORS = Object.freeze(['owner', 'partner']);

// Who a task (C4a) or a business's default for new and automated tasks belongs to: one of the
// two people, or SHARED — the shared list either of them can pick from. 'shared' is never an
// actor: it never signs in and never "did" anything (created_by/updated_by stay owner, partner
// or system).
export const SHARED = 'shared';
export const OWNERS = Object.freeze([...ACTORS, SHARED]);
