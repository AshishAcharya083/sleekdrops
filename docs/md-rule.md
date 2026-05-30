# Markdown Authoring Rules (SleekDrops Blog)

This is the single source of truth for how a blog post `.md` file must be written. Every post is validated at build time against `src/content/config.ts` — any deviation from the rules below will fail the build.

If you are an automated agent generating a post, follow this document literally. If you are a human editor, the same rules apply.

---

## 1. File location & naming

- Path: `src/content/blog/<slug>.md`
- Slug rules: kebab-case, lowercase, ASCII only, no spaces, no trailing date.
- The filename (minus `.md`) becomes the URL: `sonos-era-300-vs-100.md` → `https://sleekdrops.com/blog/sonos-era-300-vs-100`
- One post per file. Do not concatenate multiple posts.

---

## 2. Frontmatter (YAML between `---` fences)

Frontmatter sits at the very top of the file, opened and closed by `---` on its own line. Schema is enforced by Zod in `src/content/config.ts`.

### Required fields

| Field      | Type             | Allowed values / rules                                                            |
|------------|------------------|-----------------------------------------------------------------------------------|
| `title`    | string           | The headline. Wrap in double quotes if it contains `:` or `'`.                    |
| `dek`      | string           | One-sentence subhead / excerpt. Shown under the headline and in meta description. |
| `category` | enum             | One of: `Tech`, `Home`, `Fashion`, `Health`, `Finance`, `Travel`.                 |
| `author`   | string           | Must match an `id` in `src/data/authors.ts` (`mira`, `theo`, `aiko`, `lina`, `sam`, `beatriz`). |
| `pubDate`  | ISO date         | Format `YYYY-MM-DD`. Posts with future `pubDate` are hidden in production.        |
| `readTime` | positive integer | Minutes. Round to nearest whole number.                                           |
| `cover`    | enum             | One of: `fill-1`, `fill-2`, `fill-3`, `fill-4`, `fill-5`, `fill-6`, `fill-7`, `fill-8`. Used as the gradient placeholder when no `heroImage` is set. |

### Optional fields

| Field         | Type     | Default     | Notes                                                                                     |
|---------------|----------|-------------|-------------------------------------------------------------------------------------------|
| `postType`    | enum     | `article`   | One of `article`, `review`, `guide`, `roundup`. Drives JSON-LD schema.                    |
| `kind`        | string   | —           | Human-facing badge label, e.g. `Comparison`, `Buying guide`, `Review`.                    |
| `tags`        | string[] | `[]`        | Lowercase, hyphenated. Powers `/tag/<tag>` index pages.                                   |
| `updatedDate` | ISO date | —           | Overrides `pubDate` for the `dateModified` SEO field.                                     |
| `heroImage`   | URL      | —           | Must be a full `https://` URL (typically Cloudflare R2). Renders instead of `cover`.      |
| `heroAlt`     | string   | `title`     | Alt text for `heroImage`. Required for accessibility when `heroImage` is set.             |
| `product`     | string   | —           | Product id from `src/data/products.ts`. **Required when `postType: review`.**             |
| `featured`    | boolean  | `false`     | If `true`, this post takes the hero slot on the homepage. Only one post should be `true`. |
| `draft`       | boolean  | `false`     | If `true`, post is excluded from all listings and sitemap (still served if URL is known). |

### Frontmatter template (copy and fill)

```yaml
---
title: "Your headline here — keep under ~70 chars for SERPs"
dek: "One sentence. Hook + promise. ~140-160 chars for meta description reuse."
category: "Tech"
postType: "article"
kind: "Comparison"
author: "theo"
tags: ["tag-one", "tag-two"]
pubDate: "2026-05-31"
readTime: 8
cover: "fill-3"
heroImage: "https://pub-fcb1f09112ed40ba9542a135e3f6618d.r2.dev/posts/2026/05/slug/hero.jpg"
heroAlt: "Descriptive alt text for the hero image"
featured: false
draft: false
---
```

---

## 3. Body content — supported markdown

The body starts immediately after the closing `---`. We use **CommonMark + GFM** (GitHub-Flavored Markdown), wired in via `remark-gfm` in `astro.config.mjs`. Below is every syntax element that renders correctly today. If it is not on this list, do not use it.

### 3.1 Headings

```markdown
## Section heading (renders as <h2>, appears in TOC)
### Sub-section (renders as <h3>, does not appear in TOC)
```

- Do **not** use `#` — the page `<h1>` is generated from the `title` frontmatter.
- Use `##` for major sections only. Every `##` becomes a Table of Contents entry.
- Use `###` sparingly for sub-points within a section.
- Skip `####` and deeper; they are not styled.

### 3.2 Paragraphs & line breaks

Separate paragraphs with a blank line. A single newline inside a paragraph is collapsed to a space.

```markdown
This is paragraph one.

This is paragraph two. Notice the blank line between them.
```

### 3.3 Inline formatting

| Syntax              | Renders as              |
|---------------------|-------------------------|
| `**bold**`          | **bold**                |
| `*italic*`          | *italic* (display font) |
| `~~strikethrough~~` | ~~strikethrough~~       |
| `` `inline code` `` | `inline code`           |

### 3.4 Links

```markdown
[link text](/relative/path)
[external link](https://example.com)
[affiliate link](/go/product-slug)
```

- Internal links use root-relative paths (`/blog/foo`, not `../foo`).
- Affiliate links **always** use the `/go/<slug>` redirect pattern. The slug must exist in `src/data/affiliate-links.json`.
- Autolinks: bare URLs like `https://example.com` become clickable automatically (GFM).

### 3.5 Lists

Unordered:

```markdown
- First item
- Second item
  - Nested item (indent with 2 spaces)
- Third item
```

Ordered:

```markdown
1. First step
2. Second step
3. Third step
```

Task lists (GFM):

```markdown
- [ ] Unchecked task
- [x] Completed task
```

### 3.6 Tables (GFM)

```markdown
| Spec        | Era 100      | Era 300       |
|-------------|--------------|---------------|
| Price (USD) | $249         | $449          |
| Drivers     | 2            | 6             |
| Spatial     | No           | Yes (Atmos)   |
| Weight      | 4.4 lb       | 9.85 lb       |
```

Rules:
- The `|---|` separator row is mandatory.
- Use `:---` for left-align, `:---:` for center, `---:` for right (per column).
- Keep tables under ~6 columns; wider tables scroll horizontally on mobile.
- Tables render inside a `.table-wrap` scroller — keep cell content concise.

### 3.7 Images

```markdown
![Descriptive alt text](https://pub-fcb1f09112ed40ba9542a135e3f6618d.r2.dev/posts/2026/05/slug/diagram.jpg)
```

- Always provide alt text. Empty alt is only allowed for purely decorative images.
- Use absolute URLs (R2 bucket). Do not commit binaries to the repo.
- Images render full-width with a 16px radius and 1.5em vertical margin.
- Recommended aspect ratio: 16:9 or 4:3. Avoid portraits inline.

### 3.8 Blockquotes / pull-quotes

```markdown
> This renders as an oversized italic pull-quote — use sparingly,
> once or twice per article maximum.
```

Pull-quotes use the display serif and are visually loud. One per post is plenty.

### 3.9 Code blocks

````markdown
```js
const greeting = 'hello world';
console.log(greeting);
```
````

- Language tag is required for syntax highlighting (Shiki, `github-light` theme).
- Supported tags: `js`, `ts`, `jsx`, `tsx`, `html`, `css`, `bash`, `json`, `yaml`, `md`, `python`, plus most languages on the Shiki list.
- Triple-backtick fences only. Do not use indented (4-space) code blocks.

### 3.10 Horizontal rule

```markdown
---
```

Renders as a thin hairline. Use to separate major thematic sections within a long post.

### 3.11 Footnotes (GFM)

```markdown
Here is a claim that needs a source.[^1]

[^1]: Source: example.com, retrieved 2026-05-30.
```

Footnotes render at the bottom of the article with back-links.

---

## 4. What does NOT work (do not use)

- Raw HTML tags (`<div>`, `<table>`, `<span class="...">`) — stripped or escaped.
- Component imports (`<DealCard />`, `import X from ...`) — only works in `.mdx`, and we do not use MDX yet. If you need a comparison table, callout, or pros/cons block, ask the page template author to add it around `<Content />` in `src/pages/blog/[slug].astro`, or use the components driven by the `product` frontmatter field.
- Mermaid diagrams, KaTeX math, custom containers, definition lists, emoji shortcodes — no plugins enabled for these.
- Front-matter fields not in the schema — build fails with a Zod validation error.

---

## 5. Editorial conventions

These are not enforced by the schema, but every post should follow them for consistency with the existing two posts (`sonos-era-300-vs-100.md`, `harman-kardon-luna-2.md`):

- Open with a `## The short answer` section. Give the reader the verdict in two sentences. Drop-cap is applied to the first paragraph automatically.
- Use sentence-case headings, not Title Case. Example: `## How it sounds`, not `## How It Sounds`.
- Affiliate product mentions always link via `[Product Name](/go/product-slug)` on first reference in each section. Don't link every occurrence.
- Close with a `## Should you buy it?` or `## Verdict` section that names a clear winner and the buyer profile it suits.
- End with a one-line italic disclaimer about price verification when prices are quoted, e.g. `*Prices verified against [retailer] on [date]; check live listings before buying.*`
- Keep paragraphs 2–4 sentences. Wall-of-text paragraphs break the drop-cap and look heavy.
- No emoji in body copy.
- Numbers: spell out one through nine, digits for 10+. Always use digits in tables, prices, and specs.

---

## 6. Pre-commit checklist

Before saving the file, confirm:

1. Frontmatter has all required fields and uses allowed enum values.
2. `author` matches an existing id in `src/data/authors.ts`.
3. If `postType: review`, `product` is set and exists in `src/data/products.ts`.
4. Every affiliate `/go/<slug>` link has a matching entry in `src/data/affiliate-links.json`.
5. `heroImage` (if set) returns 200 and is a full `https://` URL.
6. No raw HTML, no component tags, no unsupported syntax.
7. Run `npm run build` locally — if it passes, the post is valid.

---

## 7. Where each rule comes from

- Frontmatter schema: `src/content/config.ts`
- Markdown processor + plugins: `astro.config.mjs`
- Body styling (what renders how): `src/components/article/ArticleBody.astro`
- Page template (what wraps `<Content />`): `src/pages/blog/[slug].astro`
- Author registry: `src/data/authors.ts`
- Product registry: `src/data/products.ts`
- Affiliate redirect map: `src/data/affiliate-links.json`

When in doubt, read those files. They are the law; this document is the summary.
