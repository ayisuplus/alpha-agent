import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Model output is untrusted: links never navigate the workbench and remote images are never loaded.
const components: Components = {
  a: ({ children, href }) => <span className="md-link" title={href}>{children}</span>,
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} disallowedElements={["img"]} skipHtml>{text}</ReactMarkdown>
  </div>;
});
