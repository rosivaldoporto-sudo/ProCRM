import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function proxy(request: NextRequest) {
  const requestId = crypto.randomUUID();
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';
  // Formulários públicos (/f/*) precisam de duas exceções em relação ao
  // CSP estrito do app:
  //   1. Meta Pixel: o fbq envia beacons para *.facebook.net /
  //      *.facebook.com — precisa estar no connect-src. O próprio
  //      fbevents.js é carregado por um inline <Script nonce> (ver
  //      MetaPixelSnippet em public-form.tsx) e herda a confiança via
  //      'strict-dynamic', então nenhum host extra no script-src.
  //   2. Embed via iframe: a aba "Compartilhar" do editor gera um
  //      <iframe> para sites de clientes. `frame-ancestors 'none'`
  //      (e o X-Frame-Options: DENY do next.config) proibiriam isso —
  //      quando frame-ancestors está presente, os browsers ignoram o
  //      X-Frame-Options (spec), então `frame-ancestors *` libera o
  //      embed só nesta rota pública (sem dados sensíveis).
  //
  // Nota de voz (todas as rotas): o codificador Ogg/Opus
  // (/opus/encoderWorker.min.js) roda como AudioWorklet, que herda o CSP
  // da página, e compila WebAssembly. Sem 'wasm-unsafe-eval' o módulo
  // quebra ao carregar, o 'encoder-worklet' nunca é registrado e a
  // gravação falha — só em produção, porque no dev o 'unsafe-eval' já
  // cobria o wasm. 'wasm-unsafe-eval' libera apenas a compilação de
  // WebAssembly; eval() e new Function() continuam bloqueados.
  const isPublicForm = request.nextUrl.pathname.startsWith('/f/');
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https://*.supabase.co",
    "font-src 'self' data:",
    `connect-src 'self' https://*.supabase.co wss://*.supabase.co${isPublicForm ? ' https://*.facebook.net https://*.facebook.com' : ''}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    isPublicForm ? 'frame-src https://*.facebook.com' : "frame-src 'none'",
    isPublicForm ? 'frame-ancestors *' : "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('x-request-id', requestId);
  requestHeaders.set('Content-Security-Policy', csp);

  const nextResponse = () => {
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    response.headers.set('Content-Security-Policy', csp);
    response.headers.set('X-Request-Id', requestId);
    return response;
  };

  // Browsers send Origin on JavaScript mutations. Enforce it before session
  // handling so another website cannot make authenticated writes with the
  // user's cookies (CSRF). Authorization/RLS remains the same-origin boundary.
  const pathname = request.nextUrl.pathname;
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
    request.method
  );
  const isExternalIntegration =
    pathname.startsWith('/api/whatsapp/webhook') ||
    pathname.startsWith('/api/uazapi/webhook') ||
    pathname === '/api/automations/cron' ||
    pathname === '/api/flows/cron' ||
    // `/api/v1/*` authenticates with bearer API keys, so it needs no Origin
    // check. `/api/v1/capi/*` is the exception: the pipelines page calls it
    // with the session cookie, so it must stay behind the CSRF check below.
    (pathname.startsWith('/api/v1/') && !pathname.startsWith('/api/v1/capi/'));

  if (pathname.startsWith('/api/') && isMutation && !isExternalIntegration) {
    const origin = request.headers.get('origin');
    const fetchSite = request.headers.get('sec-fetch-site');
    const allowedOrigins = new Set([request.nextUrl.origin]);
    const configuredSite = process.env.NEXT_PUBLIC_SITE_URL;
    if (configuredSite) {
      try {
        allowedOrigins.add(new URL(configuredSite).origin);
      } catch {
        // Invalid deployment configuration must not weaken same-origin checks.
      }
    }

    let normalizedOrigin: string | null = null;
    try {
      normalizedOrigin = origin ? new URL(origin).origin : null;
    } catch {
      normalizedOrigin = null;
    }

    if (
      fetchSite === 'cross-site' ||
      !normalizedOrigin ||
      !allowedOrigins.has(normalizedOrigin)
    ) {
      const response = NextResponse.json(
        { error: 'Forbidden request origin' },
        { status: 403 }
      );
      response.headers.set('Content-Security-Policy', csp);
      response.headers.set('X-Request-Id', requestId);
      return response;
    }

    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > 2 * 1024 * 1024) {
      const response = NextResponse.json(
        { error: 'Payload too large' },
        { status: 413 }
      );
      response.headers.set('Content-Security-Policy', csp);
      response.headers.set('X-Request-Id', requestId);
      return response;
    }
  }

  let supabaseResponse = nextResponse();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = nextResponse();
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    response.headers.set('Content-Security-Policy', csp);
    response.headers.set('X-Request-Id', requestId);
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie);
    });
    return response;
  };

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /convite/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (
    user &&
    (request.nextUrl.pathname === '/entrar' ||
      request.nextUrl.pathname === '/cadastro' ||
      request.nextUrl.pathname === '/recuperar-senha')
  ) {
    const url = request.nextUrl.clone();
    const inviteToken = request.nextUrl.searchParams.get('invite');
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/entrar' ||
        request.nextUrl.pathname === '/cadastro')
    ) {
      url.pathname = `/convite/${encodeURIComponent(inviteToken)}`;
      url.search = '';
    } else {
      url.pathname = '/painel';
      url.search = '';
    }
    return withRefreshedCookies(NextResponse.redirect(url));
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = [
    '/painel',
    '/conversas',
    '/contatos',
    '/funis',
    '/transmissoes',
    '/automacoes',
    '/fluxos',
    '/formularios',
    '/notificacoes',
    '/agentes',
    '/configuracoes',
  ];
  if (
    !user &&
    protectedPaths.some(
      (path) =>
        request.nextUrl.pathname === path ||
        request.nextUrl.pathname.startsWith(`${path}/`)
    )
  ) {
    const url = request.nextUrl.clone();
    url.pathname = '/entrar';
    return withRefreshedCookies(NextResponse.redirect(url));
  }

  // API routes that need auth (not webhooks)
  if (
    !user &&
    request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
    !request.nextUrl.pathname.includes('/webhook')
  ) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
