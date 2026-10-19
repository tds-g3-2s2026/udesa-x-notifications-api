import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { ProblemError } from '../app/errors';
import { currentTraceId, logEvent } from '../infrastructure/telemetry';

// Same as users-api: without the charset a browser decodes the accents as Latin-1.
const PROBLEM_MEDIA_TYPE = 'application/problem+json; charset=utf-8';
const TYPE_BASE = 'https://udesa-x.dev/errors';

interface Problem {
  status: number;
  code: string;
  title: string;
  detail: string;
}

function problemResponse(
  c: Context,
  problem: Problem,
  traceId: string,
  headers: Record<string, string> = {}
): Response {
  const body = {
    type: `${TYPE_BASE}/${problem.code}`,
    title: problem.title,
    status: problem.status,
    detail: problem.detail,
    instance: c.req.path,
    traceId,
  };
  return c.body(JSON.stringify(body), problem.status as ContentfulStatusCode, {
    ...headers,
    'content-type': PROBLEM_MEDIA_TYPE,
  });
}

/**
 * Hono's onError: a ProblemError goes out as is; anything else is a bug and
 * goes out as a generic 500. The real error only reaches the log, never the
 * client (ARQUITECTURA.md, "El detail no expone nada interno").
 */
export const onError: ErrorHandler = (error, c) => {
  // Outside a traced request there is no trace id to point at, but the client
  // still gets one to quote, and the log line carries the same.
  const traceId = currentTraceId() ?? crypto.randomUUID().replaceAll('-', '');
  if (error instanceof ProblemError) {
    return problemResponse(c, error, traceId, error.headers);
  }

  logEvent('error', `${c.req.method} ${c.req.path} failed`, {
    traceId,
    error: error.stack ?? String(error),
  });
  return problemResponse(
    c,
    {
      status: 500,
      code: 'internal-error',
      title: 'Error interno',
      detail: 'Ocurrió un error inesperado. Probá de nuevo en unos minutos',
    },
    traceId
  );
};

export const notFound: NotFoundHandler = (c) =>
  problemResponse(
    c,
    {
      status: 404,
      code: 'route-not-found',
      title: 'Ruta inexistente',
      detail: 'No existe ningún recurso en esta ruta',
    },
    currentTraceId() ?? crypto.randomUUID().replaceAll('-', '')
  );
