import { describe, expect, it } from "vitest";
import { remarkTaskRefs, splitTaskRefs } from "./task-refs";

const known = new Set(["PRV-15", "ACM-2", "UTF-8"]);

describe("splitTaskRefs", () => {
  it("splits known ids out of the text", () => {
    expect(splitTaskRefs("Waits for PRV-15, then ACM-2.", known)).toEqual([
      "Waits for ",
      { id: "PRV-15" },
      ", then ",
      { id: "ACM-2" },
      ".",
    ]);
    expect(splitTaskRefs("PRV-15", known)).toEqual([{ id: "PRV-15" }]);
  });

  it("leaves unknown ids and lookalikes as text", () => {
    for (const text of [
      "PRV-16 is new",
      "SHA-256",
      "xPRV-15",
      "PRV-150",
      "PRV-15a",
      "A-PRV-15",
      "PRV-15.2",
    ]) {
      expect(splitTaskRefs(text, known), text).toEqual([text]);
    }
  });

  it("does nothing without known ids", () => {
    expect(splitTaskRefs("PRV-15", new Set())).toEqual(["PRV-15"]);
  });
});

describe("remarkTaskRefs", () => {
  const text = (value: string) => ({ type: "text", value });
  const ref = (id: string, child: object) => ({
    type: "taskRef",
    children: [child],
    data: { hName: "span", hProperties: { dataTaskRef: id } },
  });

  it("marks ids in text and in inline code that is only an id", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            text("See PRV-15 and "),
            { type: "inlineCode", value: "ACM-2" },
            { type: "inlineCode", value: "git log PRV-15" },
          ],
        },
      ],
    };
    remarkTaskRefs({ known })(tree);
    expect(tree.children[0]?.children).toEqual([
      text("See "),
      ref("PRV-15", text("PRV-15")),
      text(" and "),
      ref("ACM-2", { type: "inlineCode", value: "ACM-2" }),
      { type: "inlineCode", value: "git log PRV-15" },
    ]);
  });

  it("leaves links and code blocks alone", () => {
    const link = { type: "link", url: "https://a.dev", children: [text("PRV-15")] };
    const code = { type: "code", value: "PRV-15" };
    const tree = { type: "root", children: [{ type: "paragraph", children: [link] }, code] };
    remarkTaskRefs({ known })(tree);
    expect(tree.children).toEqual([{ type: "paragraph", children: [link] }, code]);
  });
});
