/* QAVENO — Production Configuration
   Set the production API URL and update server. */

'use strict';

const path = require('path');
const os = require('os');

// Production API base URL
const PRODUCTION_API = 'https://api.qaveno.com';

// Auto-update server (GitHub Releases)
const UPDATE_SERVER = 'https://github.com/qaveno/qaveno-desktop';

// Get API URL based on environment
function getApiBase() {
  // In production builds, always use the production API
  if (process.env.NODE_ENV === 'production') {
    return PRODUCTION_API;
  }
  // In development, use localhost
  return 'http://localhost:3000';
}

// Get update config
function getUpdateConfig() {
  return {
    provider: 'github',
    owner: 'qaveno',
    repo: 'qaveno-desktop',
    channel: 'latest',
  };
}

// Database path (user data directory)
function getDbPath(appDataPath) {
  return path.join(appDataPath, 'data', 'pos.db');
}

// License file path
function getLicensePath(appDataPath) {
  return path.join(appDataPath, 'license.json');
}

module.exports = {
  PRODUCTION_API,
  UPDATE_SERVER,
  getApiBase,
  getUpdateConfig,
  getDbPath,
  getLicensePath,
};
