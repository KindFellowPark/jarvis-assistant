// Lists tool checks. A run can append one line to one list in the vault's Lists folder:
//   1. the line lands dated and signed, the list is created when missing, and an open-ended file is closed first;
//   2. a name with a slash, a dot-dot, a leading dot or a path character is refused before any path is built;
//   3. the path can never leave the Lists folder, and a test override is honoured only under the temp dir;
//   4. one run adds at most MAX_APPENDS lines, the server offers exactly one tool, and nothing is changed or removed.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLine, LISTS_DIR, listPath, listsDir, MAX_APPENDS, toLine, whoTexted, type ListsDeps } from "../src/lists/append";
import { TOOLS } from "../src/lists/server";
import { NOTES_VAULT, ROOT } from "../src/config";

function fakeDeps(who = "Sam"): ListsDeps & { dir: string } {
  return { dir: mkdtempSync(join(tmpdir(), "jarvis-lists-")), who, today: () => "2026-10-18", appends: { n: 0 } };
}
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

describe("the line", () => {
  test("is dated and signed, and the list is created when it is missing", async () => {
    const deps = fakeDeps();
    const out = await appendLine({ list: "Hardware store", text: "  a second  box of picture hooks " }, deps);
    expect(out).toEqual({ added: true, list: "Hardware store", created: true, line: "2026-10-18 Sam: a second box of picture hooks" });
    expect(readdirSync(deps.dir)).toEqual(["Hardware store.md"]);
    expect(read(deps.dir, "Hardware store.md")).toBe("2026-10-18 Sam: a second box of picture hooks\n");
  });

  test("goes on the end of an existing list, closing an open-ended last line first", async () => {
    const deps = fakeDeps("Alex");
    writeFileSync(join(deps.dir, "Shopping.md"), "milk\neggs");
    expect((await appendLine({ list: "Shopping.md", text: "bread" }, deps)).created).toBe(false);
    expect(read(deps.dir, "Shopping.md")).toBe("milk\neggs\n2026-10-18 Alex: bread\n");
    await appendLine({ list: "Shopping", text: "butter" }, deps);
    expect(read(deps.dir, "Shopping.md")).toBe("milk\neggs\n2026-10-18 Alex: bread\n2026-10-18 Alex: butter\n");
    const deps2 = fakeDeps("Alex");
    writeFileSync(join(deps2.dir, "Shopping.md"), "");
    await appendLine({ list: "Shopping", text: "bread" }, deps2);
    expect(read(deps2.dir, "Shopping.md")).toBe("2026-10-18 Alex: bread\n");
  });

  test("a newline inside the text never makes a second line", async () => {
    const deps = fakeDeps();
    await appendLine({ list: "Shopping", text: "bread\nand then\r\nbutter" }, deps);
    expect(read(deps.dir, "Shopping.md")).toBe("2026-10-18 Sam: bread and then butter\n");
  });

  test("names the sender from the key the server was started with", () => {
    expect(whoTexted("alex")).toBe("Alex");
    expect(whoTexted("sam")).toBe("Sam");
    expect(() => whoTexted(undefined)).toThrow("without a sender");
    expect(() => whoTexted("stranger")).toThrow("without a sender");
  });
});

describe("refusals", () => {
  test("bad names and bad text are refused before any path is built, and nothing is written", async () => {
    const deps = fakeDeps();
    for (const bad of [
      {}, { list: " ", text: "x" }, { list: "x".repeat(81), text: "x" }, { list: "Shopping", text: " " }, { list: "Shopping", text: "x".repeat(501) },
      { list: "../Ideas/secret", text: "x" }, { list: "..", text: "x" }, { list: "a/b", text: "x" }, { list: "a\\b", text: "x" }, { list: "/etc/passwd", text: "x" },
      { list: "Shopping..", text: "x" }, { list: ".hidden", text: "x" }, { list: "a:b", text: "x" }, { list: "a\0b", text: "x" }, { list: 5, text: "x" }, { list: "Shopping", text: 5 },
    ]) {
      await expect(appendLine(bad as any, deps)).rejects.toThrow();
    }
    expect(readdirSync(deps.dir)).toEqual([]);
  });

  test("the path is always one file directly inside the Lists folder", () => {
    expect(listPath("Shopping", "/v/Lists")).toBe("/v/Lists/Shopping.md");
    expect(listPath("Hardware store", "/v/Lists/")).toBe("/v/Lists/Hardware store.md");
    expect(() => listPath("../Lists", "/v/Lists")).toThrow("directly inside");
    expect(() => listPath("sub/Shopping", "/v/Lists")).toThrow("directly inside");
    expect(() => listPath("/tmp/x", "/v/Lists")).toThrow("directly inside");
  });

  test("the real folder is the vault's Lists folder, and an override counts only under the temp dir", () => {
    expect(LISTS_DIR).toBe(join(NOTES_VAULT, "Lists"));
    expect(listsDir("")).toBe(LISTS_DIR);
    expect(listsDir(ROOT)).toBe(LISTS_DIR);
    expect(listsDir("/etc")).toBe(LISTS_DIR);
    const tmp = mkdtempSync(join(tmpdir(), "jarvis-lists-"));
    expect(listsDir(tmp)).toBe(tmp);
  });

  test(`one run adds at most ${MAX_APPENDS} lines`, async () => {
    const deps = fakeDeps();
    for (let i = 0; i < MAX_APPENDS; i++) expect((await appendLine({ list: "Shopping", text: `item ${i}` }, deps)).added).toBe(true);
    await expect(appendLine({ list: "Shopping", text: "one more" }, deps)).rejects.toThrow("at most");
    expect(read(deps.dir, "Shopping.md").split("\n").filter(Boolean)).toHaveLength(MAX_APPENDS);
  });

  test("the fields are tidied", () => {
    expect(toLine({ list: "  Hardware   store.MD ", text: " hooks \n" })).toEqual({ list: "Hardware store", text: "hooks" });
  });

  test("the server offers exactly one tool, and it cannot change or remove a line", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["append"]);
    expect(TOOLS[0].inputSchema.required).toEqual(["list", "text"]);
  });
});
