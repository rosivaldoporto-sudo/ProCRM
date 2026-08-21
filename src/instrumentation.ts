import type { Instrumentation } from 'next';
import { logServerError } from '@/lib/observability/error-log';

export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context
) => {
  const rawRequestId = request.headers['x-request-id'];
  const requestId = Array.isArray(rawRequestId)
    ? rawRequestId[0]
    : rawRequestId;
  await logServerError(error, {
    source: 'next.onRequestError',
    requestId,
    route: request.path,
    method: request.method,
    context: {
      routePath: context.routePath,
      routeType: context.routeType,
      routerKind: context.routerKind,
      renderSource: context.renderSource,
    },
    // Account context is intentionally unknown at this global boundary.
    // It remains available in structured Hostinger logs; tenant-specific
    // route errors are persisted by logServerError with accountId.
    persist: false,
  });
};

