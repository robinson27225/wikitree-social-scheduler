import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Req {
  method: string;
  url: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text(): string;
  json<T = any>(): T;
  form(): URLSearchParams;
}

export interface Reply {
  status?: number;
  json?: unknown;
  raw?: string | Buffer;
  headers?: Record<string, string | undefined>;
}

export interface Fake {
  base: string;
  requests: Req[];
  /** The requests whose path matches. */
  to(pathPrefix: string): Req[];
  close(): void;
}

/** A tiny local server standing in for a platform's API, recording every request it gets. */
export async function startFake(handler: (req: Req) => Reply | Promise<Reply>): Promise<Fake> {
  const requests: Req[] = [];
  const server = http.createServer((incoming, res) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (c) => chunks.push(c));
    incoming.on("end", async () => {
      const body = Buffer.concat(chunks);
      const url = incoming.url ?? "/";
      const req: Req = {
        method: incoming.method ?? "GET",
        url,
        path: url.split("?")[0],
        headers: incoming.headers,
        body,
        text: () => body.toString("utf8"),
        json: () => JSON.parse(body.toString("utf8")),
        form: () => new URLSearchParams(body.toString("utf8")),
      };
      requests.push(req);
      try {
        const reply = await handler(req);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(reply.headers ?? {})) if (v !== undefined) headers[k] = v;
        let payload: string | Buffer = "";
        if (reply.json !== undefined) {
          headers["Content-Type"] = "application/json";
          payload = JSON.stringify(reply.json);
        } else if (reply.raw !== undefined) {
          payload = reply.raw;
        }
        res.writeHead(reply.status ?? 200, headers).end(payload);
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    requests,
    to: (prefix) => requests.filter((r) => r.path.startsWith(prefix)),
    close: () => server.close(),
  };
}
