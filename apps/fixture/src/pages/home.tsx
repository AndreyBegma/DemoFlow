import { Link } from 'react-router';
import { PAGES } from '../nav';

export function Home() {
  return (
    <section>
      <h1 className="text-2xl font-semibold">DemoFlow Fixture</h1>
      <p className="mt-2 text-sm opacity-70">
        A deterministic target for demos: every page works offline.
      </p>
      <ul className="mt-4 flex flex-col gap-2">
        {PAGES.map((page) => (
          <li key={page.to}>
            <Link to={page.to}>{page.label}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
