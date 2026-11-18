// The site's one markdown renderer: Astro's own processor, so a post body
// renders the way Astro renders markdown anywhere else, GitHub-flavoured
// tables included.
import { createMarkdownProcessor } from '@astrojs/markdown-remark';

const processor = createMarkdownProcessor({ gfm: true, syntaxHighlight: false });

/** Markdown to HTML at build time, with GFM tables. */
export async function renderMarkdown(markdown: string): Promise<string> {
  const { code } = await (await processor).render(markdown);
  return code;
}
