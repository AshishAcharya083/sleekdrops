import { useEffect, useState } from 'react';
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
    api<Settings>('/api/settings').then(setSettings).catch((e: Error) => setErr(e.message));
  }, []);

  if (err) return <div className="error-banner">{err}</div>;
  if (!settings) return <p className="muted">Loading…</p>;

  const save = async () => {
    setErr(null);
    setSaved(false);
    try {
      const next = await api<Settings>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(settings),
      });
      setSettings(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const llm = settings.llm ?? {};

  return (
    <div className="card">
      <div className="section" style={{ marginTop: 0 }}>
        <h2>AI provider</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          The whole pipeline speaks the OpenAI-compatible chat API — pick who serves
          it. Empty fields fall back to apps/agent/.env. Keys are stored in the
          platform database — set ADMIN_TOKEN if the API is reachable by others.
        </p>
        <div className="settings-grid">
          <label>Provider</label>
          <select
            value={llm.provider ?? 'openrouter'}
            onChange={(e) =>
              setSettings({
                ...settings,
                llm: { ...llm, provider: e.target.value as 'openrouter' | 'gemini' | 'custom' },
              })
            }
          >
            <option value="openrouter">OpenRouter — one key, any model (Gemini/Claude/GPT…)</option>
            <option value="gemini">Google Gemini — AI Studio key, uses your Google Cloud credits</option>
            <option value="custom">Custom — any OpenAI-compatible endpoint</option>
          </select>
          {(llm.provider ?? 'openrouter') === 'custom' && (
            <>
              <label>Base URL</label>
              <input
                placeholder="https://my-endpoint.example.com/v1"
                value={llm.base_url ?? ''}
                onChange={(e) =>
                  setSettings({ ...settings, llm: { ...llm, base_url: e.target.value } })
                }
              />
            </>
          )}
          <label>API key</label>
          <input
            type="password"
            placeholder={
              (llm.provider ?? 'openrouter') === 'gemini'
                ? '(from .env: GEMINI_API_KEY)'
                : '(from .env: OPENROUTER_API_KEY)'
            }
            value={llm.api_key ?? ''}
            onChange={(e) => setSettings({ ...settings, llm: { ...llm, api_key: e.target.value } })}
          />
          <label>Default model</label>
          <input
            placeholder={
              (llm.provider ?? 'openrouter') === 'gemini'
                ? 'gemini-2.5-flash (default)'
                : 'google/gemini-2.5-flash (default)'
            }
            value={llm.default_model ?? ''}
            onChange={(e) =>
              setSettings({ ...settings, llm: { ...llm, default_model: e.target.value } })
            }
          />
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
        <h2>Model per agent (OpenRouter model ids)</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Empty = the default model above. Any model id your provider offers:
          google/gemini-2.5-flash, anthropic/claude-sonnet-4.5, openai/gpt-4o…
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
