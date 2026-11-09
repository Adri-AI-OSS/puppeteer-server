/**
 * Puppeteer Server Library
 *
 * Export all modules for programmatic usage.
 */

const BrowserManager = require('./browser');
const CodeExecutor = require('./executor');
const Server = require('./server');
const { TabManager } = require('./tabs');

module.exports = {
    BrowserManager,
    CodeExecutor,
    Server,
    TabManager
};
