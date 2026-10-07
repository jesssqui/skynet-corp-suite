import { PageHeader, Card, EmptyState } from '../../ui/index.js';

function todayLabel() {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

export default function TodayPage() {
  return (
    <>
      <PageHeader title="Today" subtitle={todayLabel()} />
      <Card>
        <EmptyState title="Nothing here yet">
          Follow-ups, renewals and tasks from every business will gather here once the CRM arrives.
        </EmptyState>
      </Card>
    </>
  );
}
