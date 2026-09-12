import { expect, test } from "bun:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { renderCommentMarkdown } from "./comment-markdown";

function nodes(markdown: string, type: string): any[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  function visit(node: any): any[] {
    return [...(node.type === type ? [node] : []), ...(node.children ?? []).flatMap(visit)];
  }
  return visit(tree);
}

test("Greptile-style HTML badges become their alt text beside Markdown headings", () => {
  const body = '<a href="#"><img alt="P1" src="https://example.test/p1.svg" align="top"></a> **Slow control can falsely pass**';
  const result = renderCommentMarkdown(body);
  expect(result.trim()).toBe("P1 **Slow control can falsely pass**");
  expect(nodes(result, "html")).toEqual([]);
});

test("HTML structure and entities become headings, links, lists, and text", () => {
  const result = renderCommentMarkdown('<h3>Review &amp; fix</h3><p>See <a href="https://example.test/docs">details</a>.<br>Next &lt; step.</p><ul><li>First</li><li><strong>Second</strong></li></ul>');
  expect(nodes(result, "heading")[0].depth).toBe(3);
  expect(nodes(result, "link")[0].url).toBe("https://example.test/docs");
  expect(nodes(result, "listItem")).toHaveLength(2);
  expect(nodes(result, "strong")[0].children[0].value).toBe("Second");
  expect(nodes(result, "text").map(node => node.value).join(" ")).toContain("Next < step.");
  expect(nodes(result, "html")).toEqual([]);
});

test("fenced and inline code preserve literal tags, entities, and indentation", () => {
  const code = '  const value = "<img alt=\"P1\"> &amp;";\n\treturn value < limit;';
  const body = 'Keep `<b> &amp;` literal.\n\n```ts\n' + code + '\n```';
  const result = renderCommentMarkdown(body);
  expect(nodes(result, "code")[0].value).toBe(code);
  expect(nodes(result, "code")[0].lang).toBe("ts");
  expect(nodes(result, "inlineCode")[0].value).toBe("<b> &amp;");
});

test("GFM tables, task lists, and strikethrough survive normalization", () => {
  const result = renderCommentMarkdown('| Check | Result |\n| --- | --- |\n| A | pass |\n\n- [x] ~~old~~\n- [ ] new');
  expect(nodes(result, "table")).toHaveLength(1);
  expect(nodes(result, "listItem").map(node => node.checked)).toEqual([true, false]);
  expect(nodes(result, "delete")[0].children[0].value).toBe("old");
});

test("images keep readable labels without image URLs or empty anchor targets", () => {
  const result = renderCommentMarkdown('![Build status](https://example.test/badge.svg) <img src="https://example.test/decoration.svg">');
  expect(result.trim()).toBe("Build status");
  expect(nodes(result, "image")).toEqual([]);
});

test("non-content HTML and hidden comments do not obscure the review", () => {
  const result = renderCommentMarkdown('<!-- generated -->\n<script>noise()</script><style>.badge { color: red }</style><p>Actual finding</p>');
  expect(result.trim()).toBe("Actual finding");
});
