import { type NextRequest, NextResponse } from 'next/server';

/** Request header carrying the path and query of an `/app/**` request. */
export const RETURN_TO_HEADER = 'x-demoflow-url';

// A layout cannot see the URL it is rendered for. The `/app` layout guards
// every page below it, so it needs this to send a guest to sign-in with a
// way back (spec #135, Decision 6).
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  const { pathname, search } = request.nextUrl;
  headers.set(RETURN_TO_HEADER, `${pathname}${search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ['/app', '/app/:path*'] };
