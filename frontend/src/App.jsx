import { useEffect, useState } from 'react';
import './App.css';

function App() {
  const [activePage, setActivePage] = useState('dashboard');
  const [settingsTab, setSettingsTab] = useState('general');
  const [showUpgradePanel, setShowUpgradePanel] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState('');
  const [upgradeMessage, setUpgradeMessage] = useState('');
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState(null);
  const [settings, setSettings] = useState({
    shopifyDomain: '',
    shopifyApiKey: '',
    qboConnected: false,
    autoDecrementInventory: false,
  });
  const [planData, setPlanData] = useState({
    plan: {
      key: 'starter',
      name: 'Starter',
      priceMonthly: 9.99,
      orderLimitPerMonth: 200,
      usedOrdersThisMonth: 0,
      remainingOrdersThisMonth: 200,
      supportsMultiStore: false,
      features: [
        'Up to 200 orders / month',
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
        orderLimitPerMonth: 200,
        features: [
          'Up to 200 orders / month',
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
  });

  useEffect(() => {
    const loadPlan = async () => {
      try {
        const response = await fetch('/api/plan');
        if (!response.ok) return;
        const data = await response.json();
        setPlanData(data);
      } catch {
      }
    };

    loadPlan();
  }, []);

  const refreshPlan = async () => {
    const response = await fetch('/api/plan');
    if (!response.ok) return;
    const data = await response.json();
    setPlanData(data);
  };

  const loadLogs = async () => {
    setLogsLoading(true);
    try {
      const response = await fetch('/api/logs');
      if (!response.ok) return;
      const data = await response.json();
      setLogs(Array.isArray(data.logs) ? data.logs : []);
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
      const response = await fetch(`/api/syncs/${encodeURIComponent(searchQuery.trim())}`);
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
      const response = await fetch('/api/settings');
      if (!response.ok) return;
      const data = await response.json();
      setSettings(data.settings || settings);
    } catch {
    }
  };

  const saveSettings = async () => {
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (response.ok) {
        alert('Settings saved successfully!');
      }
    } catch {
      alert('Failed to save settings');
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const handleUpgrade = async (planKey) => {
    setUpgradeMessage('');
    setUpgradeBusy(planKey);
    try {
      const response = await fetch('/api/plan/upgrade', {
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
  const showUpgradeWarning = monthlyLimit != null && usageRatio >= 0.8;

  return (
    <div className="app">
      {/* Top Header */}
      <header className="top-header">
        <div className="header-left">
          <div className="logo-icon">📘</div>
          <h1 className="app-title">OrderBooks <span className="title-light">Dashboard</span></h1>
        </div>
        <div className="header-actions">
          <button className="btn-secondary">
            🔄 Retry ▼
          </button>
          <button className="btn-secondary">
            🔵 Refresh
          </button>
          <button
            className={`btn-upgrade ${showUpgradeWarning ? 'btn-upgrade-warning' : ''}`}
            onClick={() => setShowUpgradePanel((value) => !value)}
          >
            ⬆ Upgrade
          </button>
          <button className="btn-primary">Connect</button>
        </div>
      </header>

      <div className="main-layout">
        {/* Sidebar */}
        <aside className="sidebar">
          <nav className="sidebar-nav">
            <button className={`nav-item ${activePage === 'dashboard' ? 'active' : ''}`} onClick={() => setActivePage('dashboard')}>
              <span className="nav-icon">🏠</span>
              <span className="nav-label">Dashboard</span>
            </button>
            <button className={`nav-item ${activePage === 'syncLog' ? 'active' : ''}`} onClick={() => setActivePage('syncLog')}>
              <span className="nav-icon">📊</span>
              <span className="nav-label">Sync Log</span>
            </button>
            <button className={`nav-item ${activePage === 'settings' ? 'active' : ''}`} onClick={() => setActivePage('settings')}>
              <span className="nav-icon">⚙</span>
              <span className="nav-label">Settings</span>
            </button>
            <button className={`nav-item ${activePage === 'help' ? 'active' : ''}`} onClick={() => setActivePage('help')}>
              <span className="nav-icon">❓</span>
              <span className="nav-label">Help</span>
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
          <div className="page-header">
            <h2 className="page-title">
              {activePage === 'dashboard' && 'OrderBooks Dashboard'}
              {activePage === 'syncLog' && 'Sync Log'}
              {activePage === 'settings' && 'Settings'}
              {activePage === 'help' && 'Help'}
            </h2>
            <p className="page-subtitle">
              {activePage === 'dashboard' && 'Monitor sync health between Shopify and QuickBooks'}
              {activePage === 'syncLog' && 'Track sync events, webhook outcomes, and retry history'}
              {activePage === 'settings' && 'Manage plan, defaults, and integration preferences'}
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
              <div className="stat-number">1,280</div>
              <div className="stat-change positive">+110 today</div>
            </div>

            <div className="stat-card stat-card-green">
              <div className="stat-header">
                <div className="stat-icon">📄</div>
                <div className="stat-label">Invoices Created</div>
              </div>
              <div className="stat-number">1,279</div>
              <div className="stat-change positive">+112 today</div>
            </div>

            <div className="stat-card stat-card-red">
              <div className="stat-header">
                <div className="stat-icon">⚠</div>
                <div className="stat-label">Sync Errors</div>
              </div>
              <div className="stat-number">2</div>
              <div className="stat-change negative">2 errors</div>
            </div>

            <div className="stat-card stat-card-purple">
              <div className="stat-header">
                <div className="stat-icon">🕐</div>
                <div className="stat-label">Last Sync</div>
              </div>
              <div className="stat-number-small">15 min ago</div>
              <div className="stat-change">11° previous</div>
            </div>
          </div>

          {/* Connected Accounts Section */}
          <section className="section-card">
            <h3 className="section-title">Connected Accounts</h3>
            <div className="connected-accounts">
              <div className="account-card">
                <div className="account-logo shopify-logo">🛍️</div>
                <div className="account-info">
                  <div className="account-name">pri.myshopify.com</div>
                  <div className="account-status connected">✓ Connected</div>
                  <div className="account-meta">Last checked: 6 minutes ago</div>
                </div>
              </div>

              <div className="account-arrow">→</div>

              <div className="account-card">
                <div className="account-logo qb-logo">🟢</div>
                <div className="account-info">
                  <div className="account-name">QuickBooks Online</div>
                  <div className="account-status disconnected">✕ Disconnected</div>
                  <div className="account-meta">Last checked: 3 hours ago</div>
                </div>
                <button className="btn-connect">Connect</button>
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
                <strong className="health-value">17</strong>
              </div>
              <div className="health-pill">
                <span className="health-icon orange">⚠</span>
                <span className="health-label">Needs attention</span>
                <strong className="health-value">2</strong>
              </div>
              <div className="health-pill">
                <span className="health-icon red">⛔</span>
                <span className="health-label">Disconnected</span>
                <strong className="health-value">1</strong>
              </div>
              <div className="health-pill">
                <span className="health-icon gray">⏱</span>
                <span className="health-label">Avg sync time</span>
                <strong className="health-value">1m 5s</strong>
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
                  <tr>
                    <td>
                      <span className="order-id">#1034</span>
                      <span className="invoice-id-mini">#1014</span>
                    </td>
                    <td className="invoice-mapping">#1034 → #1014</td>
                    <td>
                      <span className="status-badge status-synced">Synced</span>
                    </td>
                    <td>15 minutes ago</td>
                    <td>
                      <button className="btn-action">Retry</button>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <span className="order-id">#1033</span>
                      <span className="invoice-id-mini">#1013</span>
                    </td>
                    <td className="invoice-mapping">#1033 → #1013</td>
                    <td>
                      <span className="status-badge status-retrying">Retrying</span>
                    </td>
                    <td>2 hours ago</td>
                    <td>
                      <button className="btn-action">Retry</button>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <span className="order-id">#1032</span>
                      <span className="invoice-id-mini">#1012</span>
                    </td>
                    <td className="invoice-mapping">#1032 → #1012</td>
                    <td>
                      <span className="status-badge status-failed">Failed</span>
                    </td>
                    <td>4 hours ago</td>
                    <td>
                      <button className="btn-action">Retry</button>
                    </td>
                  </tr>
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
                              className={`status-badge ${
                                log.status === 'success'
                                  ? 'status-synced'
                                  : log.status?.includes('fail')
                                    ? 'status-failed'
                                    : 'status-retrying'
                              }`}
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
                    </div>
                  </section>

                  <section className="section-card">
                    <h3 className="section-title">Shopify Connection</h3>
                    <div className="settings-form">
                      <div className="form-group">
                        <label htmlFor="shopifyDomain">Shop Domain</label>
                        <input
                          id="shopifyDomain"
                          type="text"
                          className="form-input"
                          placeholder="your-store.myshopify.com"
                          value={settings.shopifyDomain}
                          onChange={(e) => setSettings({ ...settings, shopifyDomain: e.target.value })}
                        />
                      </div>
                      <div className="form-group">
                        <label htmlFor="shopifyApiKey">API Access Token</label>
                        <input
                          id="shopifyApiKey"
                          type="password"
                          className="form-input"
                          placeholder="shpat_xxxxx"
                          value={settings.shopifyApiKey}
                          onChange={(e) => setSettings({ ...settings, shopifyApiKey: e.target.value })}
                        />
                      </div>
                      <p className="form-hint">💡 Get your API credentials from Shopify Admin → Settings → Apps and sales channels → Develop apps</p>
                    </div>
                  </section>

                  <section className="section-card">
                    <h3 className="section-title">QuickBooks Connection</h3>
                    <div className="settings-form">
                      <p className="form-hint">Connect your QuickBooks Online account to sync invoices.</p>
                      <button
                        className="btn-oauth"
                        onClick={() => window.location.href = '/api/auth/qbo/start'}
                      >
                        {settings.qboConnected ? '✓ Connected to QuickBooks' : '🔗 Connect QuickBooks Online'}
                      </button>
                    </div>
                  </section>

                  <section className="section-card">
                    <h3 className="section-title">Sync Options</h3>
                    <div className="settings-form">
                      <div className="form-checkbox">
                        <input
                          id="autoDecrement"
                          type="checkbox"
                          checked={settings.autoDecrementInventory}
                          onChange={(e) => setSettings({ ...settings, autoDecrementInventory: e.target.checked })}
                        />
                        <label htmlFor="autoDecrement">Automatically decrement inventory in QuickBooks when order is synced</label>
                      </div>
                      <p className="form-hint">⚠️ When enabled, product quantities will be reduced in QuickBooks inventory after each successful sync.</p>
                    </div>
                  </section>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                    <button className="btn-secondary-dark" onClick={loadSettings}>Reset</button>
                    <button className="btn-primary" onClick={saveSettings}>Save Settings</button>
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
