// Meetings from Apple Calendar (C6b) on devices: which are on a day (local days, DST, past midnight, all-day
// spans), the busy minutes they cover (overlaps once, free and all-day not counted), the day's load with
// them (Today, Plan my day, the week strip), what to push (never a meeting), the times shown — and, against a
// real server reading a fake iCloud, "done when": a meeting added in Apple Calendar reaches the device at the
// next read and counts in that day's load. Plus the Account card's form logic. Toronto time.
process.env.TZ = 'America/Toronto'; // DST: Mar 8 and Nov 1, 2026

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { localDate } from '@suite/shared/time';
import { addDays } from '@suite/shared/planner';
import {
  meetingsOn, busyMinutes, busyMinutesByDay, meetingTimeText, meetingOver, dayBounds, isOnDay,
} from '../src/modules/planner/meetings.js';
import { dayLoad, loadsByDay, pushSuggestions, weekLoads } from '../src/modules/planner/plan.js';
import { cleanAppPassword, connectProblem, appleState, toggledExcluded } from '../src/modules/calendar/apple.js';
import { startServer, makeDevice, testConfig, tmpDir } from './helpers.js';
import { startFakeCaldav, ics, APPLE_ID, APP_PASSWORD } from '../../server/test/fixtures/caldavFake.js';

const W = BUSINESS_IDS.wholesale;
const TODAY = '2026-10-07';
let n = 0;
const id = () => `0192f000-0000-7000-8000-${String((n += 1)).padStart(12, '0')}`;
/** A timed meeting at local wall times ("2026-10-07 09:00"). */
const local = (s) => {
  const [d, hm] = s.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return new Date(y, mo - 1, da, h, mi).toISOString();
};
const meeting = (from, to, o = {}) => ({
  id: id(), actor: 'owner', title: o.title ?? 'Meeting', calendar_name: 'Work', all_day: false, busy: o.busy ?? true,
  start_at: local(from), end_at: local(to), start_date: from.slice(0, 10), end_date: to.slice(0, 10), ...o,
});
const allDay = (from, to, o = {}) => ({ id: id(), actor: 'owner', title: o.title ?? 'Trip', calendar_name: 'Home', all_day: true, busy: false, start_at: null, end_at: null, start_date: from, end_date: to, ...o });
const task = (o) => ({ id: id(), title: o.title ?? 'Task', owner: 'owner', business_id: W, done_at: null, ...o });

test('which meetings are on a day: mine only, in time order (all-day first), across midnight, all-day spans', () => {
  const ms = [
    meeting('2026-10-07 14:00', '2026-10-07 15:00', { title: 'Afternoon' }),
    meeting('2026-10-07 09:00', '2026-10-07 09:30', { title: 'Standup' }),
    meeting('2026-10-06 23:00', '2026-10-07 01:00', { title: 'Late call' }),
    allDay('2026-10-06', '2026-10-08', { title: 'Trade show' }),
    meeting('2026-10-07 10:00', '2026-10-07 11:00', { title: 'Sam’s', actor: 'partner' }),
    meeting('2026-10-08 00:00', '2026-10-08 01:00', { title: 'Tomorrow' }),
  ];
  assert.deepEqual(meetingsOn(ms, { me: 'owner', day: TODAY }).map((m) => m.title), ['Trade show', 'Late call', 'Standup', 'Afternoon']);
  assert.deepEqual(meetingsOn(ms, { me: 'partner', day: TODAY }).map((m) => m.title), ['Sam’s']);
  assert.equal(meetingTimeText(ms[2], TODAY), `Until ${new Date(2026, 9, 7, 1).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`);
  assert.match(meetingTimeText(ms[2], '2026-10-06'), /^From /);
  assert.equal(meetingTimeText(ms[3], TODAY), 'All day');
  assert.match(meetingTimeText(ms[1], TODAY), / – /);
  assert.ok(meetingOver(ms[1], Date.parse(local('2026-10-07 12:00'))));
  assert.ok(!meetingOver(ms[0], Date.parse(local('2026-10-07 12:00'))));
  assert.ok(!isOnDay(ms[5], TODAY), 'a meeting starting at the next midnight is the next day’s');
  // Local days are 23 and 25 hours long at the DST changes.
  assert.equal(dayBounds('2026-03-08')[1] - dayBounds('2026-03-08')[0], 23 * 3600_000);
  assert.equal(dayBounds('2026-11-01')[1] - dayBounds('2026-11-01')[0], 25 * 3600_000);
});

test('busy minutes: overlaps once, free and all-day not counted, clipped to the day; per day for a range', () => {
  const ms = [
    meeting('2026-10-07 09:00', '2026-10-07 10:00'),
    meeting('2026-10-07 09:30', '2026-10-07 11:00'), // overlaps: 9:00–11:00 = 120
    meeting('2026-10-07 13:00', '2026-10-07 13:30', { busy: false }), // free
    allDay('2026-10-07', '2026-10-07'),
    meeting('2026-10-07 23:30', '2026-10-08 00:30'), // 30 today, 30 tomorrow
    meeting('2026-10-07 15:00', '2026-10-07 16:00', { actor: 'partner' }),
  ];
  assert.equal(busyMinutes(ms, { me: 'owner', day: TODAY }), 150);
  assert.equal(busyMinutes(ms, { me: 'owner', day: '2026-10-08' }), 30);
  assert.equal(busyMinutes(ms, { me: 'partner', day: TODAY }), 60);
  assert.deepEqual(Object.fromEntries(busyMinutesByDay(ms, { me: 'owner', from: TODAY })), { [TODAY]: 150, '2026-10-08': 30 });
  assert.deepEqual(Object.fromEntries(busyMinutesByDay(ms, { me: 'owner', from: '2026-10-08' })), { '2026-10-08': 30 });
  // A timed event of 24 hours or more (a conference entered with times) is listed but counts nothing, like an all-day one.
  const long = [meeting('2026-10-06 09:00', '2026-10-09 17:00', { title: 'Conference' }), meeting('2026-10-07 09:00', '2026-10-07 10:00')];
  assert.equal(busyMinutes(long, { me: 'owner', day: TODAY }), 60);
  assert.deepEqual(Object.fromEntries(busyMinutesByDay(long, { me: 'owner', from: '2026-10-06' })), { [TODAY]: 60 });
  assert.deepEqual(meetingsOn(long, { me: 'owner', day: TODAY }).map((m) => m.title), ['Conference', 'Meeting']);
  // A 1-hour meeting on the night the clocks go back is 60 minutes, not 0 or 120.
  assert.equal(busyMinutes([meeting('2026-11-01 09:00', '2026-11-01 10:00')], { me: 'owner', day: '2026-11-01' }), 60);
});

test('the day’s load counts meetings; an overbooked day never suggests moving a meeting, and other days’ meetings leave less room', () => {
  const tasks = [
    task({ title: 'Quote for Lefty’s', due_date: TODAY, estimate_minutes: 120 }),
    task({ title: 'Invoices', due_date: TODAY, estimate_minutes: 60 }),
    task({ title: 'No estimate', due_date: TODAY }),
  ];
  const meetings = [
    meeting('2026-10-07 09:00', '2026-10-07 12:00', { title: 'Workshop' }),
    meeting('2026-10-08 09:00', '2026-10-08 16:00', { title: 'Tomorrow’s offsite' }), // 7 h tomorrow
  ];
  const without = dayLoad(tasks, { me: 'owner', today: TODAY, dayMinutes: 300 });
  assert.equal(without.over, false);
  const load = dayLoad(tasks, { me: 'owner', today: TODAY, dayMinutes: 300, meetings });
  assert.deepEqual([load.minutes, load.taskMinutes, load.meetingMinutes, load.over, load.excess], [360, 180, 180, true, 60]);
  assert.deepEqual(load.meetings.map((m) => m.title), ['Workshop']);
  assert.ok(!load.tasks.some((t) => t.title === 'Workshop'));
  const s = pushSuggestions({ tasks, me: 'owner', today: TODAY, dayMinutes: 300, meetings });
  assert.deepEqual(s.map((x) => [x.task.title, x.to]), [['Invoices', '2026-10-09']], 'tomorrow has only 60 min of room left (7 h of meetings)');
  assert.deepEqual(Object.fromEntries(loadsByDay(tasks, { me: 'owner', today: TODAY, meetings })), { [TODAY]: 360, '2026-10-08': 420 });
  // Meetings alone over the day: every estimated task is suggested, the meetings stay.
  const packed = [meeting('2026-10-07 08:00', '2026-10-07 17:00', { title: 'Conference' })];
  assert.deepEqual(pushSuggestions({ tasks, me: 'owner', today: TODAY, dayMinutes: 480, meetings: packed }).map((x) => x.task.title).sort(), ['Invoices', 'Quote for Lefty’s']);
  // The week strip.
  const week = weekLoads(tasks, { me: 'owner', today: TODAY, monday: '2026-10-05', dayMinutes: 480, meetings });
  const wed = week.find((d) => d.day === TODAY);
  const thu = week.find((d) => d.day === '2026-10-08');
  assert.deepEqual([wed.minutes, wed.meetings, wed.count], [360, 1, 3]);
  assert.deepEqual([thu.minutes, thu.meetings, thu.count, thu.over], [420, 1, 0, false]);
});

test('the Account card: the app-specific password’s shape, what’s wrong, the state line, ticking calendars', () => {
  assert.equal(cleanAppPassword('ABCD EFGH IJKL MNOP'), 'abcd-efgh-ijkl-mnop');
  assert.equal(cleanAppPassword('hunter2'), null);
  assert.match(connectProblem({ appleId: 'jessy', password: APP_PASSWORD }), /Apple ID/);
  assert.match(connectProblem({ appleId: APPLE_ID, password: 'my real one' }), /never type your Apple ID’s own password/);
  assert.equal(connectProblem({ appleId: APPLE_ID, password: APP_PASSWORD }), null);
  assert.equal(appleState({ connected: false }).tone, 'neutral');
  assert.equal(appleState({ connected: true, refusedAt: 'x' }).tone, 'danger');
  assert.equal(appleState({ connected: true, paused: true }).tone, 'warn');
  assert.match(appleState({ connected: true, confirmed: true, lastSuccessAt: 't', meetingCount: 1, window: { from: 'a', to: 'b' } }).text, /1 meeting from a to b/);
  assert.match(appleState({ connected: true, confirmed: false }).text, /choose which calendars/);
  const cals = [{ url: 'h', included: true }, { url: 'w', included: false }];
  assert.deepEqual(toggledExcluded(cals, 'h', false), ['h', 'w']);
  assert.deepEqual(toggledExcluded(cals, 'w', true), []);
});

test('done when: a meeting added in Apple Calendar reaches the device at the next read and counts in that day’s load', async (t) => {
  const dav = await startFakeCaldav(t);
  const config = testConfig(tmpDir(t));
  config.calendar.apple.baseUrl = dav.url;
  const server = await startServer(t, config, { crm: true });
  const apple = server.ctx.services.calendar.apple;
  await apple.connect('owner', { appleId: APPLE_ID, password: APP_PASSWORD });
  await apple.setCalendars('owner', { excluded: [] }); // the calendars chosen: read from now on
  const phone = await makeDevice(t, server, 'owner');
  const today = localDate();
  await phone.engine.create('task', { title: 'Write the proposal', owner: 'owner', business_id: W, due_date: today, estimate_minutes: 300 });
  await phone.engine.syncNow();
  const read = async () => {
    const tasks = await phone.engine.list('task');
    const meetings = await phone.engine.list('meeting');
    return { tasks, meetings, load: dayLoad(tasks, { me: 'owner', today, dayMinutes: 480, meetings }) };
  };
  assert.deepEqual((await read()).load.minutes, 300);
  // Added in Apple Calendar (on the Mac or phone): 10:00–13:30 today, and a weekly one starting tomorrow.
  const at = (day, hm) => new Date(`${day}T${hm}:00`).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  dav.put('work', 'client', ics(['UID:client-1', 'SUMMARY:Client workshop', `DTSTART:${at(today, '10:00')}`, `DTEND:${at(today, '13:30')}`]));
  dav.put('home', 'yoga', ics(['UID:yoga', 'SUMMARY:Yoga', `DTSTART;TZID=America/Toronto:${addDays(today, 1).replace(/-/g, '')}T070000`, 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=4']));
  // The next read (the puller's, every 15 minutes; forced here), then the phone syncs.
  await apple.pullRound({ force: true });
  await phone.engine.syncNow();
  const { meetings, load } = await read();
  assert.deepEqual(meetingsOn(meetings, { me: 'owner', day: today }).map((m) => m.title), ['Client workshop']);
  assert.deepEqual([load.minutes, load.meetingMinutes, load.over, load.excess], [510, 210, true, 30]);
  assert.deepEqual(pushSuggestions({ tasks: await phone.engine.list('task'), me: 'owner', today, dayMinutes: 480, meetings }).map((s) => s.task.title), ['Write the proposal']);
  assert.equal(meetings.filter((m) => m.title === 'Yoga').length, 4, 'one record per instance');
  // Read-only on the device.
  await assert.rejects(phone.engine.update('meeting', meetings[0].id, { title: 'x' }), (e) => e.code === 'op_not_allowed');
  // Deleted in Apple Calendar → gone from the device at the next read.
  dav.remove('work', 'client');
  await apple.pullRound({ force: true });
  await phone.engine.syncNow();
  assert.deepEqual(meetingsOn(await phone.engine.list('meeting'), { me: 'owner', day: today }), []);
});
