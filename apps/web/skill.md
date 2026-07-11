# SleekDrops Agent Skills

This file tells any agent (or human) what to read **before** generating, editing, or publishing content in this repo.

## Writing a blog post

**Canonical format guide:** [`docs/md-rule.md`](docs/md-rule.md)

Read it in full before producing any `.md` file under `src/content/blog/`. It covers:

- File path and slug rules
- Required and optional frontmatter (with allowed enum values)
- Every supported markdown element — headings, paragraphs, inline formatting, links, lists (ordered, unordered, task), tables (GFM pipe syntax), images, blockquotes, code blocks, horizontal rules, footnotes
- What is **not** supported (raw HTML, MDX components, Mermaid, math, etc.)
- Editorial conventions (opening sections, link patterns, closing verdict, disclaimers)
- A pre-commit checklist

The frontmatter schema is enforced at build time by `src/content/config.ts` — invalid posts fail the build, they do not silently ship.

## Other repo conventions

- Architecture and contribution rules: [`AGENTS.md`](AGENTS.md)
- Deployment pipeline: [`docs/deployment.md`](docs/deployment.md)
- Automation / scheduling: [`docs/automation.md`](docs/automation.md)
- Affiliate network setup: [`docs/associate_networks.md`](docs/associate_networks.md)
- Roadmap: [`docs/future_planning.md`](docs/future_planning.md)

## Rule of thumb for agents

If you are about to write into `src/content/blog/`, open `docs/md-rule.md` first. If you are about to change `astro.config.mjs`, `src/content/config.ts`, or `src/components/article/ArticleBody.astro`, update `docs/md-rule.md` in the same change — that file is the contract.
