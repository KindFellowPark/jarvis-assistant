/** A text message shows markdown literally, so list markers, heading marks and bold marks are taken
 *  out here instead of trusting the prompt to prevent them. */
export function plainText(reply: string): string {
  return reply
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*\u2022]\s+|#{1,6}\s+)/, ""))
    .join("\n")
    .replace(/\*\*(.+?)\*\*/g, "$1");
}
