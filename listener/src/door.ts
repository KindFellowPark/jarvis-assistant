// The local door: scripts on this Mac POST here and their messages join the same queue.
// Bound to 127.0.0.1 only.
import type { DoorMessage, Listener } from "./listener";

export function startDoor(getListener: () => Listener, port: number) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/message") return new Response("not found", { status: 404 });
      let body: DoorMessage;
      try {
        body = (await req.json()) as DoorMessage;
      } catch {
        return Response.json({ status: "rejected", error: "invalid json" }, { status: 400 });
      }
      const status = await getListener().ingestDoor(body);
      return Response.json({ status }, { status: status === "rejected" ? 400 : status === "no_thread" ? 409 : 202 });
    },
  });
}
