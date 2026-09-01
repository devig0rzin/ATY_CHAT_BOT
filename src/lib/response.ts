import type { Context } from 'hono';

export function successResponse<T>(c: Context, data: T, status: 200 | 201 | 202 = 200) {
  return c.json(
    {
      ok: true,
      request_id: c.get('requestId'),
      data
    },
    status
  );
}

export function errorResponse(
  c: Context,
  error: { code: string; message: string },
  status: number
) {
  return c.json(
    {
      ok: false,
      request_id: c.get('requestId'),
      error
    },
    status as never
  );
}
