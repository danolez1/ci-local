import { connect, createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

export interface CountingProxy {
  port: number;
  /** Bytes the client has sent upstream so far. */
  sent(): number;
  close(): Promise<void>;
}

// ssh offers no byte counter for a forwarded port, so uploads are counted by relaying them locally.
// The upstream port is read per connection because a recovered tunnel listens on a new one.
export async function countingProxy(upstreamPort: () => number): Promise<CountingProxy> {
  let sent = 0;
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(upstreamPort(), "127.0.0.1");
    for (const [socket, peer] of [[client, upstream], [upstream, client]] as const) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        sockets.delete(socket);
        peer.destroy();
      });
    }
    client.on("data", (chunk) => {
      sent += chunk.length;
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    sent: () => sent,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
