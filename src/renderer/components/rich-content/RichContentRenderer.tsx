import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeRaw from 'rehype-raw';
import { Prism as SyntaxHighlighterBase } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

const SyntaxHighlighter = SyntaxHighlighterBase as any;

// Convert bare URLs to markdown links for clickability
const linkifyContent = (content: string): string => {
  // Match URLs that are not already inside markdown links or HTML tags
  // Pattern: http:// or https:// followed by non-whitespace, not preceded by ]( or href=" or >
  const urlRegex = /(?<![\]\(])(?<![\w-])(?<!["'])\b(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/gi;
  
  return content.replace(urlRegex, (url) => {
    // Clean up trailing punctuation that might be part of the URL context
    const cleanUrl = url.replace(/[.,;!?]+$/, '');
    const trailing = url.slice(cleanUrl.length);
    // Output raw HTML <a> tag for ReactMarkdown to render as clickable link
    return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>${trailing}`;
  });
};

// Code block wrapper with copy button
const CodeBlockWithCopy: React.FC<{ code: string; language: string }> = ({ code, language }) => {
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = async () => {
    const ipcRenderer = (window as any).electron?.ipcRenderer;
    if (ipcRenderer) {
      ipcRenderer.send('clipboard:write-text', code);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  };

  return (
    <div className="relative group">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded opacity-0 group-hover:opacity-100 transition-opacity"
        style={{
          backgroundColor: isCopied ? 'rgba(34, 197, 94, 0.2)' : 'rgba(255, 255, 255, 0.1)',
          border: '1px solid rgba(255, 255, 255, 0.2)',
          color: isCopied ? '#22c55e' : '#9ca3af',
          cursor: 'pointer',
        }}
        title={isCopied ? 'Copied!' : 'Copy code'}
      >
        {isCopied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        )}
      </button>
      <SyntaxHighlighter
        style={vscDarkPlus}
        language={language}
        PreTag="div"
        className="rounded-lg my-4"
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
};

interface RichContentRendererProps {
  content: string;
  animated?: boolean;
  className?: string;
  onFileLinkClick?: (filePath: string) => void;
}

const RichContentRenderer: React.FC<RichContentRendererProps> = ({
  content,
  animated = true,
  className = '',
  onFileLinkClick,
}) => {
  // Pre-process content to make bare URLs clickable
  const processedContent = linkifyContent(content);

  return (
    <div
      className={`rich-content-container prose prose-invert prose-sm max-w-none ${animated ? 'animate-fade-in' : ''} ${className}`}
      style={{ overflowWrap: 'break-word', wordBreak: 'break-word', minWidth: 0, ...(animated ? { animation: 'fadeIn 0.3s ease-in-out' } : {}) }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeRaw]}
        components={{
          code({ node, inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            const codeString = String(children).replace(/\n$/, '');
            
            return !inline && match ? (
              <CodeBlockWithCopy code={codeString} language={match[1]} />
            ) : (
              <code className="bg-gray-800 px-2 py-1 rounded text-sm font-mono text-blue-300" {...props}>
                {children}
              </code>
            );
          },
          a({ node, children, href, ...props }: any) {
            const isFilePath = href?.startsWith('file://');
            const ipcRenderer = (window as any).electron?.ipcRenderer;
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  if (!href) return;
                  if (isFilePath && onFileLinkClick) {
                    const filePath = href.replace(/^file:\/\//, '');
                    onFileLinkClick(filePath);
                  } else if (ipcRenderer) {
                    ipcRenderer.send('shell:open-url', href);
                  } else {
                    window.open(href, '_blank');
                  }
                }}
                className={isFilePath
                  ? 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono cursor-pointer transition-colors'
                  : 'text-blue-400 hover:text-blue-300 underline cursor-pointer transition-colors'
                }
                style={isFilePath ? {
                  backgroundColor: 'rgba(59,130,246,0.12)',
                  border: '1px solid rgba(59,130,246,0.3)',
                  color: '#93c5fd',
                } : undefined}
                title={isFilePath ? href.replace(/^file:\/\//, '') : undefined}
                {...props}
              >
                {isFilePath && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                  </svg>
                )}
                {children}
              </a>
            );
          },
          img({ src, alt, title, ...props }: any) {
            if (!src) return null;
            
            // Security validation
            const isDataUrl = src.startsWith('data:');
            const isHttpUrl = src.startsWith('http://') || src.startsWith('https://');
            
            if (!isDataUrl && !isHttpUrl) {
              return (
                <div className="inline-flex items-center gap-2 px-2 py-1 rounded text-xs bg-red-500/20 text-red-400 border border-red-500/30">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                  </svg>
                  Blocked image: invalid protocol
                </div>
              );
            }
            
            return (
              <div className="my-4 max-w-full">
                <img
                  src={src}
                  alt={alt || ''}
                  title={title || alt}
                  className="max-w-full h-auto rounded-lg shadow-lg border border-gray-600/30"
                  style={{ maxHeight: '400px', objectFit: 'contain' }}
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    target.style.display = 'none';
                    const errorDiv = document.createElement('div');
                    errorDiv.className = 'inline-flex items-center gap-2 px-2 py-1 rounded text-xs bg-yellow-500/20 text-yellow-400 border border-yellow-500/30';
                    errorDiv.innerHTML = `
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                      </svg>
                      Failed to load image
                    `;
                    target.parentNode?.insertBefore(errorDiv, target.nextSibling);
                  }}
                  onClick={() => {
                    if (isHttpUrl) {
                      const ipcRenderer = (window as any).electron?.ipcRenderer;
                      if (ipcRenderer) {
                        ipcRenderer.send('shell:open-url', src);
                      } else {
                        window.open(src, '_blank');
                      }
                    }
                  }}
                  {...props}
                />
                {(alt || title) && (
                  <div className="text-xs text-gray-400 mt-1 italic text-center">
                    {alt || title}
                  </div>
                )}
              </div>
            );
          },
          h1({ node, children, ...props }: any) {
            return <h1 className="text-2xl font-bold mb-4 mt-6 text-white" {...props}>{children}</h1>;
          },
          h2({ node, children, ...props }: any) {
            return <h2 className="text-xl font-semibold mb-3 mt-5 text-white/90" {...props}>{children}</h2>;
          },
          h3({ node, children, ...props }: any) {
            return <h3 className="text-lg font-medium mb-2 mt-4 text-white/80" {...props}>{children}</h3>;
          },
          p({ node, children, ...props }: any) {
            return <p className="mb-3 leading-relaxed text-white/70" {...props}>{children}</p>;
          },
          ul({ node, children, ...props }: any) {
            return <ul className="list-disc list-inside mb-3 space-y-1 text-white/70 ml-4" {...props}>{children}</ul>;
          },
          ol({ node, children, ...props }: any) {
            return <ol className="list-decimal list-inside mb-3 space-y-1 text-white/70 ml-4" {...props}>{children}</ol>;
          },
          li({ node, children, ...props }: any) {
            return <li className="text-white/70" {...props}>{children}</li>;
          },
          blockquote({ node, children, ...props }: any) {
            return (
              <blockquote className="border-l-4 border-blue-400 pl-4 italic mb-3 text-white/60 bg-blue-500/10 py-2 rounded-r-lg" {...props}>
                {children}
              </blockquote>
            );
          },
          table({ node, children, ...props }: any) {
            return <table className="min-w-full border border-gray-700 mb-4" {...props}>{children}</table>;
          },
          thead({ node, children, ...props }: any) {
            return <thead className="bg-gray-800" {...props}>{children}</thead>;
          },
          th({ node, children, ...props }: any) {
            return <th className="border border-gray-700 px-4 py-2 text-left text-white/90" {...props}>{children}</th>;
          },
          td({ node, children, ...props }: any) {
            return <td className="border border-gray-700 px-4 py-2 text-white/70" {...props}>{children}</td>;
          },
          hr({ node, ...props }: any) {
            return <hr className="border-gray-700 my-4" {...props} />;
          },
          strong({ node, children, ...props }: any) {
            return <strong className="font-bold text-white" {...props}>{children}</strong>;
          },
          em({ node, children, ...props }: any) {
            return <em className="italic text-white/80" {...props}>{children}</em>;
          },
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
};

export default RichContentRenderer;
