import React, { useState, useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeRaw from 'rehype-raw';
import { Prism as SyntaxHighlighterBase } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ImageCarousel } from './ImageCarousel';

const SyntaxHighlighter = SyntaxHighlighterBase as any;

// react-markdown's defaultUrlTransform strips any URL whose protocol isn't in
// its allowlist (http/https/irc/mailto/xmpp) — our thinkdrop-image: cache
// protocol and file:// links would be zeroed out before they ever reach the
// img/a renderers.
const urlTransform = (url: string) =>
  /^(thinkdrop-image|file):/i.test(url) ? url : defaultUrlTransform(url);

// ── Bare file-path linkification ─────────────────────────────────────────────
// AI answers often contain raw absolute paths (/Users/…/file.rtf, ~/notes). GFM
// only autolinks URL schemes, so we wrap bare paths in `file://` links ourselves
// → they render as clickable basename chips via the custom `a` component below.
// Code spans/blocks are excluded so paths inside `…`/```…``` stay literal.
const CODE_SPLIT_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;
// ≥2 path segments, unicode-safe (covers e.g. /家庭/), excludes whitespace and
// markdown/shell delimiters. Lookbehind keeps us out of URLs (':'), existing
// markdown links ('(','['), image syntax ('!'), quotes and attr assignments.
const BARE_PATH_RE = /(?<![\w/([~'"=:!])~?(?:\/[^\s'"()[\]<>|*?\\`]+){2,}\/?/g;

const linkifyFilePaths = (content: string): string => {
  if (!content || content.indexOf('/') === -1 && content.indexOf('~') === -1) return content;
  const segments = content.split(CODE_SPLIT_RE);
  for (let i = 0; i < segments.length; i += 2) { // even indices = prose
    segments[i] = segments[i].replace(BARE_PATH_RE, (m) => {
      const trimmed = m.replace(/[.,;:!?]+$/, '');
      const trailing = m.slice(trimmed.length);
      const hasExt = /\.[A-Za-z0-9]{1,10}$/.test(trimmed);
      const isDir = m.endsWith('/');
      const slashes = (trimmed.match(/\//g) || []).length;
      // Require file-extension, trailing-slash dir, or ≥3 slashes — keeps prose
      // like "and/or" or "/a/b" mentions from becoming bogus chips.
      if (!hasExt && !isDir && slashes < 3) return m;
      const name = trimmed.replace(/\/+$/, '').split('/').pop() || trimmed;
      return `[${name}](file://${encodeURI(trimmed)})${trailing}`;
    });
  }
  return segments.join('');
};

// Injected once per container: loose markdown lists wrap item text in a block
// <p>, which pushes the text below the • marker. First paragraph inline keeps
// "• text" on one line; later paragraphs stay block-level.
const LIST_FIX_CSS =
  '.rich-content-container li > p:first-of-type{display:inline;margin:0}';

// ── Overlay-safe colors ────────────────────────────────────────────────────────
// The UnifiedOverlay has a dark background. prose-invert is present but
// the explicit Tailwind classes below take precedence. We keep body text
// high-contrast (near-white) so thinking traces, plans, and answers are
// uniformly legible. Avoid low-opacity greys that disappear on dark glass.

// Factory: builds the custom `a` component for ReactMarkdown, bound to the
// caller's onFileLinkClick handler. Bare URLs are autolinked by remark-gfm's
// autolink-literal feature, so no manual linkify pre-processing is needed —
// this component just styles and routes the click (IPC shell:open-url, or
// window.open fallback, or onFileLinkClick for file:// URLs).
const makeLinkComponent = (onFileLinkClick?: (filePath: string) => void) => {
  const Link: React.FC<any> = ({ node, children, href, ...props }) => {
    const isFilePath = href?.startsWith('file://');
    const ipcRenderer = (window as any).electron?.ipcRenderer;
    const filePath = isFilePath ? decodeURIComponent(href.replace(/^file:\/\//, '')) : '';
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (!href) return;
          if (isFilePath) {
            // Prefer the caller's handler; fall back to the main-process opener
            // so file chips work on every surface without prop drilling.
            if (onFileLinkClick) onFileLinkClick(filePath);
            else ipcRenderer?.send('shell:open-path', filePath);
          } else if (ipcRenderer) {
            ipcRenderer.send('shell:open-url', href);
          } else {
            window.open(href, '_blank');
          }
        }}
        className={isFilePath
          ? 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono cursor-pointer transition-colors align-middle'
          : 'text-blue-300 hover:text-blue-200 underline cursor-pointer transition-colors'
        }
        style={isFilePath ? {
          backgroundColor: 'rgba(59,130,246,0.14)',
          border: '1px solid rgba(59,130,246,0.35)',
          color: '#93c5fd',
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          verticalAlign: 'middle',
        } : undefined}
        title={isFilePath ? filePath : undefined}
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
  };
  return Link;
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

// Search result item type for image metadata
interface SearchResultItem {
  url?: string;
  imageUrl?: string;
  originalUrl?: string;
  title?: string;
  snippet?: string;
  type?: string;
}

interface RichContentRendererProps {
  content: string;
  animated?: boolean;
  className?: string;
  onFileLinkClick?: (filePath: string) => void;
  searchResults?: SearchResultItem[]; // Optional search results for image metadata lookup
}

// Split content by image groups and render with carousel for multiple images
const renderContentWithCarousels = (
  content: string,
  imageUrlToOriginal?: Map<string, string>,
  onFileLinkClick?: (filePath: string) => void,
): React.ReactNode[] => {
  const parts: React.ReactNode[] = [];
  let partIndex = 0;
  const Link = makeLinkComponent(onFileLinkClick);
  
  // Extract ALL images from content (including those in list items)
  // This pattern matches markdown images anywhere: ![alt](url "title")
  // The `!` is REQUIRED — plain [text](url) links must NOT be treated as images.
  const imageRegex = /!\[([^\]]*)\]\(([^\s")]+)(?:\s+"([^"]*)")?\)/g;
  const allImages: { alt: string; src: string; title?: string; index: number }[] = [];
  
  let imgMatch;
  while ((imgMatch = imageRegex.exec(content)) !== null) {
    allImages.push({
      alt: imgMatch[1] || '',
      src: imgMatch[2],
      title: imgMatch[3],
      index: imgMatch.index
    });
  }
  
  // If we have 2+ images, extract them and render the rest as text without images
  if (allImages.length >= 2) {
    // Sort by index to maintain order
    allImages.sort((a, b) => a.index - b.index);
    
    // Build text content by removing images but keeping the list structure
    let processedContent = content;
    // Remove image markdown but keep surrounding context
    processedContent = processedContent.replace(imageRegex, '');
    // Clean up empty lines that might result
    processedContent = processedContent.replace(/\n\s*\n\s*\n/g, '\n\n');
    
    // Add the text content (with images removed)
    if (processedContent.trim()) {
      parts.push(
        <ReactMarkdown
          key={`text-${partIndex++}`}
          remarkPlugins={[remarkGfm, remarkBreaks]}
          rehypePlugins={[rehypeRaw]}
          urlTransform={urlTransform}
          components={{
            code({ node, inline, className, children, ...props }: any) {
              const match = /language-(\w+)/.exec(className || '');
              const codeString = String(children).replace(/\n$/, '');
              return !inline && match ? (
                <CodeBlockWithCopy code={codeString} language={match[1]} />
              ) : (
                <code className="bg-gray-800 px-2 py-1 rounded text-sm font-mono text-blue-200" {...props}>
                  {children}
                </code>
              );
            },
            a: Link,
            p: ({ children }: any) => <p className="mb-3 leading-relaxed text-white/95">{children}</p>,
          }}
        >
          {processedContent}
        </ReactMarkdown>
      );
    }
    
    // Add carousel for all extracted images
    const imageItems = allImages.map(img => ({
      src: img.src,
      alt: img.alt,
      title: img.title,
      originalUrl: imageUrlToOriginal?.get(img.src) // Look up original URL if available
    }));
    parts.push(
      <ImageCarousel key={`carousel-${partIndex++}`} images={imageItems} maxHeight={280} />
    );
    
    return parts;
  }
  
  // If we only have 0-1 images, render as normal markdown
  return [
    <ReactMarkdown
      key="full-content"
      remarkPlugins={[remarkGfm, remarkBreaks]}
      rehypePlugins={[rehypeRaw]}
      urlTransform={urlTransform}
      components={{
        code({ node, inline, className, children, ...props }: any) {
          const match = /language-(\w+)/.exec(className || '');
          const codeString = String(children).replace(/\n$/, '');
          return !inline && match ? (
            <CodeBlockWithCopy code={codeString} language={match[1]} />
          ) : (
            <code className="bg-gray-800 px-2 py-1 rounded text-sm font-mono text-blue-200" {...props}>
              {children}
            </code>
          );
        },
        a: Link,
        p: ({ children }: any) => <p className="mb-3 leading-relaxed text-white/95">{children}</p>,
      }}
    >
      {content}
    </ReactMarkdown>
  ];
};

const RichContentRenderer: React.FC<RichContentRendererProps> = ({
  content,
  animated = true,
  className = '',
  onFileLinkClick,
  searchResults,
}) => {
  // Bare URLs are autolinked by remark-gfm's autolink-literal feature; bare
  // absolute file paths are wrapped in file:// links by linkifyFilePaths so
  // they render as clickable basename chips.
  const processedContent = useMemo(() => linkifyFilePaths(content), [content]);
  
  // Build lookup map from image URL to original source URL for click-to-view
  const imageUrlToOriginal = useMemo(() => {
    const map = new Map<string, string>();
    if (searchResults) {
      searchResults.forEach(result => {
        if (result.imageUrl && result.originalUrl) {
          map.set(result.imageUrl, result.originalUrl);
        }
      });
    }
    return map;
  }, [searchResults]);
  
  // Check if content has 2+ images for the carousel — they don't need to be
  // adjacent; interleaved text/image content otherwise stacks <img>s vertically.
  // The `!` is REQUIRED — plain [text](url) links must NOT trigger the carousel.
  const hasImageGroups = (processedContent.match(/!\[[^\]]*\]\(/g) || []).length >= 2;

  // Use carousel rendering for content with multiple image groups
  if (hasImageGroups) {
    return (
      <div
        className={`rich-content-container prose-sm max-w-none ${animated ? 'animate-fade-in' : ''} ${className}`}
        style={{ overflowWrap: 'break-word', wordBreak: 'break-word', minWidth: 0, ...(animated ? { animation: 'fadeIn 0.3s ease-in-out' } : {}) }}
      >
        <style>{LIST_FIX_CSS}</style>
        {renderContentWithCarousels(processedContent, imageUrlToOriginal, onFileLinkClick)}
      </div>
    );
  }

  const Link = makeLinkComponent(onFileLinkClick);

  return (
    <div
      className={`rich-content-container prose-sm max-w-none ${animated ? 'animate-fade-in' : ''} ${className}`}
      style={{ overflowWrap: 'break-word', wordBreak: 'break-word', minWidth: 0, ...(animated ? { animation: 'fadeIn 0.3s ease-in-out' } : {}) }}
    >
      <style>{LIST_FIX_CSS}</style>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeRaw]}
        urlTransform={urlTransform}
        components={{
          code({ node, inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            const codeString = String(children).replace(/\n$/, '');

            return !inline && match ? (
              <CodeBlockWithCopy code={codeString} language={match[1]} />
            ) : (
              <code className="bg-gray-800 px-2 py-1 rounded text-sm font-mono text-blue-200" {...props}>
                {children}
              </code>
            );
          },
          a: Link,
          img({ src, alt, title, ...props }: any) {
            if (!src) return null;
            
            // Security validation
            const isDataUrl = src.startsWith('data:');
            const isHttpUrl = src.startsWith('http://') || src.startsWith('https://');
            // thinkdrop-image:// serves locally-cached images from
            // ~/.thinkdrop/image-cache — trusted, registered in main.js.
            const isThinkdropImage = src.startsWith('thinkdrop-image:');

            if (!isDataUrl && !isHttpUrl && !isThinkdropImage) {
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
              <span style={{ display: 'block' }} className="my-4 max-w-full">
                <img
                  src={src}
                  alt={alt || ''}
                  title={title || alt}
                  className="max-w-full h-auto rounded-lg shadow-lg border border-gray-600/30 cursor-pointer hover:border-blue-500/50 transition-colors"
                  style={{ maxHeight: '400px', objectFit: 'contain' }}
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  onError={(e) => {
                    const target = e.target as HTMLImageElement;
                    const errorSpan = document.createElement('span');
                    errorSpan.style.display = 'block';
                    errorSpan.className = 'my-2 inline-flex items-center gap-2 px-2 py-1 rounded text-xs bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 cursor-pointer hover:bg-yellow-500/30';
                    errorSpan.title = src;
                    errorSpan.onclick = () => {
                      const ipcRenderer = (window as any).electron?.ipcRenderer;
                      if (ipcRenderer) {
                        ipcRenderer.send('shell:open-url', src);
                      } else {
                        window.open(src, '_blank');
                      }
                    };
                    errorSpan.innerHTML = `
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                      </svg>
                      Failed to load - click to open in browser
                    `;
                    target.style.display = 'none';
                    target.parentNode?.insertBefore(errorSpan, target.nextSibling);
                  }}
                  onClick={() => {
                    if (isHttpUrl || isThinkdropImage) {
                      const ipcRenderer = (window as any).electron?.ipcRenderer;
                      if (ipcRenderer) {
                        ipcRenderer.send('shell:open-url', src);
                      } else if (isHttpUrl) {
                        window.open(src, '_blank');
                      }
                    }
                  }}
                  {...props}
                />
                {(alt || title) && (
                  <span style={{ display: 'block' }} className="text-xs text-gray-300 mt-1 italic text-center">
                    {alt || title}
                  </span>
                )}
              </span>
            );
          },
          h1({ node, children, ...props }: any) {
            return <h1 className="text-2xl font-bold mb-4 mt-6 text-white" {...props}>{children}</h1>;
          },
          h2({ node, children, ...props }: any) {
            return <h2 className="text-xl font-semibold mb-3 mt-5 text-white" {...props}>{children}</h2>;
          },
          h3({ node, children, ...props }: any) {
            return <h3 className="text-lg font-medium mb-2 mt-4 text-white" {...props}>{children}</h3>;
          },
          p({ node, children, ...props }: any) {
            return <p className="mb-3 leading-relaxed text-white/95" {...props}>{children}</p>;
          },
          ul({ node, children, ...props }: any) {
            return <ul className="list-disc list-inside mb-3 space-y-1 text-white/95 ml-4" {...props}>{children}</ul>;
          },
          ol({ node, children, ...props }: any) {
            return <ol className="list-decimal list-inside mb-3 space-y-1 text-white/95 ml-4" {...props}>{children}</ol>;
          },
          li({ node, children, ...props }: any) {
            return <li className="text-white/95" {...props}>{children}</li>;
          },
          blockquote({ node, children, ...props }: any) {
            return (
              <blockquote className="border-l-4 border-blue-300 pl-4 italic mb-3 text-white/85 bg-blue-500/10 py-2 rounded-r-lg" {...props}>
                {children}
              </blockquote>
            );
          },
          table({ node, children, ...props }: any) {
            return <table className="min-w-full border border-gray-600 mb-4" {...props}>{children}</table>;
          },
          thead({ node, children, ...props }: any) {
            return <thead className="bg-gray-800" {...props}>{children}</thead>;
          },
          th({ node, children, ...props }: any) {
            return <th className="border border-gray-600 px-4 py-2 text-left text-white" {...props}>{children}</th>;
          },
          td({ node, children, ...props }: any) {
            return <td className="border border-gray-600 px-4 py-2 text-white/95" {...props}>{children}</td>;
          },
          hr({ node, ...props }: any) {
            return <hr className="border-gray-600 my-4" {...props} />;
          },
          strong({ node, children, ...props }: any) {
            return <strong className="font-bold text-white" {...props}>{children}</strong>;
          },
          em({ node, children, ...props }: any) {
            return <em className="italic text-white/95" {...props}>{children}</em>;
          },
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
};

export default RichContentRenderer;
