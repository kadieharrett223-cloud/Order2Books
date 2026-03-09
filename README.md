# Order2Books

A modern SaaS dashboard for syncing Shopify orders to QuickBooks Online automatically.

## Features

✨ **Automatic Order Sync**
- Real-time order import from Shopify to QuickBooks
- Automatic invoice and payment creation
- Order tracking with search functionality

🔐 **Plan-Based Pricing**
- Starter Plan: $9.99/month (200 orders/month)
- Scale Plan: $29/month (unlimited orders + multi-store)

⚙️ **Flexible Settings**
- Manual Shopify & QuickBooks connections
- Auto-decrement inventory option
- Order search by Shopify ID
- Detailed sync logs and activity tracking

🎨 **Modern UI**
- Gradient design with frosted glass effects
- Real-time sync health metrics
- Responsive dashboard

## Tech Stack

- **Frontend**: React + Vite
- **Backend**: Express.js
- **Database**: SQLite
- **Auth**: Shopify OAuth + QuickBooks OAuth

## Getting Started

### Prerequisites
- Node.js 18+
- npm or yarn
- Shopify App (for API credentials)
- QuickBooks Online account

### Installation

1. Clone the repository
```bash
git clone https://github.com/kadieharrett223-cloud/Order2Books.git
cd order2books
```

2. Install backend dependencies
```bash
npm install
```

3. Install frontend dependencies
```bash
cd frontend && npm install && cd ..
```

4. Create a `.env` file in the root directory
```env
PORT=4000
SHOPIFY_API_KEY=your_shopify_key
SHOPIFY_API_SECRET=your_shopify_secret
SHOPIFY_SCOPES=read_orders
QBO_CLIENT_ID=your_quickbooks_client_id
QBO_CLIENT_SECRET=your_quickbooks_client_secret
QBO_SCOPES=com.intuit.quickbooks.accounting
QBO_ENV=sandbox
STATE_SECRET=your_state_secret
```

5. Start the backend server
```bash
npm run dev
```

6. In another terminal, start the frontend dev server
```bash
cd frontend && npm run dev
```

The app will be available at `http://localhost:5174`

## Project Structure

```
order2books/
├── server.js                 # Express backend
├── db.js                     # Database setup
├── migrations/
│   └── 001_init.sql         # Database schema
├── frontend/
│   ├── src/
│   │   ├── App.jsx          # Main React component
│   │   └── App.css          # Styles
│   └── vite.config.js
├── package.json
└── .env                      # Environment variables
```

## API Endpoints

### Plan Management
- `GET /api/plan` - Get current plan and usage
- `POST /api/plan/upgrade` - Upgrade plan

### Order Sync
- `GET /api/syncs` - List all syncs
- `GET /api/syncs/:shopifyOrderId` - Get specific sync
- `POST /api/syncs/:shopifyOrderId/retry` - Retry failed sync
- `GET /api/logs` - Get sync logs

### Settings
- `GET /api/settings` - Get app settings
- `POST /api/settings` - Save app settings

### Webhooks
- `POST /api/webhooks/shopify/orders-paid` - Shopify order paid webhook
- `POST /api/webhooks/shopify/refunds-create` - Shopify refund webhook

## Configuration

### Shopify Setup
1. Go to Shopify Admin → Settings → Apps and integrations → Develop apps
2. Create a new app called "Order2Books"
3. Under "Admin API scopes", enable:
   - `read_orders`
   - `read_products`
4. Set webhook delivery URL to: `https://yourapp.com/api/webhooks/shopify/orders-paid`
5. Copy your API credentials to `.env`

### QuickBooks Setup
1. Go to https://developer.intuit.com/
2. Create an app and get your Client ID and Secret
3. Add redirect URI: `http://localhost:4000/api/auth/qbo/callback`
4. Copy credentials to `.env`

## Building for Production

Frontend:
```bash
cd frontend && npm run build
```

## License

MIT

## Support

Email: support@orderbooks.app
