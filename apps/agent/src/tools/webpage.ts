// Plain-text read of a public web page — the second half of fact checking. A
// search snippet only proves someone said a thing; the page it came from is
// where the number actually lives, so an agent that can search but not read
// can confirm that a claim exists and never that it is true.
//
// Deliberately small: no headless browser, no JavaScript, no cookies. Markup
// is stripped and the text is capped, because this lands in a model prompt and
// an uncapped page would eat the context window the evidence needs.
const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 12_000;

export interface PageRead {
  url: string;
  title: string;
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Decode the entities a text extract actually meets. Named ones are the short
 * list above; numeric ones are decoded generally, because product pages are
 * full of them — &#8212; in a title, &#8203; inside a price — and leaving them
 * raw hands the model a spec sheet peppered with punctuation codes.
 */
function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, token: string) => {
    if (token[0] === '#') {
      const code = Number(
        token[1] === 'x' || token[1] === 'X' ? `0x${token.slice(2)}` : token.slice(1),
      );
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[token.toLowerCase()] ?? match;
  });
}

/**
 * HTML → readable text. Exported for the tests: this is the part with rules in
 * it, and it must never need the network to be checked.
 */
export function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const stripped = html
    // Whole elements whose contents are never prose.
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Block boundaries become line breaks so headings don't fuse into the body.
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    // Collapse the whitespace the tag strip leaves behind, keeping paragraphs.
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '');
  // Decode last: a page that displays escaped markup (&lt;p&gt;) must end up
  // with that text, not with a tag this function has already stopped stripping.
  return { title: decodeTitle(title), text: decodeEntities(stripped).trim() };
}

function decodeTitle(raw: string): string {
  return decodeEntities(raw).replace(/\s+/g, ' ').trim();
}

/**
 * Fetch one public page and return its text, truncated. Throws with a message
 * the model can act on — a tool that fails silently teaches an agent that the
 * claim checked out.
 */
export async function fetchPageText(url: string): Promise<PageRead> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`only http(s) URLs can be read, got ${parsed.protocol}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SleekDropsBot/1.0; +https://sleekdrops.com)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${parsed.hostname}`);

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (contentType && !/^text\/|\+xml$|^application\/(xhtml|xml|json)$/.test(contentType)) {
      throw new Error(`${parsed.hostname} served ${contentType}, which has no text to read`);
    }

    const body = await res.arrayBuffer();
    const html = Buffer.from(body.byteLength > MAX_HTML_BYTES ? body.slice(0, MAX_HTML_BYTES) : body)
      .toString('utf8');
    const { title, text } = htmlToText(html);
    return {
      url: res.url || parsed.toString(),
      title,
      text:
        text.length > MAX_TEXT_CHARS
          ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[truncated at ${MAX_TEXT_CHARS} characters]`
          : text,
    };
  } finally {
    clearTimeout(timer);
  }
}
