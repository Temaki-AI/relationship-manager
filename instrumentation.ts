import type { Instrumentation } from 'next';
import { logError, logInfo } from '@/lib/observability';

export function register() {
  logInfo('runtime.registered', {
    runtime: process.env.NEXT_RUNTIME || 'unknown',
  });
}

export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  logError('request.unhandled_error', error, request.headers, {
    method: request.method,
    route: context.routePath,
    route_type: context.routeType,
    router_kind: context.routerKind,
    render_source: context.renderSource,
  });
};
