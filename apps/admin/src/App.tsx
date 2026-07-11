import { useState } from 'react';
import { getToken, setToken } from './api';
import { Overview } from './pages/Overview';
import { Topics } from './pages/Topics';
import { Pipeline } from './pages/Pipeline';
import { Sessions } from './pages/Sessions';
import { SettingsPage } from './pages/Settings';

const TABS = ['Overview', 'Topics', 'Pipeline', 'Sessions', 'Settings'] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [tab, setTab] = useState<Tab>('Overview');
  const [token, setTokenState] = useState(getToken());

  return (
    <div className="shell">
      <div className="topbar">
        <h1>
          SleekDrops <span>Agent Platform</span>
        </h1>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <input
          type="password"
          placeholder="admin token (if set)"
          value={token}
          onChange={(e) => {
            setTokenState(e.target.value);
            setToken(e.target.value);
          }}
        />
      </div>

      {tab === 'Overview' && <Overview />}
      {tab === 'Topics' && <Topics />}
      {tab === 'Pipeline' && <Pipeline />}
      {tab === 'Sessions' && <Sessions />}
      {tab === 'Settings' && <SettingsPage />}
    </div>
  );
}
