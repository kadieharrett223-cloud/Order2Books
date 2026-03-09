// Serverless function handler for Vercel
// Vercel will call this for all requests to /api/*
// Initialize migrations on first request
let migrationsInitialized = false;
let appInstance = null;

const handler = async (req, res) => {
  if (!appInstance) {
    try {
      appInstance = require('../server');
    } catch (error) {
      console.error('Server bootstrap error:', error);
      return res.status(500).json({
        error: 'Server bootstrap failed',
        detail: process.env.NODE_ENV === 'production' ? undefined : String(error?.stack || error?.message || error),
      });
    }
  }

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
  return appInstance(req, res);
};

module.exports = handler;
