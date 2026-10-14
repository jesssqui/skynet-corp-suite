// Projects and playbooks (D9): playbooks of steps (each with its stage, when it falls after the start, who
// does it, its links, and what it does — a task, a renewal date on the client's service, or an offer made
// only while the client lacks that service), and their runs (agency projects and jobs, onboarding,
// retainers), each with its own copy of the steps. Synced record types, offline on devices; running a
// playbook happens on the device. No HTTP routes. The automation `playbook-months` makes a repeating
// run's later months. See CLAUDE.md, "Projects and playbooks (D9)".
import { fileURLToPath } from 'node:url';
import { createPlaybooksService } from './service.js';

export default {
  name: 'playbooks',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createPlaybooksService,
};
