// What the listener needs from a messaging provider: inbound messages, and a send to a known
// thread. The listener picks the thread; nothing from a model reaches `send`'s first argument.

export interface Inbound {
  id: string;
  senderAddress: string | undefined;
  threadId: string;
  linePhone: string | null;
  kind: "dm" | "group";
  text: string | null; // null for anything that is not plain text
}

export interface Transport {
  send(threadId: string, linePhone: string | null, text: string): Promise<void>;
}

export interface Alerter {
  /** macOS notification on this Mac. */
  notify(title: string, body: string): Promise<void>;
}

export const macAlerter: Alerter = {
  async notify(title, body) {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const proc = Bun.spawn(["osascript", "-e", `display notification "${esc(body)}" with title "${esc(title)}" sound name "Basso"`]);
    await proc.exited;
  },
};
