export type InvoiceStatus = 'paid' | 'open' | 'overdue';

export interface Invoice {
  id: string;
  customer: string;
  amount: number;
  status: InvoiceStatus;
  issued: string;
}

export const invoices: Invoice[] = [
  { id: 'INV-2041', customer: 'Northwind Labs', amount: 4200, status: 'open', issued: '2026-11-02' },
  { id: 'INV-2040', customer: 'Cobalt Studio', amount: 1800, status: 'paid', issued: '2026-11-01' },
  { id: 'INV-2039', customer: 'Meridian Health', amount: 9600, status: 'overdue', issued: '2026-10-24' },
  { id: 'INV-2038', customer: 'Pine & Co', amount: 640, status: 'paid', issued: '2026-10-19' },
  { id: 'INV-2037', customer: 'Ardent Freight', amount: 3120, status: 'overdue', issued: '2026-10-11' },
  { id: 'INV-2036', customer: 'Studio Kestrel', amount: 2200, status: 'open', issued: '2026-10-08' },
  { id: 'INV-2035', customer: 'Halcyon Press', amount: 980, status: 'paid', issued: '2026-09-30' },
  { id: 'INV-2034', customer: 'Riverbend Co-op', amount: 1480, status: 'open', issued: '2026-09-27' },
  { id: 'INV-2033', customer: 'Atlas Robotics', amount: 7400, status: 'paid', issued: '2026-09-15' },
  { id: 'INV-2032', customer: 'Vesper Audio', amount: 560, status: 'overdue', issued: '2026-09-02' },
];

export const team = [
  { name: 'Mara Okafor', email: 'mara@ledger.dev', role: 'Owner', since: '2024' },
  { name: 'Jonas Weber', email: 'jonas@ledger.dev', role: 'Admin', since: '2025' },
  { name: 'Priya Raman', email: 'priya@ledger.dev', role: 'Member', since: '2025' },
  { name: 'Alex Duarte', email: 'alex@ledger.dev', role: 'Member', since: '2026' },
];

export const reportMonths = [
  { id: '2026-11', label: 'November 2026', revenue: 48210, growth: 0.12 },
  { id: '2026-10', label: 'October 2026', revenue: 43980, growth: 0.04 },
  { id: '2026-09', label: 'September 2026', revenue: 41260, growth: -0.02 },
];

export const activity = [
  { when: '2h ago', what: 'Invoice INV-2041 sent to Northwind Labs', who: 'Mara' },
  { when: '5h ago', what: 'Plan changed to Scale (annual)', who: 'Jonas' },
  { when: 'Yesterday', what: 'INV-2039 marked overdue automatically', who: 'System' },
  { when: '2d ago', what: 'Priya Raman joined the workspace', who: 'Mara' },
];

export function invoiceCsv(list: Invoice[]): string {
  const header = 'id,customer,amount,status,issued';
  const rows = list.map((invoice) =>
    [invoice.id, invoice.customer, invoice.amount, invoice.status, invoice.issued].join(','),
  );
  return [header, ...rows].join('\n');
}

export function money(value: number): string {
  return `$${value.toLocaleString('en-US')}`;
}
