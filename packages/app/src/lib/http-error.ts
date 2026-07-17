// Parser for the api-server's structured error bodies as they appear
// inside SDK error MESSAGES. The client formats every non-2xx as
// `HTTP <status>: <raw body>`; when that body is the server's JSON
// error shape (`{error, detail?, requestId?, cause?}`), the fields are
// worth more than the raw text: the human `error` makes a headline,
// `requestId` correlates with server logs, and `cause` (the auth
// middleware's AuthFailureCause) drives the credential self-heal.
// Older servers / proxies / plain-text bodies simply return null and
// callers fall back to the raw rendering.

export interface StructuredHttpError {
  status: number;
  /** The server's human-readable error line. */
  error: string;
  detail?: string;
  requestId?: string;
  /** Machine-readable failure classification (AuthFailureCause on 401s). */
  cause?: string;
}

/** Extract the structured body from an SDK-formatted error message
 *  (`HTTP <status>: <json>`), or null for any other shape. */
export function parseStructuredHttpError(message: string): StructuredHttpError | null {
  const match = /HTTP (\d+): (\{[\s\S]*\})\s*$/.exec(message);
  if (!match) return null;
  try {
    const body: unknown = JSON.parse(match[2]);
    if (typeof body !== 'object' || body === null) return null;
    const { error, detail, requestId, cause } = body as {
      error?: unknown;
      detail?: unknown;
      requestId?: unknown;
      cause?: unknown;
    };
    if (typeof error !== 'string' || !error) return null;
    return {
      status: Number(match[1]),
      error,
      detail: typeof detail === 'string' && detail ? detail : undefined,
      requestId: typeof requestId === 'string' && requestId ? requestId : undefined,
      cause: typeof cause === 'string' && cause ? cause : undefined,
    };
  } catch {
    return null;
  }
}
