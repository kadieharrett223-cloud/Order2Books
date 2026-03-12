import { useEffect, useState } from 'react';
import './App.css';

async function getShopifySessionToken() {
  try {
    if (typeof window !== 'undefined' && window.shopify && typeof window.shopify.idToken === 'function') {
      return await window.shopify.idToken();
    }
  } catch {
  }

  return null;
}

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});

  const sessionToken = await getShopifySessionToken();
  if (sessionToken) {
    headers.set('Authorization', `Bearer ${sessionToken}`);
    headers.set('X-Shopify-Session-Token', sessionToken);
  }

  return fetch(url, {
    ...options,
    headers,
  });
}

const DEFAULT_SETTINGS = {
  shopifyDomain: '',
  shopifyApiKey: '',
  shopifyConnected: false,
  qboConnected: false,
  qboCompanyName: '',
  autoDecrementInventory: false,
  autoCreateQboItems: true,
  captureMode: 'auto',
  isDemo: false,
};

const DEFAULT_PLAN_DATA = {
  plan: {
    key: 'starter',
    name: 'Starter',
    priceMonthly: 9.99,
    orderLimitPerMonth: 100,
    usedOrdersThisMonth: 0,
    remainingOrdersThisMonth: 100,
    supportsMultiStore: false,
    features: [
      'Up to 100 auto-invoice orders / month',
      'Basic order → invoice sync',
      'Manual retry',
      'Email support',
    ],
  },
  plans: [
    {
      key: 'starter',
      name: 'Starter',
      priceMonthly: 9.99,
      orderLimitPerMonth: 100,
      features: [
        'Up to 100 auto-invoice orders / month',
        'Basic order → invoice sync',
        'Manual retry',
        'Email support',
      ],
    },
    {
      key: 'scale',
      name: 'Scale',
      priceMonthly: 29,
      orderLimitPerMonth: null,
      features: [
        'Unlimited orders',
        'Multi-store support',
        'Advanced reporting',
        'Dedicated support',
      ],
    },
  ],
};

const TUTORIAL_STEPS = [
  {
    page: 'dashboard',
    navTarget: null,
    title: '👋 Welcome to Order2Books',
    description: 'This quick tour will walk you through the key steps to start syncing your Shopify orders to QuickBooks. Press Next to begin.',
  },
  {
    page: 'settings',
    navTarget: 'settings',
    title: '📚 Step 1 — Connect QuickBooks',
    description: 'Go to Settings and click "Connect QuickBooks Online" to authorize your QB account. Once connected, invoices will be created automatically for every paid Shopify order.',
  },
  {
    page: 'mapping',
    navTarget: 'mapping',
    title: '🧩 Step 2 — Product Mapping',
    description: 'Start here! Product mapping is required before sync can work. Every Shopify product must be linked to a QuickBooks item, or invoices cannot be created for those orders. Any products that couldn\'t be auto-matched show under "Items Needing Attention" — search and select the correct QB item for each.',
  },
  {
    page: 'dashboard',
    navTarget: 'dashboard',
    title: '📊 Step 3 — Your Dashboard',
    description: 'Monitor synced orders, spot errors, and search for any order by Shopify ID. The dashboard refreshes automatically every 5 minutes.',
  },
  {
    page: 'syncLog',
    navTarget: 'syncLog',
    title: '📋 Step 4 — Sync Log',
    description: 'The Sync Log shows every webhook, invoice creation, and error in detail. Use it to retry failed syncs and track exactly what happened.',
  },
  {
    page: 'dashboard',
    navTarget: null,
    title: '✅ You\'re all set!',
    description: 'Starter includes 100 auto-invoice orders per month. Need more? Upgrade to the Unlimited plan in payment settings.',
  },
];

function formatRelativeTime(value) {
  if (!value) return '—';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.max(0, Math.round(diffMs / 60000));

  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes} min ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hr ago`;

  const diffDays = Math.round(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}

function getStatusBadgeClass(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'success' || normalized === 'synced' || normalized === 'received') return 'status-synced';
  if (normalized.includes('fail')) return 'status-failed';
  return 'status-retrying';
}

function App() {
  const [activePage, setActivePage] = useState('dashboard');
  const [settingsTab, setSettingsTab] = useState('general');
  const [showUpgradePanel, setShowUpgradePanel] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState('');
  const [upgradeMessage, setUpgradeMessage] = useState('');
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [syncs, setSyncs] = useState([]);
  const [syncsLoading, setSyncsLoading] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [mappings, setMappings] = useState({ autoMapped: [], needsAttention: [] });
  const [mappingsLoading, setMappingsLoading] = useState(false);
  const [mappingEdits, setMappingEdits] = useState({});
  const [mappingItemSearch, setMappingItemSearch] = useState({}); // { mappingId: searchTerm }
  const [mappingItemSearchResults, setMappingItemSearchResults] = useState({}); // { mappingId: [items] }
  const [scanBusy, setScanBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [planData, setPlanData] = useState(DEFAULT_PLAN_DATA);
  const [tutorialStep, setTutorialStep] = useState(0);
  const [tutorialActive, setTutorialActive] = useState(false);

  const loadPlan = async () => {
    try {
      const response = await apiFetch('/api/plan');
      if (!response.ok) return;
      const data = await response.json();
      setPlanData(data);
    } catch {
    }
  };

  const loadSyncs = async () => {
    setSyncsLoading(true);
    try {
      const response = await apiFetch('/api/syncs');
      if (!response.ok) return;
      const data = await response.json();
      setSyncs(Array.isArray(data.syncs) ? data.syncs : []);
      setDemoMode(Boolean(data.demoMode));
    } catch {
      setSyncs([]);
    } finally {
      setSyncsLoading(false);
    }
  };

  const loadMappings = async () => {
    setMappingsLoading(true);
    try {
      const response = await apiFetch('/api/mappings');
      if (!response.ok) return;
      const data = await response.json();
      setMappings({
        autoMapped: Array.isArray(data.autoMapped) ? data.autoMapped : [],
        needsAttention: Array.isArray(data.needsAttention) ? data.needsAttention : [],
      });
      setDemoMode(Boolean(data.demoMode));
    } catch {
      setMappings({ autoMapped: [], needsAttention: [] });
    } finally {
      setMappingsLoading(false);
    }
  };

  useEffect(() => {
    loadPlan();
    loadSyncs();
    loadSettings();
    loadLogs();
    loadMappings();
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      refreshAppData();
    }, 5 * 60 * 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    // Initialize tutorial on first load
    const tutorialCompleted = localStorage.getItem('order2books-tutorial-completed');
    if (!tutorialCompleted) {
      setTutorialActive(true);
      setTutorialStep(0);
    }
  }, []);



  const startTutorial = () => {
    setTutorialActive(true);
    setTutorialStep(0);
    setActivePage('dashboard');
  };

  const nextTutorialStep = () => {
    if (tutorialStep < TUTORIAL_STEPS.length - 1) {
      setTutorialStep(tutorialStep + 1);
      // Auto-navigate to the relevant page
      const nextStep = TUTORIAL_STEPS[tutorialStep + 1];
      if (nextStep.page) {
        setActivePage(nextStep.page);
      }
    } else {
      completeTutorial();
    }
  };

  const completeTutorial = () => {
    setTutorialActive(false);
    localStorage.setItem('order2books-tutorial-completed', 'true');
  };

  const skipTutorial = () => {
    setTutorialActive(false);
    localStorage.setItem('order2books-tutorial-completed', 'true');
  };

  const refreshPlan = async () => {
    const response = await apiFetch('/api/plan');
    if (!response.ok) return;
    const data = await response.json();
    setPlanData(data);
  };

  const loadLogs = async () => {
    setLogsLoading(true);
    try {
      const response = await apiFetch('/api/logs');
      if (!response.ok) return;
      const data = await response.json();
      setLogs(Array.isArray(data.logs) ? data.logs : []);
      setDemoMode(Boolean(data.demoMode));
    } catch {
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    if (activePage === 'syncLog') {
      loadLogs();
    }
    if (activePage === 'mapping') {
      loadMappings();
    }
  }, [activePage]);

  const formatLogTime = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString();
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResult(null);
      return;
    }
    try {
      const response = await apiFetch(`/api/syncs/${encodeURIComponent(searchQuery.trim())}`);
      if (!response.ok) {
        setSearchResult({ error: 'Order not found' });
        return;
      }
      const data = await response.json();
      setSearchResult(data.sync);
    } catch {
      setSearchResult({ error: 'Search failed' });
    }
  };

  const loadSettings = async () => {
    try {
      const response = await apiFetch('/api/settings');
      if (!response.ok) return;
      const data = await response.json();
      setSettings({ ...DEFAULT_SETTINGS, ...(data.settings || {}) });
      setDemoMode(Boolean(data.demoMode || data.settings?.isDemo));
    } catch {
    }
  };

  const saveSettings = async () => {
    if (demoMode) {
      alert('Install the app in Shopify to save live settings.');
      return;
    }

    try {
      const response = await apiFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (response.ok) {
        alert('Settings saved successfully!');
      } else {
        const data = await response.json().catch(() => ({}));
        alert(data.error || 'Failed to save settings');
      }
    } catch {
      alert('Failed to save settings');
    }
  };

  const refreshAppData = async () => {
    await Promise.all([loadPlan(), loadSettings(), loadSyncs(), loadLogs(), loadMappings()]);
  };

  const saveMapping = async (mappingId) => {
    const edit = mappingEdits[mappingId] || {};
    const qboItemId = String(edit.qboItemId || '').trim();
    const qboItemName = String(edit.qboItemName || '').trim();

    if (!qboItemId || !qboItemName) {
      alert('Enter both QuickBooks item id and item name.');
      return;
    }

    try {
      const response = await apiFetch(`/api/mappings/${mappingId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qboItemId, qboItemName }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        alert(data.error || 'Failed to save mapping.');
        return;
      }

      await loadMappings();
      setMappingItemSearch((prev) => ({ ...prev, [mappingId]: '' }));
      setMappingItemSearchResults((prev) => ({ ...prev, [mappingId]: [] }));
    } catch {
      alert('Failed to save mapping.');
    }
  };

  const searchQboItems = async (mappingId, searchTerm) => {
    setMappingItemSearch((prev) => ({ ...prev, [mappingId]: searchTerm }));

    if (!searchTerm || searchTerm.trim().length < 2) {
      setMappingItemSearchResults((prev) => ({ ...prev, [mappingId]: [] }));
      return;
    }

    try {
      const response = await apiFetch(`/api/qbo-items/search?q=${encodeURIComponent(searchTerm)}`);
      if (!response.ok) {
        setMappingItemSearchResults((prev) => ({ ...prev, [mappingId]: [] }));
        return;
      }

      const data = await response.json();
      const items = Array.isArray(data.items) ? data.items : [];
      setMappingItemSearchResults((prev) => ({ ...prev, [mappingId]: items }));
    } catch {
      setMappingItemSearchResults((prev) => ({ ...prev, [mappingId]: [] }));
    }
  };

  const selectQboItem = (mappingId, item) => {
    setMappingEdits((prev) => ({
      ...prev,
      [mappingId]: {
        ...prev[mappingId],
        qboItemId: String(item.id),
        qboItemName: String(item.name),
      },
    }));
    setMappingItemSearch((prev) => ({ ...prev, [mappingId]: '' }));
    setMappingItemSearchResults((prev) => ({ ...prev, [mappingId]: [] }));
  };

  const runMappingScan = async () => {
    if (demoMode) {
      alert('Install on Shopify to run live mapping scans.');
      return;
    }

    setScanBusy(true);
    try {
      const response = await apiFetch('/api/mappings/scan', { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        alert(data.error || 'Mapping scan failed to start.');
        return;
      }

      alert(data.message || 'Mapping scan started. Refresh in a moment to see updates.');
      await loadMappings();
    } catch {
      alert('Mapping scan failed to start.');
    } finally {
      setScanBusy(false);
    }
  };

  const handleUpgrade = async (planKey) => {
    setUpgradeMessage('');
    setUpgradeBusy(planKey);
    try {
      const response = await apiFetch('/api/plan/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planKey }),
      });
      const data = await response.json();
      if (!response.ok) {
        setUpgradeMessage(data.error || 'Upgrade failed.');
        return;
      }
      setUpgradeMessage(data.message || 'Plan updated.');
      await refreshPlan();
    } catch {
      setUpgradeMessage('Upgrade failed. Please try again.');
    } finally {
      setUpgradeBusy('');
    }
  };

  const usedOrdersThisMonth = Number(planData.plan.usedOrdersThisMonth || 0);
  const monthlyLimit = planData.plan.orderLimitPerMonth;
  const usageRatio = monthlyLimit ? usedOrdersThisMonth / monthlyLimit : 0;
  const remainingOrdersThisMonth = monthlyLimit == null
    ? null
    : Math.max(monthlyLimit - usedOrdersThisMonth, 0);
  const showStarterOrdersBadge = planData.plan.key === 'starter' && monthlyLimit != null;
  const showUpgradeWarning = monthlyLimit != null && usageRatio >= 0.8;
  const syncedOrdersCount = syncs.filter((sync) => String(sync.syncStatus).toLowerCase() === 'synced').length;
  const invoiceCount = syncs.filter((sync) => Boolean(sync.qboInvoiceId)).length;
  const syncErrorCount = syncs.filter((sync) => String(sync.syncStatus).toLowerCase().includes('fail')).length;
  const attentionCount = syncs.filter((sync) => {
    const status = String(sync.syncStatus || '').toLowerCase();
    return status && status !== 'synced' && status !== 'success';
  }).length;
  const disconnectedCount = settings.qboConnected ? 0 : 1;
  const lastSync = syncs[0]?.syncedAt || null;
  const recentSyncCount = syncs.filter((sync) => {
    if (!sync.syncedAt) return false;
    return Date.now() - new Date(sync.syncedAt).getTime() <= 24 * 60 * 60 * 1000;
  }).length;
  const recentInvoiceCount = syncs.filter((sync) => {
    if (!sync.syncedAt || !sync.qboInvoiceId) return false;
    return Date.now() - new Date(sync.syncedAt).getTime() <= 24 * 60 * 60 * 1000;
  }).length;
  const recentActivity = logs.slice(0, 4);
  const recentTableSyncs = syncs.slice(0, 5);

  return (
    <div className="app">
      {/* Top Header */}
      <header className="top-header">
        <div className="header-left">
          <h1 className="app-title">Order2Books <span className="title-light">Dashboard</span></h1>
        </div>
        <div className="header-actions">
          {showStarterOrdersBadge ? (
            <button className="starter-orders-tab" onClick={() => setActivePage('settings')}>
              Auto-invoice left: {remainingOrdersThisMonth} / {monthlyLimit}
            </button>
          ) : null}
          <button className="btn-secondary" onClick={() => setActivePage('syncLog')}>
            📊 Activity
          </button>
          <button className="btn-secondary" onClick={refreshAppData}>
            {demoMode ? '⏱ Auto refresh: 5 min' : '🔵 Refresh'}
          </button>
          <button
            className={`btn-upgrade ${showUpgradeWarning ? 'btn-upgrade-warning' : ''}`}
            onClick={() => setShowUpgradePanel((value) => !value)}
          >
            ⬆ Upgrade
          </button>
          <button className="btn-primary" onClick={() => setActivePage('settings')}>
            {demoMode ? 'Preview Mode' : 'Connections'}
          </button>
        </div>
      </header>

      <div className="main-layout">
        {/* Sidebar */}
        <aside className="sidebar">
          <nav className="sidebar-nav">
            <button className={`nav-item ${activePage === 'dashboard' ? 'active' : ''} ${tutorialActive && TUTORIAL_STEPS[tutorialStep]?.navTarget === 'dashboard' ? 'tutorial-nav-highlight' : ''}`} onClick={() => setActivePage('dashboard')}>
              <span className="nav-icon">🏠</span>
              <span className="nav-label">Dashboard</span>
            </button>
            <button className={`nav-item ${activePage === 'mapping' ? 'active' : ''} ${tutorialActive && TUTORIAL_STEPS[tutorialStep]?.navTarget === 'mapping' ? 'tutorial-nav-highlight' : ''}`} onClick={() => setActivePage('mapping')}>
              <span className="nav-icon">🧩</span>
              <span className="nav-label">Mapping</span>
            </button>
            <button className={`nav-item ${activePage === 'syncLog' ? 'active' : ''} ${tutorialActive && TUTORIAL_STEPS[tutorialStep]?.navTarget === 'syncLog' ? 'tutorial-nav-highlight' : ''}`} onClick={() => setActivePage('syncLog')}>
              <span className="nav-icon">📊</span>
              <span className="nav-label">Sync Log</span>
            </button>
            <button className={`nav-item ${activePage === 'settings' ? 'active' : ''} ${tutorialActive && TUTORIAL_STEPS[tutorialStep]?.navTarget === 'settings' ? 'tutorial-nav-highlight' : ''}`} onClick={() => setActivePage('settings')}>
              <span className="nav-icon">⚙</span>
              <span className="nav-label">Settings</span>
            </button>
            <button className={`nav-item ${activePage === 'help' ? 'active' : ''}`} onClick={() => setActivePage('help')}>
              <span className="nav-icon">❓</span>
              <span className="nav-label">Help</span>
            </button>
            <button className="nav-item" onClick={startTutorial}>
              <span className="nav-icon">🎓</span>
              <span className="nav-label">Tutorial</span>
            </button>
          </nav>
          <div className="sidebar-bottom">
            <div className="user-info">
              <div className="workspace-icon">📋</div>
              <div className="user-label">pri ▼</div>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="content">
          {demoMode ? (
            <div className="demo-notice">Demo data only, install on Shopify to use.</div>
          ) : null}

          <div className="page-header">
            <h2 className="page-title">
              {activePage === 'dashboard' && 'OrderBooks Dashboard'}
              {activePage === 'settings' && 'Settings'}
              {activePage === 'mapping' && 'Product Mapping'}
              {activePage === 'help' && 'Help'}
            </h2>
            <p className="page-subtitle">
              {activePage === 'dashboard' && 'Monitor sync health between Shopify and QuickBooks'}
              {activePage === 'syncLog' && 'Track sync events, webhook outcomes, and retry history'}
              {activePage === 'settings' && 'Manage plan, defaults, and integration preferences'}
              {activePage === 'mapping' && 'Review auto-mapped products and fix items needing attention'}
              {activePage === 'help' && 'Quick links and support guidance for OrderBooks'}
            </p>
          </div>
          <div className="page-divider"></div>

          {activePage === 'dashboard' ? (
            <>
          {/* Stats Cards */}
          <div className="stats-grid">
            <div className="stat-card stat-card-blue">
              <div className="stat-header">
                <div className="stat-icon">📦</div>
                <div className="stat-label">Orders Synced</div>
              </div>
              <div className="stat-number">{syncsLoading ? '…' : syncedOrdersCount}</div>
              <div className="stat-change positive">{demoMode ? '100 sample invoices synced' : `+${recentSyncCount} in last 24h`}</div>
            </div>

            <div className="stat-card stat-card-green">
              <div className="stat-header">
                <div className="stat-icon">📄</div>
                <div className="stat-label">Invoices Created</div>
              </div>
              <div className="stat-number">{syncsLoading ? '…' : invoiceCount}</div>
              <div className="stat-change positive">{demoMode ? 'Large sample invoice history' : `+${recentInvoiceCount} in last 24h`}</div>
            </div>

            <div className="stat-card stat-card-red">
              <div className="stat-header">
                <div className="stat-icon">⚠</div>
                <div className="stat-label">Sync Errors</div>
              </div>
              <div className="stat-number">{syncsLoading ? '…' : syncErrorCount}</div>
              <div className="stat-change negative">{attentionCount} need attention</div>
            </div>

            <div className="stat-card stat-card-purple">
              <div className="stat-header">
                <div className="stat-icon">🕐</div>
                <div className="stat-label">Last Sync</div>
              </div>
              <div className="stat-number-small">{formatRelativeTime(lastSync)}</div>
              <div className="stat-change">{demoMode ? 'Sample timeline' : 'Live timeline'}</div>
            </div>
          </div>

          {/* Connected Accounts Section */}
          <section className="section-card">
            <h3 className="section-title">Connected Accounts</h3>
            <div className="connected-accounts">
              <div className="account-card">
                <div className="account-logo shopify-logo">🛍️</div>
                <div className="account-info">
                  <div className="account-name">{settings.shopifyDomain || 'No Shopify store connected'}</div>
                  <div className={`account-status ${settings.shopifyConnected ? 'connected' : 'disconnected'}`}>
                    {settings.shopifyConnected ? '✓ Connected' : '✕ Not connected'}
                  </div>
                  <div className="account-meta">{demoMode ? 'Sample Shopify store preview' : 'Live Shopify connection status'}</div>
                </div>
              </div>

              <div className="account-arrow">→</div>

              <div className="account-card">
                <div className="account-logo qb-logo">🟢</div>
                <div className="account-info">
                  <div className="account-name">{settings.qboCompanyName || 'QuickBooks Online'}</div>
                  <div className={`account-status ${settings.qboConnected ? 'connected' : 'disconnected'}`}>
                    {settings.qboConnected ? '✓ Connected' : '✕ Disconnected'}
                  </div>
                  <div className="account-meta">{demoMode ? 'Sample QuickBooks connection preview' : 'Live QuickBooks connection status'}</div>
                </div>
                <button
                  className="btn-connect"
                  disabled={demoMode}
                  onClick={() => {
                    if (!demoMode) {
                      window.location.href = '/api/auth/qbo/start';
                    }
                  }}
                >
                  {demoMode ? 'Install to connect' : settings.qboConnected ? 'Connected' : 'Connect'}
                </button>
              </div>
            </div>
          </section>

          {/* Sync Activity Section */}
          <section className="section-card">
            <h3 className="section-title">Sync Health</h3>
            
            {/* Sync Health Metrics */}
            <div className="sync-health-bar">
              <div className="health-pill">
                <span className="health-icon green">✓</span>
                <span className="health-label">Healthy syncs</span>
                <strong className="health-value">{syncedOrdersCount}</strong>
              </div>
              <div className="health-pill">
                <span className="health-icon orange">⚠</span>
                <span className="health-label">Needs attention</span>
                <strong className="health-value">{attentionCount}</strong>
              </div>
              <div className="health-pill">
                <span className="health-icon red">⛔</span>
                <span className="health-label">Disconnected</span>
                <strong className="health-value">{disconnectedCount}</strong>
              </div>
              <div className="health-pill">
                <span className="health-icon gray">⏱</span>
                <span className="health-label">Dashboard mode</span>
                <strong className="health-value">{demoMode ? 'Demo data' : 'Live data'}</strong>
              </div>
            </div>

            {/* Order Search */}
            <div className="search-section">
              <h4 style={{ fontSize: '15px', fontWeight: '600', marginBottom: '12px', color: '#0f172a' }}>Search by Shopify Order #</h4>
              <div className="search-box">
                <input 
                  type="text" 
                  className="search-input" 
                  placeholder="Enter Shopify Order ID (e.g., 1234567890)" 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                />
                <button className="btn-search" onClick={handleSearch}>Search</button>
              </div>
              {searchResult && (
                <div className="search-result">
                  {searchResult.error ? (
                    <div className="search-error">{searchResult.error}</div>
                  ) : (
                    <div className="search-success">
                      <strong>Found:</strong> Shopify Order #{searchResult.shopifyOrderId || searchResult.shopifyOrderName} → QuickBooks Invoice #{searchResult.qboInvoiceId || 'Not synced yet'}
                      <br />
                      <span style={{ fontSize: '13px', color: '#64748b' }}>Status: {searchResult.syncStatus}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Sync Table */}
            <div className="table-container">
              <table className="sync-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Invoice</th>
                    <th>Status</th>
                    <th>Time</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {recentTableSyncs.length === 0 ? (
                    <tr>
                      <td colSpan="5">{syncsLoading ? 'Loading sync activity...' : 'No order syncs found yet.'}</td>
                    </tr>
                  ) : recentTableSyncs.map((sync) => (
                    <tr key={sync.shopifyOrderId}>
                      <td>
                        <span className="order-id">{sync.shopifyOrderName || `#${sync.shopifyOrderId}`}</span>
                        <span className="invoice-id-mini">{sync.qboInvoiceId || '(pending)'}</span>
                      </td>
                      <td className="invoice-mapping">{`${sync.shopifyOrderName || `#${sync.shopifyOrderId}`} → ${sync.qboInvoiceId || '(pending)'}`}</td>
                      <td>
                        <span className={`status-badge ${getStatusBadgeClass(sync.syncStatus)}`}>
                          {sync.syncStatus || '—'}
                        </span>
                      </td>
                      <td>{formatRelativeTime(sync.syncedAt)}</td>
                      <td>
                        <button className="btn-action" onClick={() => { setActivePage('syncLog'); setSearchQuery(String(sync.shopifyOrderId || '')); }}>
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Recent Activity */}
          <section className="section-card">
            <div className="section-header">
              <h3 className="section-title">Recent Activity</h3>
              <button className="btn-more">⋯</button>
            </div>
            <div className="table-container">
              <table className="sync-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Event</th>
                    <th>Status</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {recentActivity.length === 0 ? (
                    <tr>
                      <td colSpan="4">No recent activity yet.</td>
                    </tr>
                  ) : recentActivity.map((log) => (
                    <tr key={log.id}>
                      <td>{formatRelativeTime(log.created_at)}</td>
                      <td>{log.event_type || '—'}</td>
                      <td>
                        <span className={`status-badge ${getStatusBadgeClass(log.status)}`}>{log.status || '—'}</span>
                      </td>
                      <td>{log.message || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
            </>
          ) : null}

          {activePage === 'syncLog' ? (
            <section className="section-card">
              <div className="section-header">
                <h3 className="section-title">Order Import & Sync Log</h3>
                <button className="btn-action" onClick={loadLogs}>
                  {logsLoading ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
              
              <div style={{ marginBottom: '20px', padding: '14px', background: 'rgba(79, 172, 254, 0.08)', borderLeft: '4px solid #4facfe', borderRadius: '8px', fontSize: '13px', color: '#0f172a', lineHeight: '1.5' }}>
                <p style={{ margin: '0 0 8px 0', fontWeight: '600' }}>💡 How Order Import Works</p>
                <p style={{ margin: '0' }}>
                  Paid orders from Shopify are automatically imported into QuickBooks. If QB isn't connected, orders are saved as "pending" and will sync once you connect QB in Settings. Use the search below to look up orders by their Shopify ID.
                </p>
                <p style={{ margin: '8px 0 0 0' }}>
                  {demoMode ? 'Preview mode includes a large sample invoice history and refreshes automatically every 5 minutes.' : 'Orders sync automatically and the dashboard refreshes every 5 minutes.'}
                </p>
              </div>
              
              {/* Search Section */}
              <div className="search-section">
                <h4 style={{ fontSize: '15px', fontWeight: '600', marginBottom: '12px', color: '#0f172a' }}>Find Order by Shopify #</h4>
                <div className="search-box">
                  <input 
                    type="text" 
                    className="search-input" 
                    placeholder="Enter Shopify Order ID (e.g., 1234567890)" 
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                  />
                  <button className="btn-search" onClick={handleSearch}>Search</button>
                </div>
                {searchResult && (
                  <div className="search-result">
                    {searchResult.error ? (
                      <div className="search-error">{searchResult.error}</div>
                    ) : (
                      <div className="search-success">
                        <strong>✓ Found:</strong> Shopify Order #{searchResult.shopifyOrderId || searchResult.shopifyOrderName} → QB Invoice #{searchResult.qboInvoiceId || '(pending)'}
                        <br />
                        <span style={{ fontSize: '12px', color: '#64748b', marginTop: '4px', display: 'block' }}>Status: <strong>{searchResult.syncStatus}</strong></span>
                      </div>
                    )}
                  </div>
                )}
              </div>
              
              <h4 style={{ fontSize: '14px', fontWeight: '600', marginTop: '24px', marginBottom: '12px', color: '#0f172a' }}>Recent Activity</h4>
              <div className="table-container">
                <table className="sync-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Event</th>
                      <th>Status</th>
                      <th>Shop</th>
                      <th>Shopify Order #</th>
                      <th>QB Invoice #</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.length === 0 ? (
                      <tr>
                        <td colSpan="7">{logsLoading ? 'Loading logs...' : 'No log records found yet.'}</td>
                      </tr>
                    ) : (
                      logs.slice(0, 50).map((log) => (
                        <tr key={log.id}>
                          <td>{formatLogTime(log.created_at)}</td>
                          <td>{log.event_type || '—'}</td>
                          <td>
                            <span
                              className={`status-badge ${getStatusBadgeClass(log.status)}`}
                            >
                              {log.status || '—'}
                            </span>
                          </td>
                          <td>{log.shop_domain || '—'}</td>
                          <td className="order-id">{log.shopify_order_id || '—'}</td>
                          <td className="invoice-id">{log.qbo_invoice_id || '—'}</td>
                          <td>{log.message || '—'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {activePage === 'settings' ? (
            <>
              <section className="section-card settings-tabs-card">
                <div className="settings-tabs">
                  <button
                    className={`settings-tab ${settingsTab === 'general' ? 'active' : ''}`}
                    onClick={() => setSettingsTab('general')}
                  >
                    General
                  </button>
                  <button
                    className={`settings-tab ${settingsTab === 'eula' ? 'active' : ''}`}
                    onClick={() => setSettingsTab('eula')}
                  >
                    License & EULA
                  </button>
                  <button
                    className={`settings-tab ${settingsTab === 'privacy' ? 'active' : ''}`}
                    onClick={() => setSettingsTab('privacy')}
                  >
                    Privacy Policy
                  </button>
                </div>
              </section>

              {settingsTab === 'general' ? (
                <>
                  <section className="section-card">
                    <h3 className="section-title">Plan Information</h3>
                    <div className="settings-list">
                      <div><strong>Plan:</strong> {planData.plan.name}</div>
                      <div><strong>Monthly usage:</strong> {usedOrdersThisMonth}{monthlyLimit == null ? ' / unlimited' : ` / ${monthlyLimit}`}</div>
                      <div><strong>Multi-store:</strong> {planData.plan.supportsMultiStore ? 'Enabled' : 'Starter limitation (1 store)'}</div>
                      <div><strong>Mode:</strong> {demoMode ? 'Preview data before install' : 'Live merchant data'}</div>
                    </div>
                  </section>

                  <section className="section-card">
                    <h3 className="section-title">Shopify Connection</h3>
                    <div className="settings-form">
                      <div className={`connected-status-badge ${settings.shopifyConnected ? 'connected' : 'not-connected'}`}>
                        <span className="connected-status-icon">{settings.shopifyConnected ? '✓' : '○'}</span>
                        <div>
                          <div className="connected-status-label">{settings.shopifyConnected ? 'Connected to Shopify' : 'Not connected'}</div>
                          <div className="connected-status-sub">
                            {demoMode
                              ? 'Demo mode — install the app on Shopify to connect your store'
                              : settings.shopifyConnected
                                ? `Store: ${settings.shopifyDomain || 'your Shopify store'}`
                                : 'Install Order2Books from the Shopify App Store to connect automatically'}
                          </div>
                        </div>
                      </div>
                      <p className="form-hint" style={{ marginTop: '12px' }}>Your Shopify store connects automatically when you install the app — no manual setup needed.</p>
                    </div>
                  </section>

                  <section className="section-card">
                    <h3 className="section-title">QuickBooks Connection</h3>
                    <div className="settings-form">
                      <p className="form-hint">Connect your QuickBooks Online account to sync invoices.</p>
                      <button
                        className="btn-oauth"
                        disabled={demoMode}
                        onClick={() => window.location.href = '/api/auth/qbo/start'}
                      >
                        {demoMode ? 'Install app to connect QuickBooks' : settings.qboConnected ? '✓ Connected to QuickBooks' : '🔗 Connect QuickBooks Online'}
                      </button>
                    </div>
                  </section>

                  <section className="section-card">
                    <h3 className="section-title">Sync Options</h3>
                    <div className="settings-form">
                      <div className="form-group">
                        <label htmlFor="captureMode">Shopify payment capture mode</label>
                        <select
                          id="captureMode"
                          className="form-input"
                          disabled={demoMode}
                          value={settings.captureMode}
                          onChange={(e) => setSettings({ ...settings, captureMode: e.target.value })}
                        >
                          <option value="auto">Auto capture payments</option>
                          <option value="manual">Manual capture payments</option>
                        </select>
                        <p className="form-hint">Manual capture mode keeps authorized orders pending until payment is captured in Shopify.</p>
                      </div>

                      <div className="form-checkbox">
                        <input
                          id="autoCreateQboItems"
                          type="checkbox"
                          checked={settings.autoCreateQboItems}
                          disabled={demoMode}
                          onChange={(e) => setSettings({ ...settings, autoCreateQboItems: e.target.checked })}
                        />
                        <label htmlFor="autoCreateQboItems">Automatically create new QuickBooks items for unmatched Shopify products</label>
                      </div>
                      <p className="form-hint">Recommended. The app matches by SKU first, then name, and only falls back when creation is unavailable.</p>

                      <div className="form-checkbox">
                        <input
                          id="autoDecrement"
                          type="checkbox"
                          checked={settings.autoDecrementInventory}
                          disabled={demoMode}
                          onChange={(e) => setSettings({ ...settings, autoDecrementInventory: e.target.checked })}
                        />
                        <label htmlFor="autoDecrement">Automatically decrement inventory in QuickBooks when order is synced</label>
                      </div>
                      <p className="form-hint">⚠️ When enabled, product quantities will be reduced in QuickBooks inventory after each successful sync.</p>
                    </div>
                  </section>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                    <button className="btn-secondary-dark" onClick={loadSettings}>Reset</button>
                    <button className="btn-primary" onClick={saveSettings} disabled={demoMode}>Save Settings</button>
                  </div>
                </>
              ) : null}

              {settingsTab === 'eula' ? (
                <section className="section-card">
                  <h3 className="section-title">License & EULA</h3>
                  <div className="legal-content">
                    <p><strong>Last Updated:</strong> March 9, 2026</p>
                    <p>This End User License Agreement ("Agreement") governs use of Order2Books ("App") provided by Order2Books ("Company", "we", "our", or "us"). By installing or using the App, you agree to this Agreement.</p>

                    <h4>1. License</h4>
                    <p>We grant you a limited, non-exclusive, non-transferable, revocable license to use the App solely to synchronize order and invoice data between Shopify and QuickBooks Online.</p>
                    <p>You may not reverse engineer, modify, redistribute, or use the App in violation of applicable laws.</p>

                    <h4>2. Third-Party Services</h4>
                    <p>The App integrates with Shopify and QuickBooks Online. Your use of those services is governed by their own terms and policies. We are not responsible for third-party service availability or operation.</p>

                    <h4>3. Data Synchronization</h4>
                    <p>Synchronization may not occur instantly. Network delays, API limitations, and service interruptions may affect sync timing.</p>

                    <h4>4. QuickBooks Changes and Timing</h4>
                    <p>Changes made directly within QuickBooks Online may not immediately appear in the App and may take up to 24 hours to reflect.</p>
                    <p>The Company is not responsible for discrepancies, delays, or differences in data visibility during this synchronization window.</p>

                    <h4>5. Disclaimer of Warranties</h4>
                    <p>The App is provided "as is" without warranties of any kind. We do not guarantee uninterrupted operation, immediate synchronization, or perfect data matching across systems at all times.</p>

                    <h4>6. Limitation of Liability</h4>
                    <p>To the maximum extent permitted by law, the Company shall not be liable for financial discrepancies, data delays, accounting errors, or indirect and consequential damages arising from use of the App.</p>

                    <h4>7. Termination</h4>
                    <p>We may suspend or terminate access if this Agreement is violated, the App is misused, or required integrations are disconnected.</p>

                    <h4>8. Changes to Agreement</h4>
                    <p>We may update this Agreement at any time. Continued use of the App means you accept the updated terms.</p>

                    <h4>9. Contact</h4>
                    <p>Order2Books<br />kadie@olympic-equipment.com</p>
                  </div>
                </section>
              ) : null}

              {settingsTab === 'privacy' ? (
                <section className="section-card">
                  <h3 className="section-title">Privacy Policy</h3>
                  <div className="legal-content">
                    <p><strong>Last Updated:</strong> March 9, 2026</p>
                    <p>Order2Books ("we", "our", "us") respects your privacy. This Policy explains how information is collected and used when you install and use the App.</p>

                    <h4>1. Information We Collect</h4>
                    <p>We collect only information necessary to operate synchronization services, including Shopify store domain, required Shopify order data, required QuickBooks customer/invoice data, and app configuration settings.</p>

                    <h4>2. How We Use Information</h4>
                    <p>Collected data is used only to synchronize Shopify and QuickBooks data, maintain integration connections, and provide technical support.</p>

                    <h4>3. Data Storage</h4>
                    <p>Data may be temporarily stored to process synchronization tasks. We do not sell or rent merchant data.</p>

                    <h4>4. Third-Party Services</h4>
                    <p>The App integrates with Shopify and QuickBooks Online, which operate under their own privacy policies.</p>

                    <h4>5. Data Security</h4>
                    <p>We implement reasonable security measures to protect data used by the App; however, no transmission or storage system can be guaranteed 100% secure.</p>

                    <h4>6. Data Retention</h4>
                    <p>We retain data only as long as necessary to provide synchronization services and comply with legal obligations.</p>

                    <h4>7. User Responsibilities</h4>
                    <p>Users remain responsible for reviewing accounting records in QuickBooks and Shopify. Changes made directly in QuickBooks may take up to 24 hours to appear in the App.</p>

                    <h4>8. Changes to This Policy</h4>
                    <p>We may update this Policy periodically. Updates are posted with a revised "Last Updated" date.</p>

                    <h4>9. Contact</h4>
                    <p>Order2Books<br />kadie@olympic-equipment.com</p>
                  </div>
                </section>
              ) : null}
            </>
          ) : null}

          {activePage === 'mapping' ? (
            <>
              <section className="section-card">
                <div className="section-header">
                  <h3 className="section-title">Auto Mapped Items</h3>
                  <button className="btn-action" onClick={runMappingScan} disabled={scanBusy}>
                    {scanBusy ? 'Scanning...' : 'Run Scan'}
                  </button>
                </div>
                <div className="table-container">
                  <table className="sync-table">
                    <thead>
                      <tr>
                        <th>Shopify Product</th>
                        <th>SKU</th>
                        <th>QuickBooks Item</th>
                        <th>Source</th>
                        <th>Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mappings.autoMapped.length === 0 ? (
                        <tr>
                          <td colSpan="5">{mappingsLoading ? 'Loading mapped items...' : 'No mapped items yet.'}</td>
                        </tr>
                      ) : mappings.autoMapped.map((mapping) => (
                        <tr key={mapping.id}>
                          <td>{mapping.shopifyTitle}</td>
                          <td>{mapping.shopifySku || '—'}</td>
                          <td>{mapping.qboItemName || '—'} {mapping.qboItemId ? `(#${mapping.qboItemId})` : ''}</td>
                          <td>{mapping.mappingSource || '—'}</td>
                          <td>{formatLogTime(mapping.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="section-card">
                <h3 className="section-title">Items Needing Attention</h3>
                <div className="table-container">
                  <table className="sync-table">
                    <thead>
                      <tr>
                        <th>Shopify Product</th>
                        <th>SKU</th>
                        <th>Select QuickBooks Item</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mappings.needsAttention.length === 0 ? (
                        <tr>
                          <td colSpan="4">{mappingsLoading ? 'Loading items...' : 'No items need attention.'}</td>
                        </tr>
                      ) : mappings.needsAttention.map((mapping) => (
                        <tr key={mapping.id}>
                          <td>{mapping.shopifyTitle}</td>
                          <td>{mapping.shopifySku || '—'}</td>
                          <td colSpan="2" style={{ position: 'relative' }}>
                            <div style={{ position: 'relative' }}>
                              <input
                                className="form-input"
                                style={{ width: '100%', minWidth: '250px' }}
                                placeholder="Search QuickBooks items..."
                                value={mappingItemSearch[mapping.id] ?? ''}
                                onChange={(e) => searchQboItems(mapping.id, e.target.value)}
                              />
                              {mappingItemSearchResults[mapping.id]?.length > 0 && (
                                <div style={{
                                  position: 'absolute', top: '100%', left: 0, right: 0, 
                                  background: 'white', border: '1px solid #ddd', 
                                  borderRadius: '4px', zIndex: 1000, maxHeight: '200px', 
                                  overflowY: 'auto', marginTop: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
                                }}>
                                  {mappingItemSearchResults[mapping.id].map((item) => (
                                    <div
                                      key={item.id}
                                      onClick={() => selectQboItem(mapping.id, item)}
                                      style={{
                                        padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #eee',
                                        hover: { background: '#f5f5f5' }
                                      }}
                                      onMouseEnter={(e) => e.target.style.background = '#f5f5f5'}
                                      onMouseLeave={(e) => e.target.style.background = 'transparent'}
                                    >
                                      <strong>{item.name}</strong>
                                      {item.sku && <span style={{ color: '#999', marginLeft: '8px', fontSize: '12px' }}>({item.sku})</span>}
                                      <div style={{ fontSize: '11px', color: '#999' }}>ID: {item.id}</div>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {mappingEdits[mapping.id]?.qboItemId && (
                                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                                  Selected: <strong>{mappingEdits[mapping.id]?.qboItemName}</strong> (#{mappingEdits[mapping.id]?.qboItemId})
                                </div>
                              )}
                            </div>
                          </td>
                          <td>
                            <button 
                              className="btn-action" 
                              onClick={() => saveMapping(mapping.id)}
                              disabled={!mappingEdits[mapping.id]?.qboItemId}
                            >
                              Save
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : null}

          {activePage === 'help' ? (
            <section className="section-card">
              <h3 className="section-title">Support</h3>
              <div className="settings-list">
                <div><strong>Email support:</strong> support@orderbooks.app</div>
                <div><strong>Webhook status:</strong> Verify Shopify `orders/paid` delivery in your admin panel.</div>
                <div><strong>Quick action:</strong> Use `Sync Log` page to inspect failed events and retry queues.</div>
              </div>
            </section>
          ) : null}
        </main>
      </div>

        {tutorialActive && TUTORIAL_STEPS[tutorialStep] && (
          <div className="tutorial-overlay">
            <div className="tutorial-backdrop"></div>
            <div className="tutorial-card" onClick={(e) => e.stopPropagation()}>
              <div className="tutorial-header">
                <div className="tutorial-step-tag">Step {tutorialStep + 1} of {TUTORIAL_STEPS.length}</div>
                <button className="tutorial-close" onClick={skipTutorial}>✕</button>
              </div>
              <h3 className="tutorial-title">{TUTORIAL_STEPS[tutorialStep].title}</h3>
              <p className="tutorial-description">{TUTORIAL_STEPS[tutorialStep].description}</p>
              <div className="tutorial-footer">
                <div className="tutorial-progress">
                  {TUTORIAL_STEPS.map((_, idx) => (
                    <div
                      key={idx}
                      className={`tutorial-dot ${idx === tutorialStep ? 'active' : ''} ${idx < tutorialStep ? 'completed' : ''}`}
                    />
                  ))}
                </div>
                <div className="tutorial-actions">
                  <button className="btn-text" onClick={skipTutorial}>Skip</button>
                  <button className="btn-action" onClick={nextTutorialStep}>
                    {tutorialStep === TUTORIAL_STEPS.length - 1 ? 'Finish' : 'Next →'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

      {showUpgradePanel ? (
        <div className="upgrade-modal-backdrop" onClick={() => setShowUpgradePanel(false)}>
          <section className="upgrade-modal" onClick={(event) => event.stopPropagation()}>
            <div className="upgrade-modal-header">
              <h3 className="section-title">Upgrade Plans</h3>
              <button className="btn-modal-close" onClick={() => setShowUpgradePanel(false)}>✕</button>
            </div>
            <div className="plans-grid">
              {planData.plans.map((plan) => (
                <article
                  key={plan.key}
                  className={`plan-card ${planData.plan.key === plan.key ? 'plan-card-active' : ''}`}
                >
                  <div className="plan-header-row">
                    <h4 className="plan-name">{plan.name}</h4>
                    {planData.plan.key === plan.key ? <span className="plan-badge">Current</span> : null}
                  </div>
                  <div className="plan-price">${plan.priceMonthly} <span>/ month</span></div>
                  <ul className="plan-features">
                    {plan.features.map((feature) => (
                      <li key={feature}>{feature}</li>
                    ))}
                  </ul>
                  {planData.plan.key !== plan.key ? (
                    <button
                      className="btn-plan-upgrade"
                      onClick={() => handleUpgrade(plan.key)}
                      disabled={upgradeBusy === plan.key}
                    >
                      {upgradeBusy === plan.key ? 'Upgrading...' : `Upgrade to ${plan.name}`}
                    </button>
                  ) : null}
                </article>
              ))}
            </div>
            <div className="plan-usage-row">
              <span>Current plan: <strong>{planData.plan.name}</strong></span>
              <span>
                Monthly usage: <strong>{usedOrdersThisMonth}</strong>
                {monthlyLimit == null
                  ? ' / unlimited orders'
                  : ` / ${monthlyLimit} orders`}
              </span>
            </div>
            {upgradeMessage ? <div className="upgrade-message">{upgradeMessage}</div> : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}

export default App;
