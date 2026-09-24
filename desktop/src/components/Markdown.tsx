import 'highlight.js/styles/github-dark.css';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import { openExternal } from '@/lib/open';

// Raw HTML in model output is not rendered (react-markdown default), so answers cannot inject markup.
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ href, children: c }) => (
            <a href={href} onClick={(e) => { e.preventDefault(); if (href) openExternal(href); }}>
              {c}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
