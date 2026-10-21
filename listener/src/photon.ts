// Photon (Spectrum) iMessage transport. Credentials come from the Keychain at launch and are
// never passed to a Claude run.
import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { keychain } from "./keychain";
import type { Inbound, Transport } from "./transport";

export async function photonTransport(onMessage: (m: Inbound) => Promise<void>): Promise<Transport & { stop(): Promise<void> }> {
  const app = await Spectrum({
    projectId: keychain("jarvis_photon_project_id"),
    projectSecret: keychain("jarvis_photon_project_secret"),
    providers: [imessage.config()],
  });
  const im = imessage(app);
  const live = new Map<string, any>(); // thread id -> space object from this process

  (async () => {
    for await (const [space, message] of app.messages) {
      if (message.direction !== "inbound") continue;
      const s = space as any;
      live.set(s.id, space);
      const content = message.content as any;
      await onMessage({
        id: message.id,
        senderAddress: message.sender?.id,
        threadId: s.id,
        linePhone: s.phone ?? null,
        kind: s.type === "dm" ? "dm" : "group",
        text: content?.type === "text" ? String(content.text) : null,
      });
    }
  })().catch((err) => {
    console.error("photon stream ended", err);
    process.exit(1); // launchd restarts the listener; open messages resume from the queue
  });

  return {
    async send(threadId, linePhone, text) {
      const space = live.get(threadId) ?? (await im.space.get(threadId, ...((linePhone ? [{ phone: linePhone }] : []) as [])));
      await app.send(space, text);
    },
    async stop() {
      await app.stop();
    },
  };
}
