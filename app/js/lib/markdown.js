// A reply as Markdown (GitHub's flavour, line breaks kept), with marked (MIT, small). Replies come
// from endpoints, so nothing in them runs or loads: raw HTML is shown as text, links go only to
// http(s), mailto and in-page addresses (and open in a new window), and images are links to them
// (nothing is fetched).

import { Marked } from "marked";

const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const SAFE = /^(https?:|mailto:|#)/i;

const md = new Marked({ gfm: true, breaks: true, async: false });
md.use({
  renderer: {
    html({ text }) {
      return escape(text);
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (!SAFE.test(String(href ?? "").trim())) return inner;
      return `<a href="${escape(href)}"${title ? ` title="${escape(title)}"` : ""} target="_blank" rel="noreferrer noopener">${inner}</a>`;
    },
    image({ href, title, text }) {
      const label = escape(text || title || href);
      if (!SAFE.test(String(href ?? "").trim())) return label;
      return `<a href="${escape(href)}" target="_blank" rel="noreferrer noopener">${label}</a>`;
    },
  },
});

export const renderMarkdown = (text) => md.parse(String(text ?? ""));
