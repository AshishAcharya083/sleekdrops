import { useEffect, useState } from 'react';
import { EVENTS, captureError, log, track } from '../analytics';
import type { Settings } from '../api';
import { api } from '../api';

// Every agent that runs a prompt, and therefore has a model worth overriding.
// `assembler` and `publisher` run deterministic code; `image_agent` is pinned
// to Gemini for vision and hero generation. An override on any of the three
// would either do nothing or break the stage, so none of them is offered.
const AGENTS = [
  'topic_scout',
  'researcher',
  'keyword_strategist',
  'outliner',
  'writer',
  'seo_reviewer',
  'editor',
] as const;

const SOURCE_LABEL: Record<string, string> = {
  'admin-settings': 'set here in Settings',
  'env-oauth-token': 'from CLAUDE_CODE_OAUTH_TOKEN',
  'env-api-key': 'from an API key in the environment',
  'vertex-adc': 'via the Cloud Run service account (Vertex ADC)',
};

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<Settings>('/api/settings')
      .then(setSettings)
      .catch((e: Error) => {
        captureError(e, { action: 'settings_load', surface: 'settings' });
        setErr(e.message);
      });
  }, []);

  if (err) return <div className="error-banner">{err}</div>;
  if (!settings) return <p className="muted">Loading…</p>;

  const save = async () => {
    setErr(null);
    setSaved(false);
    // Shape only: which engines are configured and which enums are chosen. The
    // Gemini key and Claude token are reported as set/not-set, never as values.
    const shape = {
      publish_mode: settings.publish_mode,
      worker_enabled: settings.worker_enabled,
      scout_interval_hours: settings.scout_interval_hours,
      max_revision_rounds: settings.max_revision_rounds,
      prose_engine: settings.llm?.prose_engine,
      models_configured: Object.keys(settings.models ?? {}).length,
      gemini_key_set: Boolean(settings.llm?.gemini_api_key),
      claude_token_set: Boolean(settings.llm?.claude_token),
    };
    log('info', 'saving platform settings', shape);
    try {
      // `engines` is derived server-side and read-only; the API ignores it, but
      // sending back a field we were handed invites a round-trip bug later.
      const { engines: _derived, ...writable } = settings;
      const next = await api<Settings>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(writable),
      });
      setSettings(next);
      setSaved(true);
      track(EVENTS.settingsSaved, shape);
      log('info', 'platform settings saved', shape);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      captureError(e, { action: 'settings_save', surface: 'settings' });
      setErr((e as Error).message);
    }
  };

  const llm = settings.llm ?? {};
  const engines = settings.engines;
  const engine = llm.prose_engine ?? 'claude';
  // The engine the pipeline is about to use, and whether it can actually run.
  // This is the warning that was missing: the toggle said Claude, no token was
  // set anywhere, and every stage quietly ran on Gemini instead.
  const selected = engine === 'claude' ? engines?.claude : engines?.gemini;
  const engineBroken = engines !== undefined && selected?.configured === false;

  return (
    <div className="card">
      {engineBroken && (
        <div className="warn-banner">
          {engine === 'claude' ? (
            <>
              <strong>Claude is selected but has no credential.</strong> Every stage
              will refuse to start until you paste a subscription token below (mint
              one with <code>claude setup-token</code>) or set{' '}
              <code>CLAUDE_CODE_OAUTH_TOKEN</code> on the agent service. Stages no
              longer downgrade themselves — a silent fallback is how a run ends up on{' '}
              <code>gemini-2.5-flash</code> while this page says Opus 5.
            </>
          ) : (
            <>
              <strong>Gemini is selected but has no credential.</strong> Add an AI
              Studio key below, or run the agent with{' '}
              <code>GOOGLE_GENAI_USE_VERTEXAI=true</code> so the service account
              bills Vertex AI directly.
            </>
          )}
        </div>
      )}

      <div className="section" style={{ marginTop: 0 }}>
        <h2>Gemini engine</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Runs the image agent — vision-checking candidate photos and generating a
          hero when none is usable, which is why that one stage is pinned here —
          plus every other stage when the toggle below says so. Goes through Google
          ADK, with Google Search grounding on the stages that verify facts. Empty
          fields fall back to apps/agent/.env; on Cloud Run the key is optional —
          the service account bills Vertex AI directly. Values are stored in the
          platform database — set ADMIN_TOKEN if the API is reachable by others.
          {engines?.gemini.configured && (
            <>
              {' '}
              <span style={{ color: 'var(--green)' }}>
                Ready ({SOURCE_LABEL[engines.gemini.source ?? ''] ?? 'configured'}).
              </span>
            </>
          )}
        </p>
        <div className="settings-grid">
          <label>AI Studio API key</label>
          <input
            type="password"
            placeholder="(from .env GEMINI_API_KEY, or Vertex ADC on Cloud Run)"
            value={llm.gemini_api_key ?? ''}
            onChange={(e) =>
              setSettings({ ...settings, llm: { ...llm, gemini_api_key: e.target.value } })
            }
          />
          <label>Default model</label>
          <input
            placeholder="gemini-2.5-flash (default)"
            value={llm.gemini_model ?? ''}
            onChange={(e) =>
              setSettings({ ...settings, llm: { ...llm, gemini_model: e.target.value } })
            }
          />
        </div>
      </div>

      <div className="section">
        <h2>Claude subscription engine</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Runs every stage that writes or judges the article on your Claude plan at
          $0 marginal cost: topic scout, researcher, keyword strategist, outliner,
          writer, SEO reviewer and editor. Opus 5 is the default model. Mint a
          one-year token on any machine with <code>claude setup-token</code>{' '}
          (Pro/Max/Team/Enterprise) and paste it here; no restart needed. Without
          one, those stages fail with that message rather than falling back to
          Gemini behind your back.
          {engines?.claude.configured && (
            <>
              {' '}
              <span style={{ color: 'var(--green)' }}>
                Ready ({SOURCE_LABEL[engines.claude.source ?? ''] ?? 'configured'}).
              </span>
            </>
          )}
        </p>
        <div className="settings-grid">
          <label>Subscription token</label>
          <input
            type="password"
            placeholder="(from .env CLAUDE_CODE_OAUTH_TOKEN)"
            value={llm.claude_token ?? ''}
            onChange={(e) =>
              setSettings({ ...settings, llm: { ...llm, claude_token: e.target.value } })
            }
          />
          <label>Claude model</label>
          <input
            placeholder="claude-opus-5 (default)"
            value={llm.claude_model ?? ''}
            onChange={(e) =>
              setSettings({ ...settings, llm: { ...llm, claude_model: e.target.value } })
            }
          />
          <label>Every article stage uses</label>
          <select
            value={llm.prose_engine ?? 'claude'}
            onChange={(e) =>
              setSettings({
                ...settings,
                llm: { ...llm, prose_engine: e.target.value as 'claude' | 'gemini' },
              })
            }
          >
            <option value="claude">
              Claude subscription — best judgement and prose, uses your plan quota
            </option>
            <option value="gemini">Gemini — same engine as the image agent</option>
          </select>
        </div>
      </div>

      <div className="section">
        <h2>Pipeline</h2>
      <div className="settings-grid">
        <label>Autonomous topic scout</label>
        <select
          value={String(settings.scout_interval_hours ?? 24)}
          onChange={(e) =>
            setSettings({ ...settings, scout_interval_hours: Number(e.target.value) })
          }
        >
          <option value="0">off — only run manually from the Topics tab</option>
          <option value="6">every 6 hours</option>
          <option value="12">every 12 hours</option>
          <option value="24">daily</option>
          <option value="72">every 3 days</option>
          <option value="168">weekly</option>
        </select>

        <label>Publish mode</label>
        <select
          value={settings.publish_mode}
          onChange={(e) => setSettings({ ...settings, publish_mode: e.target.value })}
        >
          <option value="approval">approval — human approves before publishing (recommended)</option>
          <option value="auto">auto — publish to the live site without approval</option>
          <option value="draft">draft — write to D1 as draft, never dispatch</option>
        </select>

        <label>Max revision rounds</label>
        <input
          type="number"
          min={0}
          max={5}
          value={settings.max_revision_rounds}
          onChange={(e) => setSettings({ ...settings, max_revision_rounds: Number(e.target.value) })}
        />

        <label>Worker enabled</label>
        <select
          value={String(settings.worker_enabled)}
          onChange={(e) => setSettings({ ...settings, worker_enabled: e.target.value === 'true' })}
        >
          <option value="true">yes — pipeline runs</option>
          <option value="false">no — pause all article stages</option>
        </select>
      </div>
      </div>

      <div className="section">
        <h2>Model per agent</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Empty = the engine defaults above. Model ids route the engine too:
          gemini-* runs on Gemini, claude-* on the Claude subscription — so you can
          put any single agent on either engine here. The image agent is not
          listed: it needs Gemini's vision and image generation and always runs
          there.
        </p>
        <div className="settings-grid">
          {AGENTS.map((agent) => (
            <SettingRow
              key={agent}
              agent={agent}
              value={settings.models?.[agent] ?? ''}
              onChange={(v) => {
                const models = { ...(settings.models ?? {}) };
                if (v) models[agent] = v;
                else delete models[agent];
                setSettings({ ...settings, models });
              }}
            />
          ))}
        </div>
      </div>

      <div className="row" style={{ marginTop: 18 }}>
        <button className="btn" onClick={save}>
          Save settings
        </button>
        {saved && <span style={{ color: 'var(--green)' }}>Saved ✓</span>}
      </div>
    </div>
  );
}

function SettingRow({
  agent,
  value,
  onChange,
}: {
  agent: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <>
      <label className="mono">{agent}</label>
      <input placeholder="(default)" value={value} onChange={(e) => onChange(e.target.value)} />
    </>
  );
}
