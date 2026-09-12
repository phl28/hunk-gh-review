import type { Root, RootContent } from "hast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeRemark from "rehype-remark";
import remarkStringify from "remark-stringify";

/** Keep text and structure that a terminal can display, without fetching images. */
function terminalHtml() {
  return (tree: Root) => {
    function clean(nodes: RootContent[]): RootContent[] {
      return nodes.flatMap((node): RootContent[] => {
        if (node.type === "comment") return [];
        if (node.type !== "element") return [node];
        if (["script", "style"].includes(node.tagName)) return [];
        if (node.tagName === "img") {
          return typeof node.properties.alt === "string"
            ? [{ type: "text", value: node.properties.alt }]
            : [];
        }
        node.children = clean(node.children) as typeof node.children;
        // Bot badges often link to "#", which adds noise without a destination.
        if (node.tagName === "a" && (!node.properties.href || node.properties.href === "#")) {
          return node.children;
        }
        return [node];
      });
    }
    tree.children = clean(tree.children);
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(terminalHtml)
  .use(rehypeRemark)
  .use(remarkStringify);

/** Parse HTML outside code, preserving Markdown structure and literal code. */
export function renderCommentMarkdown(body: string): string {
  return String(processor.processSync(body));
}
