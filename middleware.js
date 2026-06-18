import { NextResponse } from 'next/server';

export default function middleware(request) {
  const hostname = request.headers.get('host') || '';

  // Only apply to the snaplead subdomain
  if (hostname === 'snaplead.jovilex.com') {
    const url = request.nextUrl.clone();
    const path = url.pathname;

    // Let API routes, static files, and already-prefixed routes pass through
    if (path.startsWith('/api/') || path.startsWith('/snaplead') || path.includes('.')) {
      return NextResponse.next();
    }

    // Root → marketing page
    if (path === '/') {
      url.pathname = '/snaplead';
      return NextResponse.rewrite(url);
    }

    // Everything else: /signup → /snaplead/signup, /for/dental → /snaplead/for/dental, etc.
    url.pathname = '/snaplead' + path;
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next|favicon).*)']
};
