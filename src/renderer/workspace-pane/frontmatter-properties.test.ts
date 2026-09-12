import { describe, expect, it } from "vitest";
import {
  addFrontmatterProperty,
  deleteFrontmatterProperty,
  parseFrontmatterProperties,
  updateFrontmatterProperty,
} from "./frontmatter-properties";

describe("frontmatter properties", () => {
  it("recognizes editable scalar types and keeps nested values read-only", () => {
    const source = `---
title: Hello
tags: [one, two]
count: 2
published: 2024-01-02
featured: true
empty: null
nested:
  owner: Ada
objects:
  - owner: Grace
---
# Note
`;

    expect(parseFrontmatterProperties(source)).toMatchObject({
      status: "ready",
      properties: [
        { name: "title", type: "text", value: "Hello", editable: true },
        { name: "tags", type: "list", value: ["one", "two"], editable: true },
        { name: "count", type: "number", value: 2, editable: true },
        { name: "published", type: "date", value: "2024-01-02", editable: true },
        { name: "featured", type: "checkbox", value: true, editable: true },
        { name: "empty", type: "text", value: null, editable: true },
        { name: "nested", type: "nested", editable: false },
        { name: "objects", type: "nested", editable: false },
      ],
    });
  });

  it("reports malformed or unclosed YAML without hiding Markdown content", () => {
    const malformed = "---\ntitle: [broken\n---\n# Still readable\n";
    const unclosed = "---\ntitle: note\n# Still source-editable\n";

    expect(parseFrontmatterProperties(malformed)).toMatchObject({
      status: "malformed",
      error: "Frontmatter YAML is malformed.",
    });
    expect(parseFrontmatterProperties(unclosed)).toMatchObject({
      status: "malformed",
      error: "Frontmatter is not closed.",
    });
  });

  it("patches only the changed pair and leaves untouched source byte-for-byte", () => {
    const source = "---\r\ntitle: 'Old' # retain only while untouched\r\ntags:\r\n  - one # exact\r\n  - two\r\ncount: 2\r\n---\r\n# Body\r\n";
    const renamed = updateFrontmatterProperty(source, 0, {
      name: "heading",
      type: "text",
      value: "New",
    });

    expect(renamed).toBe("---\r\nheading: New\r\ntags:\r\n  - one # exact\r\n  - two\r\ncount: 2\r\n---\r\n# Body\r\n");
  });

  it("uses stable lossy conversions and supports scalar arrays containing null", () => {
    const source = "---\nvalue: words\n---\nBody\n";
    const asNumber = updateFrontmatterProperty(source, 0, { type: "number" });
    const asCheckbox = updateFrontmatterProperty(asNumber, 0, { type: "checkbox" });
    const asList = updateFrontmatterProperty(asCheckbox, 0, { type: "list" });
    const withNull = updateFrontmatterProperty(asList, 0, { value: ["false", null, 3] });

    expect(asNumber).toBe("---\nvalue: 0\n---\nBody\n");
    expect(asCheckbox).toBe("---\nvalue: false\n---\nBody\n");
    expect(withNull).toBe('---\nvalue: ["false",null,3]\n---\nBody\n');
    expect(parseFrontmatterProperties(withNull)).toMatchObject({
      status: "ready",
      properties: [{ type: "list", value: ["false", null, 3], editable: true }],
    });
  });

  it("keeps invalid dates as text and protects unsafe integer scalars", () => {
    const parsed = parseFrontmatterProperties(
      "---\ninvalidDate: 2024-02-30\nlarge: 9007199254740993\ninfinite: .inf\n---\nBody\n",
    );

    expect(parsed).toMatchObject({
      status: "ready",
      properties: [
        { name: "invalidDate", type: "text", value: "2024-02-30", editable: true },
        { name: "large", type: "nested", editable: false },
        { name: "infinite", type: "number", value: Infinity, editable: true },
      ],
    });
  });

  it("keeps date-shaped text quoted so explicit text conversion is stable", () => {
    const source = "---\nvalue: 2024-01-02\n---\nBody\n";
    const asText = updateFrontmatterProperty(source, 0, { type: "text" });

    expect(asText).toBe('---\nvalue: "2024-01-02"\n---\nBody\n');
    expect(parseFrontmatterProperties(asText)).toMatchObject({
      status: "ready",
      properties: [{ name: "value", type: "text", value: "2024-01-02" }],
    });
  });

  it("preserves comments that belong between or after untouched properties", () => {
    const source = "---\na: 1\n# belongs before b\nb: 2\n# trailing note\n---\nBody\n";

    expect(updateFrontmatterProperty(source, 0, { value: 3 })).toBe(
      "---\na: 3\n# belongs before b\nb: 2\n# trailing note\n---\nBody\n",
    );
    expect(updateFrontmatterProperty(source, 1, { value: 4 })).toBe(
      "---\na: 1\n# belongs before b\nb: 4\n# trailing note\n---\nBody\n",
    );
  });

  it("accepts empty frontmatter and appends its first property", () => {
    expect(parseFrontmatterProperties("---\n---\nBody\n")).toEqual({
      status: "ready",
      properties: [],
    });
    expect(addFrontmatterProperty("---\n---\nBody\n", "title", "text")).toBe(
      '---\ntitle: ""\n---\nBody\n',
    );
  });

  it("adds before the closing delimiter and deletes without reordering other properties", () => {
    const source = "---\ntitle: Note\ncount: 2\n---\n# Body\n";
    const added = addFrontmatterProperty(source, "tags", "list");
    const deleted = deleteFrontmatterProperty(added, 1);

    expect(added).toBe("---\ntitle: Note\ncount: 2\ntags: []\n---\n# Body\n");
    expect(deleted).toBe("---\ntitle: Note\ntags: []\n---\n# Body\n");
    expect(addFrontmatterProperty("# Body\n", "status", "text")).toBe(
      "---\nstatus: \"\"\n---\n# Body\n",
    );
  });
});
