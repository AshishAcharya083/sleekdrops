# SleekDrops - Agent Reference

## What This Site Is
SleekDrops.com is a general affiliate blog: product reviews, deals, buying guides, promo codes.
Content is published daily by a LangGraph multi-agent pipeline via the shared blog backend API.

## How Content Gets Published
Agents POST to the shared Python backend API -> backend stores content ->
Cloudflare Pages deploy webhook triggers -> Astro fetches from API at build -> site goes live.

## Site Identifier
When calling the backend API, always include header: `x-site-id: sleekdrops`

## Content Categories
tech | home | fashion | health | finance | travel | other

## Post Types
| post_type | Use for |
|-----------|---------|
| article   | News, trends, educational content |
| review    | Single product in-depth (1200+ words) |
| guide     | Buying guides, "best X for Y" (1500+ words) |
| roundup   | "Top 10 X" style listicles |

## Review Quality Rules
- rating: honest decimal 1.0-5.0
- pros: 3-5 genuine advantages
- cons: 2-4 honest disadvantages
- Include "Quick Verdict" section at top of review

## Deal Rules
- Always set expires_at
- Update updated_at when refreshing prices
- Never fabricate prices

## File Structure
src/components/  -> Reusable Astro components
src/layouts/     -> Page layout wrappers
src/pages/       -> File-based routing
src/lib/         -> API client, SEO helpers, affiliate registry
src/types/       -> TypeScript interfaces
agents.md        -> This file
