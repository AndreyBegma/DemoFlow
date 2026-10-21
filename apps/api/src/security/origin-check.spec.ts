import type { Request, Response } from 'express';
import { originCheck } from './origin-check';

function run(method: string, origin?: string) {
  const check = originCheck('https://app.example/some/path');
  const req = { method, headers: origin ? { origin } : {} } as Request;
  const status = jest.fn().mockReturnThis();
  const json = jest.fn();
  const res = { status, json } as unknown as Response;
  const next = jest.fn();
  check(req, res, next);
  return { passed: next.mock.calls.length === 1, status };
}

describe('originCheck', () => {
  it.each([
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
  ])('refuses %s from another origin', (method) => {
    const { passed, status } = run(method, 'https://evil.example');
    expect(passed).toBe(false);
    expect(status).toHaveBeenCalledWith(403);
  });

  it('refuses an opaque "null" origin', () => {
    expect(run('POST', 'null').passed).toBe(false);
  });

  it("passes the web app's own origin", () => {
    expect(run('POST', 'https://app.example').passed).toBe(true);
  });

  it('passes a request without Origin', () => {
    expect(run('POST').passed).toBe(true);
  });

  it('passes a safe method from any origin', () => {
    expect(run('GET', 'https://evil.example').passed).toBe(true);
  });
});
