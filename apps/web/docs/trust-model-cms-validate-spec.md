# Trust model: the schema change for `sleekdrops-cms/scripts/validate.ts`

**Status, 2026-10-02.** Optional follow-up, not a gate.
Nothing in this repository's build, tests or CI depends on it.

## Why this document exists

The review frontmatter now carries a shared trust vocabulary, defined once in
[`src/lib/trust.ts`](../src/lib/trust.ts) and applied to `productSchema` in
[`src/content/frontmatter.ts`](../src/content/frontmatter.ts).
`sleekdrops-cms/scripts/validate.ts` historically mirrored that schema so a post failed in the content repo's CI rather than in this site's build.
That repository is not visible from here, so the change it needs is written out below instead of committed.

Two facts to check before applying it:

- `frontmatter.ts` records that the `validate.ts` counterpart was **decommissioned on 2026-06-13**, when content moved to D1.
  If it is no longer run anywhere, there is nothing to do.
- The live mirror is the agent's [`apps/agent/src/content/contract.ts`](../../agent/src/content/contract.ts).
  It has no product schema (the pipeline never writes `postType: review`), and `reviewUnit.acquisition` keeps its three values, so it needs no change.

If `validate.ts` is still run, apply the diff below.
Every new field is optional and the old free-text badge string still validates, so the roughly 320 published reviews pass unchanged.

## What the site now enforces

- `product.methodVersion`: optional, one of the published method versions (today only `"1.0"`).
- `product.provenance`: optional, exactly `"retail"`, `"loan"` or `"none"` - the same values as `reviewUnit.acquisition`, and it must agree with it when both are set.
- `product.subScores`: optional array of at least two `{ label, score, weight }`.
  Weights must sum to 1 (within 0.001) and the weighted sum must sit within **0.05** of `product.rating`.
- `product.badge`: either a legacy string (accepted, never printed) or a registry badge `{ kind, evidence, checkedAt }`.
  `checkedAt` is `YYYY-MM-DD`.
  The price-history kinds `lowest-price` and `below-average` are well-formed but refused while switched off.
  A `review-score` badge must print the review's own `rating`.

## The diff

Written against the `productSchema` block as it was mirrored from this repository before the change, with `z` imported from `zod`.
The CMS cannot import from this repository, so the vocabulary is inlined; keep it in step with `src/lib/trust.ts`.

```diff
 import { z } from 'zod';
 
+// --- Trust vocabulary, mirrored from apps/web/src/lib/trust.ts ---------------
+const METHOD_VERSIONS = ['1.0'] as const;
+const ASSESSMENT_PROVENANCES = ['retail', 'loan', 'none'] as const;
+const SUB_SCORE_TOLERANCE = 0.05;
+// Kinds that are defined but refused until price checks are recorded.
+const DISABLED_BADGE_KINDS = new Set(['lowest-price', 'below-average']);
+
+const isWebUrl = (value: string) => {
+  try {
+    const { protocol } = new URL(value.trim());
+    return protocol === 'https:' || protocol === 'http:';
+  } catch {
+    return false;
+  }
+};
+const webUrl = () => z.string().url().refine(isWebUrl, { message: 'must be an http(s) URL' });
+const checkedAt = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
+const price = z.string().min(1);
+
+const badgeClaimSchema = z.discriminatedUnion('kind', [
+  z.object({
+    kind: z.literal('review-score'),
+    evidence: z
+      .object({ score: z.number().min(1).max(5), reviewSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) })
+      .strict(),
+    checkedAt,
+  }).strict(),
+  z.object({
+    kind: z.literal('lowest-price'),
+    evidence: z
+      .object({ price, previousLowest: price, observations: z.number().int().min(2), sourceUrl: webUrl() })
+      .strict(),
+    checkedAt,
+  }).strict(),
+  z.object({
+    kind: z.literal('below-average'),
+    evidence: z
+      .object({ price, average: price, below: price, observations: z.number().int().min(2), sourceUrl: webUrl() })
+      .strict(),
+    checkedAt,
+  }).strict(),
+  z.object({
+    kind: z.literal('skip-for-now'),
+    evidence: z.object({ reason: z.string().min(1), sourceUrl: webUrl() }).strict(),
+    checkedAt,
+  }).strict(),
+]);
+
-const productSchema = z.object({
-  name: z.string().min(1),
-  brand: z.string().min(1),
-  brandMark: z.string().length(1),
-  tagline: z.string().min(1),
-  rating: z.number().min(1).max(5),
-  retailer: z.string().min(1),
-  price: z.string().min(1),
-  priceWas: z.string().optional(),
-  badge: z.string().optional(),
-  pros: z.array(z.string().min(1)).min(3).max(5),
-  cons: z.array(z.string().min(1)).min(2).max(4),
-  specs: z.record(z.string()).optional(),
-});
+const productSchema = z
+  .object({
+    name: z.string().min(1),
+    brand: z.string().min(1),
+    brandMark: z.string().length(1),
+    tagline: z.string().min(1),
+    rating: z.number().min(1).max(5),
+    retailer: z.string().min(1),
+    price: z.string().min(1),
+    priceWas: z.string().optional(),
+    // A registry badge; a legacy string still validates and is never printed.
+    badge: z.union([badgeClaimSchema, z.string()]).optional(),
+    pros: z.array(z.string().min(1)).min(3).max(5),
+    cons: z.array(z.string().min(1)).min(2).max(4),
+    specs: z.record(z.string()).optional(),
+    methodVersion: z.enum(METHOD_VERSIONS).optional(),
+    provenance: z.enum(ASSESSMENT_PROVENANCES).optional(),
+    subScores: z
+      .array(z.object({ label: z.string().min(1), score: z.number().min(1).max(5), weight: z.number().positive().max(1) }))
+      .min(2)
+      .optional(),
+  })
+  .superRefine((product, ctx) => {
+    if (product.subScores) {
+      const weights = product.subScores.reduce((sum, s) => sum + s.weight, 0);
+      const recomputed = product.subScores.reduce((sum, s) => sum + s.score * s.weight, 0);
+      if (Math.abs(weights - 1) > 0.001 + 1e-9) {
+        ctx.addIssue({ code: 'custom', path: ['subScores'], message: `sub-score weights sum to ${weights.toFixed(3)}, not 1` });
+      } else if (Math.abs(recomputed - product.rating) > SUB_SCORE_TOLERANCE + 1e-9) {
+        ctx.addIssue({
+          code: 'custom',
+          path: ['subScores'],
+          message: `sub-scores recompute to ${recomputed.toFixed(2)}, more than ${SUB_SCORE_TOLERANCE} from the headline ${product.rating.toFixed(1)}`,
+        });
+      }
+    }
+    if (product.badge === undefined || typeof product.badge === 'string') return;
+    if (DISABLED_BADGE_KINDS.has(product.badge.kind)) {
+      ctx.addIssue({
+        code: 'custom',
+        path: ['badge'],
+        message: `badge kind "${product.badge.kind}" is switched off until the data behind it is collected`,
+      });
+    }
+    if (product.badge.kind === 'review-score' && product.badge.evidence.score !== product.rating) {
+      ctx.addIssue({
+        code: 'custom',
+        path: ['badge', 'evidence', 'score'],
+        message: `a review-score badge must print the review's own rating (${product.rating})`,
+      });
+    }
+  });
 
 const reviewUnitSchema = z.object({
-  acquisition: z.enum(['retail', 'loan', 'none']),
+  acquisition: z.enum(ASSESSMENT_PROVENANCES),
```

And on the frontmatter object, after the existing `postType: 'review'` refinement:

```diff
   .refine(
     (data) => data.postType !== 'review' || data.product !== undefined,
     { message: "postType: 'review' requires a `product` object in frontmatter" },
-  );
+  )
+  .refine(
+    (data) =>
+      data.product?.provenance === undefined ||
+      data.reviewUnit === undefined ||
+      data.product.provenance === data.reviewUnit.acquisition,
+    {
+      message: '`product.provenance` and `reviewUnit.acquisition` describe the same unit and must agree',
+      path: ['product', 'provenance'],
+    },
+  );
```

If the CMS copy predates `reviewUnit`, skip both `reviewUnit` hunks.

## Keeping it in step

When a method version is published, a badge kind is switched on, or a kind is added to the registry in `src/lib/trust.ts`, the matching constant above changes with it.
The site's own build enforces the rules either way, so a CMS copy that falls behind only moves the failure from the content repo's CI to this site's build.
