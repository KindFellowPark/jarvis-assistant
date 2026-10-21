// Code-owned privacy hold for mail, applied before any thread text reaches a model.
// The policy file came from an earlier mail-classification project. The rule: held threads go to
// no model. In this public copy the blocked domains are example.com stand-ins.
import policy from "./sensitivity_policy.json";

export interface GateInput {
  addresses: string[]; // every From, To, Cc and Delivered-To address on the thread
  text: string; // subjects, snippets and bodies joined
}

export type GateResult = { held: false } | { held: true; categories: string[] };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A meeting-notetaker's recaps are work meetings even when they arrive in personal mail, so the
// whole sender is held.
const EXTRA_BLOCKED_DOMAINS = ["recaps.example.com"];

export function gate(input: GateInput): GateResult {
  const categories = new Set<string>();
  const blocked = [...policy.blocked_domains, ...EXTRA_BLOCKED_DOMAINS];
  for (const address of input.addresses) {
    const domain = address.split("@").pop()?.toLowerCase() ?? "";
    if (blocked.some((b) => domain === b || domain.endsWith(`.${b}`))) categories.add("blocked_domain");
  }
  const folded = input.text.toLowerCase();
  for (const [category, patterns] of Object.entries(policy.blocked_categories)) {
    if (patterns.some((p) => new RegExp(`(?<![a-z0-9])${escapeRe(p.toLowerCase())}(?![a-z0-9])`).test(folded))) categories.add(category);
  }
  return categories.size ? { held: true, categories: [...categories].sort() } : { held: false };
}
