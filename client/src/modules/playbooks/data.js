// What the playbook screens read: the device's offline copy, through the CRM screens' cached lists
// (../crm/data.js: each record type listed once and kept until it changes), so everything works offline.
import { useSyncData } from '../../sync/index.js';
import { cachedLists } from '../crm/data.js';

const ENTITIES = ['business', 'client', 'account', 'relationship', 'service', 'playbook', 'playbook_step', 'playbook_run', 'run_step', 'task'];
const byPos = (a, b) => (a.position ?? 1e9) - (b.position ?? 1e9);

/** Our businesses, clients and their accounts/relationships/services (for running), every playbook, step, run, run copy and run task. */
export function usePlaybooksData() {
  const { data, loading, error } = useSyncData(async (e) => {
    const [businesses, clients, accounts, relationships, services, playbooks, steps, runs, runSteps, tasks] = await cachedLists(e, ENTITIES);
    return {
      businesses: [...businesses.records].sort(byPos),
      businessesById: businesses.byId(),
      clients: clients.records,
      clientsById: clients.byId(),
      accounts: accounts.records,
      accountsById: accounts.byId(),
      accountsOf: (clientId) => accounts.where('client_id', clientId),
      relationships: relationships.records,
      services: services.records,
      playbooks: playbooks.records,
      playbooksById: playbooks.byId(),
      stepsOf: (playbookId) => steps.where('playbook_id', playbookId),
      runs: runs.records,
      runsById: runs.byId(),
      runsOf: (playbookId) => runs.where('playbook_id', playbookId),
      runStepsOf: (runId) => runSteps.where('run_id', runId),
      tasksOf: (runId) => tasks.where('run_id', runId),
    };
  }, [], { entities: ENTITIES });
  return { data: data ?? null, loading, error };
}

const CLIENT_ENTITIES = ['playbook_run', 'run_step', 'task'];

/** A client's runs (any status) with their copies and tasks — for the client page's Projects card. */
export function useClientRunsData(clientId) {
  const { data, loading, error } = useSyncData(async (e) => {
    const [runs, runSteps, tasks] = await cachedLists(e, CLIENT_ENTITIES);
    const mine = runs.where('client_id', clientId);
    return {
      runs: mine,
      runStepsOf: (runId) => runSteps.where('run_id', runId),
      tasksOf: (runId) => tasks.where('run_id', runId),
    };
  }, [clientId], { entities: CLIENT_ENTITIES });
  return { data: data ?? null, loading, error };
}
