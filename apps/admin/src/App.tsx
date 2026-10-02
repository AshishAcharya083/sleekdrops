import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { EVENTS, captureError, identifyOperator, resetIdentity, track, viewTab } from './analytics';
import {
  api,
  getApiBase,
  getPlatform,
  getToken,
  PLATFORMS_PATH,
  resolveSelection,
  setApiBase,
  setPlatform,
  setToken,
  visibleTabs,
  type PlatformInfo,
  type PlatformList,
} from './api';
import { toApiError, type ApiError } from './api-error';
import { ApiErrorBanner } from './components';
import { PlatformContext } from './hooks';
import { Overview } from './pages/Overview';
import { Topics } from './pages/Topics';
import { Pipeline } from './pages/Pipeline';
import { Published } from './pages/Published';
import { Channels } from './pages/Channels';
import { Sessions } from './pages/Sessions';
import { SettingsPage } from './pages/Settings';

const TABS = ['Overview', 'Topics', 'Pipeline', 'Published', 'Channels', 'Sessions', 'Settings'] as const;
type Tab = (typeof TABS)[number];

/** The tab the panel opens on. main.tsx boots analytics with it before render. */
export const INITIAL_TAB: Tab = 'Overview';

/** How long the connection fields sit still before the platform list is re-read. */
const CONNECTION_SETTLE_MS = 500;

export function App() {
  const [tab, setTab] = useState<Tab>(INITIAL_TAB);
  const [token, setTokenState] = useState(getToken());
  const [apiBase, setApiBaseState] = useState(getApiBase());
  /** A run the Overview's stuck surface asked the Pipeline tab to open. */
  const [runToOpen, setRunToOpen] = useState<string | null>(null);
  const [platforms, setPlatforms] = useState<PlatformInfo[] | null>(null);
  const [platformsError, setPlatformsError] = useState<ApiError | null>(null);
  const [platformId, setPlatformId] = useState<string | null>(getPlatform());
  const platform = platforms?.find((p) => p.id === platformId) ?? null;
  const tabs = platform ? visibleTabs(TABS, platform) : TABS;
  const shownTab = tabs.includes(tab) ? tab : INITIAL_TAB;

  // Only the newest answer counts: the list is re-read as the connection
  // fields change, and an older reply could come from the API base before.
  const platformsRequest = useRef(0);
  const loadPlatforms = useCallback(() => {
    const request = ++platformsRequest.current;
    api<PlatformList>(PLATFORMS_PATH)
      .then(({ platforms: listed }) => {
        if (request !== platformsRequest.current) return;
        setPlatforms(listed);
        setPlatformsError(null);
        const chosen = resolveSelection(listed, getPlatform());
        if (chosen) {
          setPlatform(chosen.id);
          setPlatformId(chosen.id);
        }
      })
      .catch((e: unknown) => {
        captureError(e, { route: PLATFORMS_PATH, action: 'platforms_load' });
        if (request === platformsRequest.current) setPlatformsError(toApiError(e));
      });
  }, []);

  // At once on boot, then again once a changed token or API base settles.
  const booted = useRef(false);
  useEffect(() => {
    const delay = booted.current ? CONNECTION_SETTLE_MS : 0;
    booted.current = true;
    const timer = setTimeout(loadPlatforms, delay);
    return () => clearTimeout(timer);
  }, [loadPlatforms, token, apiBase]);

  useEffect(() => {
    document.title = platform ? `${platform.name} Agent Platform` : 'Agent Platform';
  }, [platform]);

  const openTab = (next: Tab) => {
    setTab(next);
    viewTab(next);
  };

  /**
   * Every page below is keyed by the platform, so a switch remounts it with
   * nothing of the previous platform's data, drawers or selections left over;
   * setPlatform() also tells any poll still holding a payload to drop it.
   */
  const switchPlatform = (next: PlatformInfo) => {
    if (!setPlatform(next.id)) return;
    setPlatformId(next.id);
    setRunToOpen(null);
    track(EVENTS.platformSwitched, { platform_id: next.id });
    if (!visibleTabs(TABS, next).includes(shownTab)) openTab(INITIAL_TAB);
  };

  /** The stuck surface links straight at the run: one click, no hunting. */
  const openRun = (articleId: string) => {
    setRunToOpen(articleId);
    openTab('Pipeline');
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
          {platform && `${platform.name} `}
          <span>Agent Platform</span>
        </h1>
        {platforms && platforms.length > 1 && (
          <div className="tabs platform-switch" role="group" aria-label="Platform">
            {platforms.map((p) => (
              <button
                key={p.id}
                className={p.id === platformId ? 'active' : ''}
                aria-pressed={p.id === platformId}
                onClick={() => switchPlatform(p)}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
        <nav className="tabs">
          {tabs.map((t) => (
            <button key={t} className={t === shownTab ? 'active' : ''} onClick={() => openTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <div className="conn">
          <input
            aria-label="API base"
            placeholder="API base (empty = this host)"
            value={apiBase}
            onChange={(e) => onApiBaseChange(e.target.value)}
          />
          <input
            type="password"
            aria-label="Admin token"
            placeholder="admin token (if set)"
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
          />
        </div>
      </div>

      {platform ? (
        <PlatformContext.Provider value={platform}>
          <Fragment key={platform.id}>
            {shownTab === 'Overview' && <Overview onOpenRun={openRun} />}
            {shownTab === 'Topics' && <Topics />}
            {shownTab === 'Pipeline' && (
              <Pipeline openArticleId={runToOpen} onOpened={() => setRunToOpen(null)} />
            )}
            {shownTab === 'Published' && <Published />}
            {shownTab === 'Channels' && <Channels />}
            {shownTab === 'Sessions' && <Sessions />}
            {shownTab === 'Settings' && <SettingsPage onSaved={loadPlatforms} />}
          </Fragment>
        </PlatformContext.Provider>
      ) : platformsError ? (
        <ApiErrorBanner error={platformsError} onRetry={loadPlatforms} />
      ) : platforms ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            The agent lists no platforms yet. Platforms are seeded when the agent boots - restart it
            once its database migrations have run, then reload this page.
          </p>
        </div>
      ) : (
        <p className="muted">Loading platforms…</p>
      )}
    </div>
  );
}
