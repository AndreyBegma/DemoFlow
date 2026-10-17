import { Button } from '@andrewbehma/glass-ui/button';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Input, Select } from '@andrewbehma/glass-ui/field';
import {
  Table,
  TableCell,
  TableHead,
  TableRow,
} from '@andrewbehma/glass-ui/table';
import { toast } from '@andrewbehma/glass-ui/toast';
import { type FormEvent, useState } from 'react';
import { CUSTOMERS, type Customer, PLANS, type Plan } from '../data/customers';

export function Customers() {
  const [customers, setCustomers] = useState<readonly Customer[]>(CUSTOMERS);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [plan, setPlan] = useState<Plan>('Free');

  const needle = query.trim().toLowerCase();
  const visible = customers.filter((c) =>
    c.name.toLowerCase().includes(needle),
  );

  function create(event: FormEvent) {
    event.preventDefault();
    setCustomers([{ name, email, plan }, ...customers]);
    setOpen(false);
    setName('');
    setEmail('');
    setPlan('Free');
    toast('Customer created');
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Customers</h1>
      <div className="my-4 flex items-center gap-3">
        <Input
          type="search"
          aria-label="Search customers"
          placeholder="Search customers"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button onClick={() => setOpen(true)}>New customer</Button>
      </div>
      <Table>
        <TableHead>
          <TableRow>
            <TableCell head>Name</TableCell>
            <TableCell head>Email</TableCell>
            <TableCell head>Plan</TableCell>
          </TableRow>
        </TableHead>
        <tbody>
          {visible.map((customer) => (
            <TableRow key={customer.email}>
              <TableCell>{customer.name}</TableCell>
              <TableCell>{customer.email}</TableCell>
              <TableCell>{customer.plan}</TableCell>
            </TableRow>
          ))}
        </tbody>
      </Table>
      <DialogRoot open={open} onOpenChange={setOpen}>
        <DialogContent title="New customer">
          <form onSubmit={create} className="flex flex-col gap-3">
            <Field label="Name" htmlFor="customer-name">
              <Input
                id="customer-name"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Email" htmlFor="customer-email">
              <Input
                id="customer-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field label="Plan" htmlFor="customer-plan">
              <Select
                id="customer-plan"
                value={plan}
                onChange={(event) => setPlan(event.target.value as Plan)}
              >
                {PLANS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit">Create</Button>
          </form>
        </DialogContent>
      </DialogRoot>
    </section>
  );
}
