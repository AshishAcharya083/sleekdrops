import { useCallback, useEffect, useMemo, useState } from 'react';
import { EVENTS, captureError, track } from '../analytics';
import type { PlatformProfile, ProfileForm, ProfileVersion, ProfileVersionList } from '../api';
import {
  AGENT_GOALS,
  api,
  authorProblem,
  conflictMessage,
  findEdition,
  fmtTime,
  getProfileAuthor,
  isProfileDirty,
  MAX_AUTHOR_LENGTH,
  profileChanges,
  profileSaveBody,
  profileToForm,
  setProfileAuthor,
} from '../api';
import { ApiError, describeApiError, toApiError } from '../api-error';
import { ApiErrorBanner } from '../components';
import { usePlatform } from '../hooks';

/**
 * The selected platform's profile: the brand text, rules, goals and scout
 * queries its prompts are built from, plus each edition's queries and
 * compliance footer. Every save is a new version signed by the operator, and a
 * save made against a version someone else has since replaced is refused
 * rather than silently overwriting their edit.
 */
export function PlatformProfileEditor() {
  const platform = usePlatform();
  const [current, setCurrent] = useState<PlatformProfile | null>(null);
  const [versions, setVersions] = useState<ProfileVersion[]>([]);
  const [form, setForm] = useState<ProfileForm | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [author, setAuthor] = useState(getProfileAuthor());
  const [authorTouched, setAuthorTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    Promise.all([
      api<PlatformProfile>('/api/platform/profile'),
      api<ProfileVersionList>('/api/platform/profile/versions'),
    ])
      .then(([profile, history]) => {
        setCurrent(profile);
        setForm(profileToForm(profile.profile));
        setVersions(history.versions);
        setConflict(null);
        setSaveError(null);
      })
      .catch((e: unknown) => {
        captureError(e, { action: 'platform_profile_load', surface: 'settings' });
        setLoadError(toApiError(e));
      });
  }, []);

  useEffect(load, [load]);

  const editionName = useCallback(
    (id: string) => findEdition(platform, id)?.name ?? id,
    [platform],
  );

  // Each version against the one before it, so the history says what moved.
  const history = useMemo(
    () =>
      versions.map((v, i) => ({
        ...v,
        changes: profileChanges(versions[i + 1]?.profile ?? null, v.profile, editionName),
      })),
    [versions, editionName],
  );

  if (!current || !form) {
    return (
      <div className="card profile-card">
        <h2 className="profile-title">Platform profile</h2>
        {loadError ? (
          <ApiErrorBanner error={loadError} onRetry={load} />
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>
    );
  }

  const dirty = isProfileDirty(form, current.profile);
  const authorError = authorProblem(author);
  const canSave = dirty && !saving && authorError === null && conflict === null;

  const update = (patch: Partial<ProfileForm>) => {
    setNotice(null);
    setForm({ ...form, ...patch });
  };
  const updateEdition = (id: string, patch: Partial<ProfileForm['editions'][number]>) =>
    update({ editions: form.editions.map((e) => (e.id === id ? { ...e, ...patch } : e)) });

  const save = async () => {
    setAuthorTouched(true);
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    const body = profileSaveBody(current.version, author, form);
    try {
      const saved = await api<PlatformProfile>('/api/platform/profile', {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      setProfileAuthor(author);
      setCurrent(saved);
      setForm(profileToForm(saved.profile));
      track(EVENTS.platformProfileSaved, {
        platform_id: platform.id,
        version: saved.version,
        count: profileChanges(current.profile, saved.profile).length,
      });
      setNotice(`Saved as version ${saved.version}.`);
      api<ProfileVersionList>('/api/platform/profile/versions')
        .then((h) => setVersions(h.versions))
        .catch((e: unknown) => captureError(e, { action: 'platform_profile_history', surface: 'settings' }));
    } catch (e) {
      captureError(e, { action: 'platform_profile_save', surface: 'settings' });
      const error = toApiError(e);
      if (error.status === 409) {
        const latest = Number(error.body.current_version);
        setConflict(conflictMessage(Number.isFinite(latest) ? latest : null));
      } else {
        setSaveError(describeApiError(error));
      }
    } finally {
      setSaving(false);
    }
  };

  const restore = (v: ProfileVersion) => {
    setForm(profileToForm(v.profile));
    setNotice(
      `Version ${v.version} is in the form. Save to make it current - that adds a new version rather than rewriting history.`,
    );
  };

  return (
    <div className="card profile-card">
      <h2 className="profile-title">Platform profile - {platform.name}</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        What the agents are told about {platform.name}. Version {current.version}, saved by{' '}
        <strong>{current.author}</strong> on {fmtTime(current.created_at)}. Categories, post types,
        article layouts, monetisation, blocked links and topics, and where it publishes are set in
        code and are not edited here.
      </p>

      <div className="section">
        <h2>Brand and audience</h2>
        <div className="field">
          <label htmlFor="pp-brand">Brand text</label>
          <textarea
            id="pp-brand"
            className="textarea"
            value={form.brand_text}
            onChange={(e) => update({ brand_text: e.target.value })}
          />
          <p className="hint">The paragraph every prompt opens with: who {platform.name} is.</p>
        </div>
        <div className="field">
          <label htmlFor="pp-audience">Audience</label>
          <textarea
            id="pp-audience"
            className="textarea compact"
            value={form.audience}
            onChange={(e) => update({ audience: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="pp-rules">Editorial rules</label>
          <textarea
            id="pp-rules"
            className="textarea tall"
            value={form.editorial_rules}
            onChange={(e) => update({ editorial_rules: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="pp-queries">
            Scout queries <span className="opt">ONE PER LINE</span>
          </label>
          <textarea
            id="pp-queries"
            className="textarea mono-input"
            value={form.scout_queries}
            onChange={(e) => update({ scout_queries: e.target.value })}
          />
          <p className="hint">Searched for every edition, before that edition's own queries below.</p>
        </div>
      </div>

      <div className="section">
        <h2>Agent goals</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          One goal per agent, added to that agent's prompt. Leave a goal empty for none.
        </p>
        {AGENT_GOALS.map(({ id, label }) => (
          <div className="field" key={id}>
            <label htmlFor={`pp-goal-${id}`}>{label}</label>
            <textarea
              id={`pp-goal-${id}`}
              className="textarea compact"
              value={form.agent_goals[id]}
              onChange={(e) => update({ agent_goals: { ...form.agent_goals, [id]: e.target.value } })}
            />
          </div>
        ))}
      </div>

      {form.editions.map((edition) => {
        const info = findEdition(platform, edition.id);
        return (
          <div className="section" key={edition.id}>
            <h2>Edition - {info?.name ?? edition.id}</h2>
            {info && (
              <p className="muted" style={{ marginTop: 0 }}>
                {info.time_zone} · {info.locale} · {info.currency ?? 'no currency amounts'}
              </p>
            )}
            <div className="field">
              <label htmlFor={`pp-ed-queries-${edition.id}`}>
                Scout queries <span className="opt">ONE PER LINE</span>
              </label>
              <textarea
                id={`pp-ed-queries-${edition.id}`}
                className="textarea compact mono-input"
                value={edition.scout_queries}
                onChange={(e) => updateEdition(edition.id, { scout_queries: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={`pp-ed-footer-${edition.id}`}>Compliance footer</label>
              <textarea
                id={`pp-ed-footer-${edition.id}`}
                className="textarea compact"
                value={edition.compliance_footer}
                onChange={(e) => updateEdition(edition.id, { compliance_footer: e.target.value })}
              />
              <p className="hint">
                Markdown the assembler appends to every article in this edition - the model never
                writes it. Empty for no footer.
              </p>
            </div>
          </div>
        );
      })}

      <div className="section">
        <div className="field profile-author">
          <label htmlFor="pp-author">
            Your name <span className="req">REQUIRED</span>
          </label>
          <input
            id="pp-author"
            className={`input${authorTouched && authorError ? ' invalid' : ''}`}
            maxLength={MAX_AUTHOR_LENGTH}
            placeholder="Recorded with the version you save"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            onBlur={() => setAuthorTouched(true)}
          />
          {authorTouched && authorError && <div className="field-error">{authorError}</div>}
        </div>
        <div className="row">
          <button className="btn" disabled={!canSave} onClick={save}>
            {saving ? 'Saving…' : 'Save new version'}
          </button>
          {dirty && (
            <button
              className="btn ghost"
              disabled={saving}
              onClick={() => {
                setForm(profileToForm(current.profile));
                setNotice(null);
              }}
            >
              Discard changes
            </button>
          )}
          {!dirty && !notice && <span className="muted">No unsaved changes.</span>}
          {notice && <span style={{ color: 'var(--green)' }}>{notice}</span>}
        </div>
        {saveError && <div className="error-banner" style={{ marginTop: 12 }}>{saveError}</div>}
        {conflict && (
          <div className="warn-banner" role="alert" style={{ marginTop: 12 }}>
            <span>{conflict}</span>{' '}
            <button className="btn secondary small" onClick={load}>
              Load the latest version
            </button>
          </div>
        )}
      </div>

      <div className="section">
        <h2>Version history</h2>
        <div className="card table-scroll" tabIndex={0} role="region" aria-label="Profile version history">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Saved by</th>
                <th>When</th>
                <th>Changed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.map((v) => (
                <tr key={v.version}>
                  <td className="mono">
                    v{v.version}
                    {v.version === current.version && <span className="badge green">current</span>}
                  </td>
                  <td>{v.author}</td>
                  <td className="muted">{fmtTime(v.created_at)}</td>
                  <td className="muted">{v.changes.length > 0 ? v.changes.join(', ') : 'No changes'}</td>
                  <td>
                    {v.version !== current.version && (
                      <button className="btn secondary small" disabled={saving} onClick={() => restore(v)}>
                        Load into form
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                    no saved versions yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
