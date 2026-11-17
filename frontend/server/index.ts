import { type ServerWebSocket, serve } from "bun";
import { type Bank, readBankCookie } from "../shared/bank";
import type { ClientMessage } from "../shared/protocol";
import index from "../src/index.html";
import { HybridBrain } from "./brain/hybridBrain";
import { Table } from "./game/table";

interface SocketData {
  /** Balances restored from the bank cookie at connect time. */
  bank: Bank;
  table?: Table;
}

const brain = new HybridBrain(process.env.FLY_BRAIN_URL ?? "ws://127.0.0.1:8000/ws/brain");
let nextTableId = 0;

const CLIENT_TYPES = new Set<ClientMessage["type"]>([
  "new_round",
  "rebuy",
  "hit",
  "stand",
  "double",
  "split",
  "set_drunk",
  "reset_brain",
]);

function parseMessage(raw: string | Buffer): ClientMessage | null {
  try {
    const data = JSON.parse(String(raw)) as Partial<ClientMessage>;
    if (!data || typeof data !== "object" || !data.type || !CLIENT_TYPES.has(data.type)) return null;
    if (data.type === "new_round" && typeof data.bet !== "number") return null;
    if (data.type === "set_drunk" && typeof data.value !== "number") return null;
    if (data.type === "reset_brain" && data.mode !== "naive" && data.mode !== "pretrained") return null;
    return data as ClientMessage;
  } catch {
    return null;
  }
}

const SITE_URL = (process.env.SITE_URL ?? "https://21-and-fly.com").replace(/\/+$/, "");

const ROBOTS_TXT = `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
  </url>
</urlset>
`;

const server = serve({
  port: Number(process.env.PORT ?? 3000),

  routes: {
    "/": index,

    "/robots.txt": new Response(ROBOTS_TXT, { headers: { "Content-Type": "text/plain; charset=utf-8" } }),
    "/sitemap.xml": new Response(SITEMAP_XML, { headers: { "Content-Type": "application/xml; charset=utf-8" } }),

    "/ws/game": (req, server) => {
      const { bet: _bet, ...bank } = readBankCookie(req.headers.get("cookie"));
      if (server.upgrade(req, { data: { bank } satisfies SocketData })) return;
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    },
  },

  websocket: {
    data: {} as SocketData,

    open(ws: ServerWebSocket<SocketData>) {
      const table = new Table(`t${++nextTableId}`, brain, ws.data.bank, (message) => {
        ws.send(JSON.stringify(message));
      });
      ws.data.table = table;
      table.hello();
    },

    message(ws: ServerWebSocket<SocketData>, raw) {
      const message = parseMessage(raw);
      if (!message) {
        ws.send(JSON.stringify({ type: "error", message: "Unknown command" }));
        return;
      }
      ws.data.table?.handle(message);
    },

    close(ws: ServerWebSocket<SocketData>) {
      ws.data.table?.close();
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    // Bun 1.4.4's HMR bundle drops CSS-module imports (`import_X_module is not defined`),
    // so the browser is served a plain dev bundle; reload the page after edits.
    hmr: false,
    console: true,
  },
});

console.log(`21 and Fly: ${server.url}`);
