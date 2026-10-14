import ExpensesPage from './ExpensesPage.jsx';

// Expenses (C9): what was spent, and which of our businesses each expense is for (split evenly to the
// cent). Its record types (expense, expense_share) are registered by the server's expenses module and
// reach devices through the sync engine, so the pages work offline.
//   /expenses   the month's expenses, the totals per business, add / edit / delete
export default {
  id: 'expenses',
  nav: { id: 'expenses', label: 'Expenses', icon: 'list', order: 17, path: '/expenses' },
  routes: [{ path: '/expenses', element: <ExpensesPage /> }],
};
