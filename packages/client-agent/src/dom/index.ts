/**
 * Browser-only helper: turns visible sections of a page into grounding text for
 * one assistant turn. Kept in its own subpath so `client-agent/core` stays
 * usable in a worker or on the server, where there is no DOM.
 */
import { tokenize } from '../core/retriever.js';

export interface DomSection {
  /** CSS selector for the section, e.g. "#experience". */
  selector: string;
  /** Human label used as a heading in the prompt. */
  label: string;
}

export interface DomContextOptions {
  sections: DomSection[];
  /** Total characters kept. Default 2800, roughly 700 tokens. */
  maxChars?: number;
  /** Characters per section before truncation. Default 700. */
  perSectionChars?: number;
  /** Element to read inside. Defaults to `document`. */
  root?: ParentNode;
}

const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TD|TH|TR|UL)$/;

function normalize(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Reads the section as text with block boundaries preserved. `innerText` is the
 * honest source in a browser, but it does not exist in every DOM
 * implementation, so fall back to walking the tree instead of gluing headings
 * onto the paragraph below them.
 */
function readText(element: Element): string {
  const inner = (element as HTMLElement).innerText;
  if (typeof inner === 'string' && inner.trim()) return normalize(inner);

  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const child = node as Element;
    const block = BLOCK.test(child.tagName);
    if (block) parts.push('\n');
    if (child.tagName === 'BR') parts.push('\n');
    child.childNodes.forEach(walk);
    if (block) parts.push('\n');
  };
  element.childNodes.forEach(walk);
  return normalize(parts.join(''));
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const boundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return `${(boundary > limit * 0.6 ? cut.slice(0, boundary + 1) : cut).trimEnd()}…`;
}

/**
 * Returns a function for `AgentRuntimeOptions.readContext`. Sections are ranked
 * by the visitor's words, so a question about experience keeps the experience
 * text and drops the blog when the budget is tight.
 */
export function createDomContextReader(options: DomContextOptions): (query?: string) => string {
  const maxChars = options.maxChars ?? 2800;
  const perSection = options.perSectionChars ?? 700;

  return (query = '') => {
    const scope = options.root ?? (typeof document === 'undefined' ? undefined : document);
    if (!scope) return '';
    const terms = new Set(tokenize(query));

    const found = options.sections.map((section, index) => {
      const element = scope.querySelector(section.selector);
      const text = element ? readText(element) : '';
      let score = 0;
      if (terms.size > 0 && text) {
        const words = new Set(tokenize(`${section.label} ${text}`));
        for (const term of terms) if (words.has(term)) score += 1;
      }
      return { section, text, score, index };
    }).filter((entry) => entry.text.length > 0);

    if (found.length === 0) return '';

    found.sort((a, b) => b.score - a.score || a.index - b.index);

    const blocks: string[] = [];
    let used = 0;
    for (const entry of found) {
      const body = clip(entry.text, perSection);
      const block = `### ${entry.section.label}\n${body}`;
      if (used + block.length > maxChars && blocks.length > 0) break;
      blocks.push(block);
      used += block.length + 2;
    }
    return blocks.join('\n\n');
  };
}
