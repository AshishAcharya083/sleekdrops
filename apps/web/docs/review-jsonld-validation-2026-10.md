# Review JSON-LD validation, October 2026

Recorded 2026-10-02 for SLE-150 (correct review structured data).
This is a record of one validation run against the review graph `buildReviewSchema` in [`src/lib/seo.ts`](../src/lib/seo.ts) emits.
It is not a build gate.

## What changed in the review graph

- The reviewed Product carries no `aggregateRating`, and nothing in the graph claims one.
  One editorial review is not "the average rating based on multiple ratings or reviews", so the graph ships a single `Review` instead.
- The `Review` names its author from the authors registry (`author` = the byline `@id` plus its `name`).
- The `Review` carries `datePublished` and `dateModified`, the same values the `WebPage` and `Article` nodes declare (`dateModified` is `updatedDate ?? pubDate`, unchanged).
- When the review recorded `product.methodVersion`, the `Review` is `isBasedOn` a `CreativeWork` for that method version (`Method v1.0`, `version: "1.0"`, `/how-we-rate#method-v1-0`).
  A legacy review with no recorded version gets no `isBasedOn`, rather than being stamped with the current version.
- `itemReviewed` names the product as well as referencing its `@id`, so the `Review` stands on its own for a consumer that does not resolve references across the graph.
- The Product and Offer nodes are otherwise unchanged.

## How it was validated

- **Validator:** [`@adobe/structured-data-validator`](https://www.npmjs.com/package/@adobe/structured-data-validator) 1.7.0, which checks every property against the schema.org vocabulary and applies Google's rich-result requirements for `Product`, `Offer`, `Review` and `Rating`.
- **Extractor:** [`@marbec/web-auto-extractor`](https://www.npmjs.com/package/@marbec/web-auto-extractor) 2.2.1, the extractor the validator is built to read.
- **Vocabulary:** schema.org release 29.3 (`schemaorg-all-https.jsonld` from the schemaorg/schemaorg GitHub release).
- **Fixtures:** the `buildPostSchema` output for a review post (Harman Kardon Luna 2, rating 4.4, price A$229, author `desk`), serialised with `jsonLdScript` into a `<script type="application/ld+json">` in an otherwise empty HTML page, in two forms:
  1. **Versioned and revised:** `methodVersion: '1.0'`, published 2026-05-30, updated 2026-09-12.
  2. **Legacy:** no `methodVersion`, no `updatedDate`.
- The vocabulary check was confirmed live by renaming `isBasedOn` and `version` to non-schema names in a copy of fixture 1: the validator reported both as "not supported by the schema.org specification".

The run was repeated on 2026-10-02 after the branch was rebuilt on SLE-146's merged trust model (`methodLabel` and `MethodVersion` from `src/lib/trust.ts`), with the same result below.

The hosted validators (validator.schema.org and Google's Rich Results Test) could not be reached from the build sandbox, so this run used the offline validator above.

## Result

Both fixtures: **1 error, 14 warnings, and none of them on the `Review` or its `Rating`**, and no unsupported schema.org properties anywhere in the graph, including the `isBasedOn` `CreativeWork`.

The one error in both fixtures predates this change and is on the Product node, which this change leaves as it was:

| Severity | Node | Message |
|---|---|---|
| ERROR | `Product` | Required attribute `image` is missing |
| WARNING | `Product` | Missing one of `gtin`, `gtin8`, `gtin12`, `gtin13`, `gtin14`, `isbn` |
| WARNING | `Product` / `Offer` | Missing `priceValidUntil` (optional) |
| WARNING | `Product` | Missing `aggregateRating` (optional), expected and intended |

The remaining warnings are optional Product attributes (`sku`, `mpn`, `color`, `material` and similar) that a researched review has no source for.

The same fixture built from the code before this change gave 2 errors and 15 warnings.
The extra error was `Review`: `itemReviewed.name` missing, because the validator does not follow the `@id` reference; the Review now names the product inline.
The extra warning was the `Review`'s missing `datePublished`, which it now carries.

## Follow-ups (optional, not blocking)

- **Product `image`.** Google lists `image` as required for merchant-listing results.
  The review page's hero image is not guaranteed to show the product, so it was not copied onto the Product here.
  A product image field in the review frontmatter would close this.
- **Hosted re-check.** Anyone with a browser can paste a deployed review page into the [Rich Results Test](https://search.google.com/test/rich-results) and [validator.schema.org](https://validator.schema.org/) to confirm the same result.
