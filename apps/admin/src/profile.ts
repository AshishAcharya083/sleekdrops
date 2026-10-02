/**
 * The platform profile editor's rules: what the operator may edit about a
 * platform's prompts, how the form maps onto the API's EditableProfile, and
 * how one saved version differs from the one before it.
 *
 * Categories, post types, article layouts, monetisation, blocked domains and
 * topics, the publish target and each edition's zone, locale and currency are
 * set in code and are deliberately not part of this shape.
 *
 * Pure and dependency-free on purpose: it is unit-tested in isolation (see
 * profile.test.ts).
 */

/** Agents that may carry a goal: the scout plus every stage before publish. */
export const AGENT_GOALS = [
  { id: 'scout', label: 'Topic scout' },
  { id: 'research', label: 'Researcher' },
  { id: 'keyword', label: 'Keyword strategist' },
  { id: 'angle', label: 'Angle editor' },
  { id: 'outline', label: 'Outliner' },
  { id: 'write', label: 'Writer' },
  { id: 'seo_review', label: 'SEO reviewer' },
  { id: 'edit', label: 'Editor' },
  { id: 'assemble', label: 'Assembler' },
  { id: 'image', label: 'Image agent' },
] as const;

export type AgentId = (typeof AGENT_GOALS)[number]['id'];

export interface EditableEdition {
  id: string;
  scout_queries: string[];
  compliance_footer: string;
}

export interface EditableProfile {
  brand_text: string;
  audience: string;
  editorial_rules: string;
  agent_goals: Partial<Record<AgentId, string>>;
  scout_queries: string[];
  editions: EditableEdition[];
}

/** GET (and PUT) /api/platform/profile */
export interface PlatformProfile {
  platform_id: string;
  version: number;
  author: string;
  created_at: string;
  profile: EditableProfile;
}

export interface ProfileVersion {
  version: number;
  author: string;
  created_at: string;
  profile: EditableProfile;
}

/** GET /api/platform/profile/versions, newest first. */
export interface ProfileVersionList {
  versions: ProfileVersion[];
}

/** The body PUT /api/platform/profile takes. */
export interface ProfileSave {
  base_version: number;
  author: string;
  profile: EditableProfile;
}

/** Remembers who is editing, the same way the token and API base are kept. */
export const PROFILE_AUTHOR_KEY = 'sleekdrops_profile_author';

export const MAX_AUTHOR_LENGTH = 100;

/** The profile as the form edits it: query lists are one per line. */
export interface ProfileForm {
  brand_text: string;
  audience: string;
  editorial_rules: string;
  agent_goals: Record<AgentId, string>;
  scout_queries: string;
  editions: Array<{ id: string; scout_queries: string; compliance_footer: string }>;
}

const toLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

export function profileToForm(profile: EditableProfile): ProfileForm {
  const goals = Object.fromEntries(
    AGENT_GOALS.map(({ id }) => [id, profile.agent_goals?.[id] ?? '']),
  ) as Record<AgentId, string>;
  return {
    brand_text: profile.brand_text,
    audience: profile.audience,
    editorial_rules: profile.editorial_rules,
    agent_goals: goals,
    scout_queries: profile.scout_queries.join('\n'),
    editions: profile.editions.map((e) => ({
      id: e.id,
      scout_queries: e.scout_queries.join('\n'),
      compliance_footer: e.compliance_footer,
    })),
  };
}

/**
 * The form as the API takes it. Prose is sent exactly as typed - a trimmed
 * brand paragraph would change a prompt the operator did not touch - while
 * query lists drop blank lines and a goal left blank is no goal at all.
 */
export function formToProfile(form: ProfileForm): EditableProfile {
  const agentGoals: Partial<Record<AgentId, string>> = {};
  for (const { id } of AGENT_GOALS) {
    const goal = form.agent_goals[id];
    if (goal.trim() !== '') agentGoals[id] = goal;
  }
  return {
    brand_text: form.brand_text,
    audience: form.audience,
    editorial_rules: form.editorial_rules,
    agent_goals: agentGoals,
    scout_queries: toLines(form.scout_queries),
    editions: form.editions.map((e) => ({
      id: e.id,
      scout_queries: toLines(e.scout_queries),
      compliance_footer: e.compliance_footer,
    })),
  };
}

/** Whether saving the form would change anything about `saved`. */
export function isProfileDirty(form: ProfileForm, saved: EditableProfile): boolean {
  return JSON.stringify(formToProfile(form)) !== JSON.stringify(formToProfile(profileToForm(saved)));
}

/** Why `author` cannot sign a version, or null when it can. */
export function authorProblem(author: string): string | null {
  const name = author.trim();
  if (name === '') return 'Add your name - every version records who saved it.';
  if (name.length > MAX_AUTHOR_LENGTH) return `Keep the name to ${MAX_AUTHOR_LENGTH} characters.`;
  return null;
}

export function profileSaveBody(baseVersion: number, author: string, form: ProfileForm): ProfileSave {
  return { base_version: baseVersion, author: author.trim(), profile: formToProfile(form) };
}

/** What the operator is told when someone else saved first (the API's 409). */
export function conflictMessage(currentVersion: number | null): string {
  const now = currentVersion === null ? 'a newer version' : `version ${currentVersion}`;
  return `This profile changed since you loaded it - ${now} is now current. Nothing was saved. Load the latest version, then make your edits again.`;
}

/**
 * The fields that differ between two versions, in form order. `before` is null
 * for the first version, which created every field.
 */
export function profileChanges(
  before: EditableProfile | null,
  after: EditableProfile,
  editionName: (id: string) => string = (id) => id,
): string[] {
  if (!before) return ['Initial version'];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const changes: string[] = [];
  if (!same(before.brand_text, after.brand_text)) changes.push('Brand text');
  if (!same(before.audience, after.audience)) changes.push('Audience');
  if (!same(before.editorial_rules, after.editorial_rules)) changes.push('Editorial rules');
  if (!same(before.scout_queries, after.scout_queries)) changes.push('Scout queries');
  for (const { id, label } of AGENT_GOALS) {
    if (!same(before.agent_goals?.[id], after.agent_goals?.[id])) changes.push(`${label} goal`);
  }
  for (const edition of after.editions) {
    const prior = before.editions.find((e) => e.id === edition.id);
    const name = editionName(edition.id);
    if (!same(prior?.scout_queries, edition.scout_queries)) changes.push(`${name} scout queries`);
    if (!same(prior?.compliance_footer, edition.compliance_footer)) changes.push(`${name} compliance footer`);
  }
  return changes;
}
