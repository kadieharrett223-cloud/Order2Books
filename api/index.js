// Serverless function handler for Vercel
// Vercel will call this for all requests to /api/*
const app = require('../server');

// Initialize migrations on first request
let migrationsInitialized = false;

const handler = async (req, res) => {
  if (!migrationsInitialized) {
    try {
      const { migrate } = require('../db');
      await migrate();
      migrationsInitialized = true;
    } catch (error) {
      console.error('Migration error:', error);
      return res.status(500).json({
        error: 'Server initialization failed',
        detail: process.env.NODE_ENV === 'production' ? undefined : String(error?.message || error),
      });
    }
  }

  // Call the Express app
  return app(req, res);
};

module.exports = handler;
