// What the Sales page reads: the device's offline copy of the sale_day records.
import { useSyncData } from '../../sync/index.js';
import { cachedList } from '../crm/data.js';

/** Every sale_day record on this device (none until the first sync finishes: data is null). */
export function useSales() {
  const { data, loading, error } = useSyncData(async (e) => (await cachedList(e, 'sale_day')).records, [], { entities: ['sale_day'] });
  return { sales: data ?? null, loading, error };
}
