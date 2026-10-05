// Making untrusted email HTML safe to display.
//
// Defence in depth:
//   1. sanitize-html removes scripts, event handlers, forms, frames, objects and
//      javascript: URLs on the server.
//   2. The client shows the result in an <iframe sandbox> WITHOUT allow-scripts,
//      with a Content-Security-Policy that blocks every network load except
//      images the user chose to show.
//   3. Remote images (tracking pixels) are disabled until the user clicks
//      "Show images"; inline cid: images are embedded as data: URIs.
import sanitizeHtml from 'sanitize-html';

export interface InlinePart {
  cid?: string | undefined;
  contentType: string;
  content: Buffer;
}

const MAX_INLINE_BYTES = 3 * 1024 * 1024;

export function sanitizeEmailHtml(html: string, inline: InlinePart[], showImages: boolean): { html: string; remoteImages: boolean } {
  let remoteImages = false;
  let inlineBudget = MAX_INLINE_BYTES;
  const byCid = new Map(inline.filter((p) => p.cid).map((p) => [p.cid!.replace(/^<|>$/g, '').toLowerCase(), p]));

  const clean = sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'img', 'span', 'font', 'center', 'style', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'col', 'colgroup',
      'caption', 'hr', 'br', 'u', 's', 'strike', 'sub', 'sup', 'small', 'big', 'del', 'ins', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    ],
    // <style> is only safe because the result is rendered in a sandboxed, CSP-locked iframe.
    allowVulnerableTags: true,
    allowedAttributes: {
      '*': ['style', 'class', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'dir', 'title', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'lang'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'style', 'data-vpm-src'],
      font: ['face', 'size', 'color'],
      table: ['width', 'border', 'cellpadding', 'cellspacing', 'bgcolor', 'align', 'style', 'role'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' } }),
      img: (tagName, attribs) => {
        const src = (attribs.src ?? '').trim();
        const out: Record<string, string> = { ...attribs };
        if (/^cid:/i.test(src)) {
          const part = byCid.get(src.slice(4).replace(/^<|>$/g, '').toLowerCase());
          if (part && part.content.length <= inlineBudget && /^image\//i.test(part.contentType)) {
            inlineBudget -= part.content.length;
            out.src = `data:${part.contentType};base64,${part.content.toString('base64')}`;
          } else {
            delete out.src;
          }
        } else if (/^https?:/i.test(src)) {
          remoteImages = true;
          if (!showImages) {
            out['data-vpm-src'] = src;
            delete out.src;
          }
        } else if (!/^data:image\//i.test(src)) {
          delete out.src;
        }
        return { tagName, attribs: out };
      },
    },
  });
  return { html: clean, remoteImages };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Plain-text body as safe HTML, with links made clickable and quoted lines dimmed. */
export function textToHtml(text: string): string {
  const lines = escapeHtml(text)
    .replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer nofollow">$1</a>')
    .split(/\r?\n/)
    .map((l) => (l.startsWith('&gt;') ? `<span style="color:#64748b">${l}</span>` : l));
  return `<div style="white-space:pre-wrap;font-family:inherit">${lines.join('\n')}</div>`;
}
