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

  return (
    <div className="card">
      <div className="settings-grid">
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

      <div className="section">
        <h2>Model per agent (OpenRouter model ids)</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Empty = the MODEL_DEFAULT from apps/agent/.env. Any OpenRouter id works:
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
