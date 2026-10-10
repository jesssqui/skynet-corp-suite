// The eBay automations (D13), registered by the ebay module with the automations framework (C8). Tasks only, made and
// changed through sync (applyLocal as system); nothing is ever sent to eBay or anywhere else.
//   ebay-orders-to-ship   after each pull: "Ship eBay order <id>: N items" per order waiting to ship, due its ship-by
//                         day, for Save Point Shop's default owner; finished when eBay shows it shipped or cancelled
//   ebay-sign-in          daily: "Sign in to eBay again before <day>" 30 days before the sign-in lapses (once), or at once
//                         when eBay stopped accepting it; finished by the next sign-in
// Both on and silent by default: the task on Today is the reminder (an alert would repeat it). See CLAUDE.md, "eBay (D13)".
import { localDateIn } from '@suite/shared/sales';
import { shipPlan, signInPlan, applyPlan, actionable, result, SHIP_CAP, SAVE_POINT } from './plans.js';

export const PULLED_EVENT = 'ebay.pulled';
export const AUTOMATION_IDS = Object.freeze({ ship: 'ebay-orders-to-ship', signIn: 'ebay-sign-in' });

export function registerEbayAutomations({ automations, planner, store, clock }) {
  const owner = () => planner.automatedOwnerFor(SAVE_POINT);
  const today = () => localDateIn(store.timeZone(), new Date(clock()));
  const io = (id) => ({ made: (key) => automations.made(id, key), madeLike: (prefix) => automations.madeLike(id, prefix), planner, today: today() });
  const shipInputs = (r) => ({
    waiting: store.waiting(), byId: store.shipOrder, timeZone: store.timeZone(), today: r.today ?? today(), made: r.made, madeLike: r.madeLike, planner, owner: owner(),
  });

  automations.register({
    id: AUTOMATION_IDS.ship,
    name: 'eBay orders to ship',
    module: 'ebay',
    description: 'After each read of eBay: a task for each Save Point Shop order waiting to ship, due on its ship-by day, '
      + 'with its items and a link to it in Seller Hub (no buyer details are kept). Finished when eBay shows it shipped or cancelled. '
      + `At most ${SHIP_CAP} new a read (earliest ship-by first).`,
    trigger: {
      type: 'event', event: PULLED_EVENT, key: (d) => d?.key ?? null, label: 'After each read of eBay',
      accept: () => store.connected() && actionable(shipPlan(shipInputs(io(AUTOMATION_IDS.ship)))),
    },
    defaults: { enabled: true, alert: false },
    alertLink: '/tasks',
    run(_ctx, run) {
      if (!store.connected()) return { summary: 'eBay isn’t connected' };
      const plan = shipPlan({ ...shipInputs(run), today: today() });
      return result(applyPlan(plan, { ...run, today: today(), planner }, SHIP_CAP), { noun: 'eBay order to ship', title: 'eBay', nothing: 'No eBay orders waiting to ship' });
    },
  });

  automations.register({
    id: AUTOMATION_IDS.signIn,
    name: 'Sign in to eBay again',
    module: 'ebay',
    description: 'eBay’s sign-in for the suite lasts about 18 months: 30 days before it lapses — or as soon as eBay stops accepting it — '
      + 'one task for Save Point Shop’s default owner to sign in again. Finished by the next sign-in.',
    trigger: { type: 'schedule', every: 'day', at: '08:10' },
    defaults: { enabled: true, alert: false },
    alertLink: '/system/connections',
    run(_ctx, run) {
      const plan = signInPlan({ connection: store.connection(), timeZone: store.timeZone(), today: today(), made: run.made, madeLike: run.madeLike, planner, owner: owner() });
      return result(applyPlan(plan, { ...run, today: today(), planner }), { noun: 'sign-in reminder', title: 'eBay', nothing: 'The eBay sign-in is good for more than 30 days (or eBay isn’t connected)' });
    },
  });
}
