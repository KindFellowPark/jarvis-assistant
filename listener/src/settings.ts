// The allow and deny rules for a sender's run, built from config.ts. The original install keeps a
// hand-written settings.json in each run folder; this public copy writes it from code (src/setup.ts)
// so the absolute paths fit whatever machine it is cloned to. The rules are the same shape.
import { HOUSEHOLD, NOTES_VAULT, PRIVATE_DIRS, type Sender } from "./config";

const MCP_TOOLS: Record<string, string[]> = {
  mail: ["mcp__mail__search", "mcp__mail__read", "mcp__mail__draft", "mcp__mail__send"],
  calendar: ["mcp__calendar__events", "mcp__calendar__add", "mcp__calendar__change", "mcp__calendar__remove"],
  maps: ["mcp__maps__drive", "mcp__maps__places"],
  bills: ["mcp__bills__add"],
  lists: ["mcp__lists__append"],
};

// "Read(//abs/path/**)": Claude Code reads a leading double slash as an absolute path.
const read = (dir: string) => `Read(/${dir}/**)`;

export function runSettings(s: Sender): { permissions: { allow: string[]; deny: string[] } } {
  const flags = { mail: s.mail, calendar: s.calendar, maps: s.maps, bills: s.bills, lists: s.lists };
  return {
    permissions: {
      allow: [...s.addDirs.map(read), ...Object.entries(flags).flatMap(([k, on]) => (on ? MCP_TOOLS[k]! : []))],
      deny: [read(`${HOUSEHOLD}/travel/skill`), read(`${NOTES_VAULT}/Ideas`), ...PRIVATE_DIRS.map(read)],
    },
  };
}
