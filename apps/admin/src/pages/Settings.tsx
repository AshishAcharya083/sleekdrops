import { useEffect, useState } from 'react';
import { EVENTS, captureError, log, track } from '../analytics';
import type { Settings } from '../api';
import { api } from '../api';

const AGENTS = [
  'topic_scout',
  'researcher',
  'outliner',
  'writer',
  'seo_reviewer',
  'editor',
  'assembler',
] as const;

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
      const next = await api<Settings>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(settings),
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

  return (
    <div className="card">
      <div className="section" style={{ marginTop: 0 }}>
        <h2>Gemini engine</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Runs topic scout, researcher, outliner and SEO reviewer (and writer/editor
          when the toggle below says so) through Google ADK. Empty fields fall back
          to apps/agent/.env; on Cloud Run the key is optional — the service account
          bills Vertex AI directly. Values are stored in the platform database —
          set ADMIN_TOKEN if the API is reachable by others.
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
          Writes prose on your Claude plan — $0 marginal cost. Mint a one-year token
          on any machine with <code>claude setup-token</code> (Pro/Max/Team/Enterprise)
          and paste it here; no restart needed. Without a token, writer and editor
          quietly fall back to the Gemini engine.
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
            placeholder="claude-sonnet-4-5 (default)"
            value={llm.claude_model ?? ''}
            onChange={(e) =>
              setSettings({ ...settings, llm: { ...llm, claude_model: e.target.value } })
            }
          />
          <label>Writer &amp; editor use</label>
          <select
            value={llm.prose_engine ?? 'claude'}
            onChange={(e) =>
              setSettings({
                ...settings,
                llm: { ...llm, prose_engine: e.target.value as 'claude' | 'gemini' },
              })
            }
          >
            <option value="claude">Claude subscription — best prose, uses your plan quota</option>
            <option value="gemini">Gemini — same engine as the rest of the pipeline</option>
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
          put any single agent on either engine here.
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
