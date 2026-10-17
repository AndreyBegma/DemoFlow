export type Plan = 'Free' | 'Pro' | 'Team';

export interface Customer {
  name: string;
  email: string;
  plan: Plan;
}

export const PLANS: readonly Plan[] = ['Free', 'Pro', 'Team'];

const FIRST_NAMES = [
  'Ada',
  'Brian',
  'Chloe',
  'Dmitri',
  'Elena',
  'Farid',
  'Grace',
  'Hugo',
  'Irene',
  'Jonas',
];
const LAST_NAMES = ['Archer', 'Bishop'];

// 10 first names x 2 last names = 20 fixed rows, no randomness.
export const CUSTOMERS: readonly Customer[] = LAST_NAMES.flatMap(
  (last, lastIndex) =>
    FIRST_NAMES.map((first, firstIndex): Customer => {
      const index = lastIndex * FIRST_NAMES.length + firstIndex;
      return {
        name: `${first} ${last}`,
        email: `${first}.${last}@example.com`.toLowerCase(),
        plan: PLANS[index % PLANS.length]!,
      };
    }),
);
