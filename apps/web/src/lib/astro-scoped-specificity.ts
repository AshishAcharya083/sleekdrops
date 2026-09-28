/**
 * Modifier rules a scoped `<style>` block has quietly disabled.
 *
 * Astro scopes a component's CSS by appending its `[data-astro-cid-…]`
 * attribute to every compound selector in a rule, and an attribute weighs the
 * same as a class. So a base rule written with a descendant combinator picks up
 * two of them where a single-element modifier picks up one, and the base wins a
 * specificity contest it visibly loses in the source:
 *
 *     .tier-legend-row .legend-rule { border-top: 3px solid var(--hairline-strong) }
 *     .legend-rule.legend-rule--expert { border-top: 3px solid var(--ink) }
 *
 * reads as "the modifier is more specific, it wins", compiles to
 * `.tier-legend-row[cid] .legend-rule[cid]` (four units) against
 * `.legend-rule[cid].legend-rule--expert` (three), and drew every tier swatch
 * in the same grey. Nothing catches it: the CSS is valid, `astro check` and
 * `astro build` stay green, and only the rendered page shows it.
 *
 * The rule here is narrow on purpose. It reports a BEM modifier - `.block--x`,
 * on its own or compounded as `.block.block--x` - that sets a property a base
 * rule for `.block` also sets to a *different* value, where the base is
 * strictly more specific once scoped. Equal specificity is fine and common:
 * source order decides it, and the modifiers are written after their base. So
 * is a base that wins with the value the modifier wanted anyway - nothing on
 * screen differs. The fix is always the same one - drop the combinator from the
 * base rule, or add the block's own class to the modifier - and never "write it
 * as `!important`".
 *
 * `astro-scoped-specificity.test.ts` runs this over every `.astro` file in the
 * tree, the same way the frontmatter-script guard beside it does.
 */

/** A modifier that cannot win against its own base rule. */
export interface DeadModifier {
  /** The modifier selector, as written. */
  readonly modifier: string;
  /** The base selector that out-specifies it. */
  readonly base: string;
  /** The properties the base sets that the modifier is trying to change. */
  readonly properties: string[];
}

interface Rule {
  readonly selectors: string[];
  readonly declarations: string;
}

/** `.block--modifier` or `.block.block--modifier`, and nothing else. */
const MODIFIER = /^\.([a-zA-Z][\w-]*?)--[\w-]+$/;
const COMPOUND_MODIFIER = /^\.([a-zA-Z][\w-]*)\.\1--[\w-]+$/;

/** A selector's parts, split on descendant, child and sibling combinators. */
const compoundsOf = (selector: string): string[] =>
  selector.split(/\s*[>+~]\s*|\s+/).filter((part) => part.length > 0);

/**
 * How heavy a selector is once Astro has scoped it: its own class-level units
 * plus one scope attribute per compound. Ids and elements are not counted -
 * neither appears in the pattern this guard is about, and an id in a scoped
 * component style would out-specify everything either way.
 */
function scopedWeight(selector: string): number {
  const units = selector.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+(?:\([^)]*\))?/g) ?? [];
  return units.length + compoundsOf(selector).length;
}

/** What a declaration block sets, property to value, in source order. */
function declarationsOf(declarations: string): Map<string, string> {
  const set = new Map<string, string>();
  for (const declaration of declarations.split(';')) {
    const split = declaration.indexOf(':');
    if (split === -1) continue;
    const property = declaration.slice(0, split).trim().toLowerCase();
    if (!/^-{0,2}[a-zA-Z][\w-]*$/.test(property)) continue;
    set.set(property, declaration.slice(split + 1).trim().replace(/\s+/g, ' ').toLowerCase());
  }
  return set;
}

/**
 * Whether a base rule's property can override a modifier's.
 *
 * `border` covers `border-top`, and `margin` covers `margin-top`, so a
 * shorthand on either side counts as the same property - that is exactly how
 * the base rule wins in practice.
 */
const overlaps = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);

/** Every `<style>` block's CSS, comments stripped, at-rule wrappers removed. */
function styleRules(source: string): Rule[] {
  const rules: Rule[] = [];
  for (const block of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    const css = block[1].replace(/\/\*[\s\S]*?\*\//g, '');
    // Nested at-rules (`@media`, `@supports`) leave their own `{` behind; the
    // pattern only matches innermost blocks, which is where declarations live.
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const prelude = rule[1].trim().replace(/\s+/g, ' ');
      if (prelude.startsWith('@') || prelude === '') continue;
      rules.push({
        selectors: prelude.split(',').map((selector) => selector.trim()).filter(Boolean),
        declarations: rule[2],
      });
    }
  }
  return rules;
}

/** Whether a selector's own element is the block - `.card` and not `.card--x`. */
function targetsBlock(selector: string, block: string): boolean {
  const last = compoundsOf(selector).at(-1) ?? '';
  const classes: string[] = last.match(/\.[\w-]+/g) ?? [];
  return classes.includes(`.${block}`) && !classes.some((name) => name.includes('--'));
}

/** Modifier rules a base rule in the same file has already won against. */
export function findDeadModifiers(source: string): DeadModifier[] {
  const rules = styleRules(source);
  const dead: DeadModifier[] = [];

  rules.forEach((rule, index) => {
    const wanted = declarationsOf(rule.declarations);
    if (wanted.size === 0) return;
    for (const selector of rule.selectors) {
      const block = (MODIFIER.exec(selector) ?? COMPOUND_MODIFIER.exec(selector))?.[1];
      if (block === undefined) continue;
      for (const base of rules.slice(0, index)) {
        for (const baseSelector of base.selectors) {
          if (!targetsBlock(baseSelector, block)) continue;
          if (scopedWeight(baseSelector) <= scopedWeight(selector)) continue;
          // A base that wins with the value the modifier was going to set
          // changes nothing on screen, which is what this guard is about.
          const properties = [...declarationsOf(base.declarations)]
            .filter(([property, value]) =>
              [...wanted].some(([one, set]) => overlaps(property, one) && set !== value),
            )
            .map(([property]) => property);
          if (properties.length === 0) continue;
          dead.push({ modifier: selector, base: baseSelector, properties: [...new Set(properties)] });
        }
      }
    }
  });

  return dead;
}
