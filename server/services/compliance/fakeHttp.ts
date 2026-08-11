/**
 * Injectable HTTP client for the compliance service.
 *
 * The real adapters use `nodeFetchHttp` (global fetch with per-request
 * AbortSignal timeout). Tests inject a `FakeHttp` with scripted responses so
 * no network is touched. No new npm dependencies — node fetch only.
 */

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  body: unknown; // parsed JSON or raw text
  headers?: Record<string, string>;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export const DEFAULT_TIMEOUT_MS = 8_000;

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Production client: thin wrapper over global fetch with hard timeout. */
export const nodeFetchHttp: HttpClient = {
  async request(req) {
    const res = await fetch(req.url, {
      method: req.method ?? "GET",
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, body: await parseBody(res), headers };
  },
};

export class HttpTimeoutError extends Error {
  constructor(message = "http request timed out") {
    super(message);
    this.name = "HttpTimeoutError";
  }
}

type FakeHandler = (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;

/**
 * Test double. Either map url-prefix → response/error, or supply a handler.
 * Records every request for assertions. `latencyMs` simulates slow upstreams
 * so timeout paths can be exercised without real sleeps beyond the threshold.
 */
export function makeFakeHttp(opts: {
  routes?: Record<string, HttpResponse | { error: Error }>;
  handler?: FakeHandler;
  latencyMs?: number;
}): HttpClient & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  return {
    requests,
    async request(req) {
      requests.push(req);
      const latency = opts.latencyMs ?? 0;
      const timeout = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (latency > 0) {
        // If the upstream would outlive the client timeout, the client aborts
        // first — simulate that with a short delay instead of a real long sleep.
        if (latency >= timeout) {
          await new Promise((r) => setTimeout(r, 5));
          throw new HttpTimeoutError();
        }
        await new Promise((r) => setTimeout(r, latency));
      }
      if (opts.handler) return opts.handler(req);
      const routes = opts.routes ?? {};
      for (const prefix of Object.keys(routes)) {
        if (req.url.startsWith(prefix)) {
          const r = routes[prefix];
          if ("error" in r) throw r.error;
          return r;
        }
      }
      throw new Error(`fakeHttp: no route for ${req.url}`);
    },
  };
}

/** Redact secrets (api keys, tokens) from any string before logging. */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  }
  return out;
}
