import { Card } from '@andrewbehma/glass-ui/card';
import { Toaster } from '@andrewbehma/glass-ui/toast';
import { Link, Route, Routes } from 'react-router';
import { PAGES } from './nav';
import { Customers } from './pages/customers';
import { Home } from './pages/home';
import { Hover } from './pages/hover';
import { Login } from './pages/login';
import { Long } from './pages/long';
import { Masked } from './pages/masked';
import { Slow } from './pages/slow';

export function App() {
  return (
    <>
      <header className="p-4">
        <Card>
          <nav aria-label="Main" className="flex gap-4 text-sm">
            <Link to="/">Home</Link>
            {PAGES.map((page) => (
              <Link key={page.to} to={page.to}>
                {page.label}
              </Link>
            ))}
          </nav>
        </Card>
      </header>
      <main className="mx-auto max-w-3xl p-4">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/login" element={<Login />} />
          <Route path="/long" element={<Long />} />
          <Route path="/slow" element={<Slow />} />
          <Route path="/hover" element={<Hover />} />
          <Route path="/masked" element={<Masked />} />
        </Routes>
      </main>
      <Toaster />
    </>
  );
}
