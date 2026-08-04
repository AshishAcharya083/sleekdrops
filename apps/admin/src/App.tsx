import { useState } from 'react';
import { EVENTS, identifyOperator, resetIdentity, track, viewTab } from './analytics';
import { getApiBase, getToken, setApiBase, setToken } from './api';
import { Overview } from './pages/Overview';
import { Topics } from './pages/Topics';
import { Pipeline } from './pages/Pipeline';
import { Published } from './pages/Published';
import { Sessions } from './pages/Sessions';
import { SettingsPage } from './pages/Settings';

const TABS = ['Overview', 'Topics', 'Pipeline', 'Published', 'Sessions', 'Settings'] as const;
type Tab = (typeof TABS)[number];

/** The tab the panel opens on. main.tsx boots analytics with it before render. */
export const INITIAL_TAB: Tab = 'Overview';

export function App() {
  const [tab, setTab] = useState<Tab>(INITIAL_TAB);
  const [token, setTokenState] = useState(getToken());
  const [apiBase, setApiBaseState] = useState(getApiBase());

  const openTab = (next: Tab) => {
    setTab(next);
    viewTab(next);
  };

  // The panel is token-gated but has no accounts: gaining a token is the closest
  // thing to a login and clearing it to a logout. The token value itself is a
  // secret and never reaches analytics - only whether one is present.
  const onTokenChange = (next: string) => {
    const had = token.trim() !== '';
    const has = next.trim() !== '';
    setTokenState(next);
    setToken(next);
    if (had === has) return;
    if (has) identifyOperator();
    else resetIdentity();
    track(EVENTS.connectionSettingChanged, { field: 'admin_token', value_present: has });
  };

  const onApiBaseChange = (next: string) => {
    const had = apiBase.trim() !== '';
    const has = next.trim() !== '';
    setApiBaseState(next);
    setApiBase(next);
    if (had !== has) {
      track(EVENTS.connectionSettingChanged, { field: 'api_base', value_present: has });
    }
  };

  return (
    <div className="shell">
      <div className="topbar">
        <h1>
          SleekDrops <span>Agent Platform</span>
        </h1>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t} className={t === tab ? 'active' : ''} onClick={() => openTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <input
          style={{ width: 190 }}
          placeholder="API base (empty = this host)"
          value={apiBase}
          onChange={(e) => onApiBaseChange(e.target.value)}
        />
        <input
          type="password"
          style={{ width: 170 }}
          placeholder="admin token (if set)"
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
        />
      </div>

      {tab === 'Overview' && <Overview />}
      {tab === 'Topics' && <Topics />}
      {tab === 'Pipeline' && <Pipeline />}
      {tab === 'Published' && <Published />}
      {tab === 'Sessions' && <Sessions />}
      {tab === 'Settings' && <SettingsPage />}
    </div>
  );
}
