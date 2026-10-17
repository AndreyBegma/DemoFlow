import { Card } from '@andrewbehma/glass-ui/card';

export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="max-w-md">
        <h1 className="text-2xl font-semibold">DemoFlow</h1>
        <p className="mt-2 text-sm opacity-70">
          Verified, polished demo videos of the features you ship.
        </p>
      </Card>
    </main>
  );
}
