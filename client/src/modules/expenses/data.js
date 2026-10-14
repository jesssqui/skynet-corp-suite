// What the expenses screens read: the device's offline copy (never the server), the expenses, their
// business tags and our businesses. Records under a deleted expense are already left out by the engine.
import { useSyncData } from '../../sync/index.js';

export function useExpenseData() {
  const { data, loading } = useSyncData(async (e) => {
    const all = await e.listMany(['expense', 'expense_share', 'business']);
    return {
      expenses: all.expense ?? [],
      shares: all.expense_share ?? [],
      businesses: [...(all.business ?? [])].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9)),
    };
  }, [], { entities: ['expense', 'expense_share', 'business'] });
  return { data, loading };
}
