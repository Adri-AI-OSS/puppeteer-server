#!/usr/bin/env node

/**
 * Puppeteer Server CLI
 *
 * Launches a browser for authentication and starts an HTTP server
 * that accepts code execution requests.
 *
 * Usage:
 *   node index.js [options]
 *
 * Options:
 *   --port, -p       Server port (default: 3000)
 *   --url, -u        Initial URL to open (default: none)
 *   --headless       Run in headless mode (default: false)
 *   --profile, -d    Chrome profile directory (default: .chrome-profile)
 *   --pool           Enable tab pool for concurrent execution
 *   --max-tabs       Maximum tabs in pool (default: 10)
 *
 * Examples:
 *   node index.js
 *   node index.js --port 8080 --url https://api.sap.com
 *   node index.js --pool --max-tabs 5
 */

const readline = require('readline');
const BrowserManager = require('./lib/browser');
const CodeExecutor = require('./lib/executor');
const TabPoolManager = require('./lib/tab-pool');
const Server = require('./lib/server');

// Parse command line arguments
function parseArgs(args) {
    const options = {
        port: 3000,
        url: null,
        headless: false,
        profileDir: '.chrome-profile',
        enablePool: false,
        maxTabs: 10,
        noPrompt: false  // Skip "Press ENTER" prompt for autonomous operation
    };

    const positional = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];

        switch (arg) {
            case '--port':
            case '-p':
                options.port = parseInt(next) || 3000;
                i++;
                break;
            case '--url':
            case '-u':
                options.url = next;
                i++;
                break;
            case '--headless':
                options.headless = true;
                break;
            case '--profile':
            case '-d':
                options.profileDir = next;
                i++;
                break;
            case '--pool':
                options.enablePool = true;
                break;
            case '--max-tabs':
                options.maxTabs = parseInt(next) || 10;
                i++;
                break;
            case '--no-prompt':
                options.noPrompt = true;
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
            default:
                // Collect positional arguments
                if (!arg.startsWith('-')) {
                    positional.push(arg);
                }
        }
    }

    // Handle positional arguments: [port] [url]
    // Support: node index.js 8080 https://example.com
    for (const arg of positional) {
        if (/^\d+$/.test(arg)) {
            options.port = parseInt(arg);
        } else if (arg.startsWith('http://') || arg.startsWith('https://')) {
            options.url = arg;
        }
    }

    return options;
}

function printHelp() {
    console.log(`
Puppeteer Server - HTTP server for executing Puppeteer code

Usage:
  node index.js [options]

Options:
  --port, -p <port>      Server port (default: 3000)
  --url, -u <url>        Initial URL to open in browser
  --headless             Run browser in headless mode
  --profile, -d <dir>    Chrome profile directory (default: .chrome-profile)
  --pool                 Enable tab pool for concurrent execution
  --max-tabs <n>         Maximum tabs in pool (default: 10)
  --no-prompt            Skip "Press ENTER" prompt (for autonomous/CI use)
  --help, -h             Show this help message

Examples:
  node index.js
  node index.js --port 8080 --url https://api.sap.com
  node index.js --pool --max-tabs 5

API Endpoints (Legacy - Sequential):
  POST /execute          Execute code and return full result
  POST /run              Execute code and return raw result
  POST /goto             Navigate to URL
  GET  /page             Get current page URL and title
  GET  /content          Get page HTML content
  GET  /screenshot       Take screenshot (PNG)
  GET  /cookies          Get page cookies
  GET  /status           Get queue status
  POST /clear-queue      Clear pending executions
  POST /shutdown         Shutdown server and browser
  GET  /health           Health check

API Endpoints (Pool - Concurrent):
  POST /pool/execute             Execute with auto tab management
  POST /pool/acquire             Acquire a tab manually
  POST /pool/release/:tabId      Release a tab back to pool
  POST /pool/tab/:tabId/execute  Execute on specific tab
  DELETE /pool/tab/:tabId        Close a specific tab
  GET  /pool/status              Get pool status
  GET  /pool/tabs                Get all tabs info
  POST /pool/close-all           Close all tabs
  POST /pool/prune               Prune idle tabs

Example curl commands:
  # Legacy (sequential)
  curl -X POST http://localhost:3000/run \\
    -H "Content-Type: application/json" \\
    -d '{"code": "return await page.title()"}'

  # Pool (concurrent)
  curl -X POST http://localhost:3000/pool/execute \\
    -H "Content-Type: application/json" \\
    -d '{"code": "await page.goto(\\"https://example.com\\"); return page.url();"}'
`);
}

function askQuestion(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer);
        });
    });
}

async function main() {
    const args = process.argv.slice(2);
    const options = parseArgs(args);

    console.log('='.repeat(60));
    console.log('  Puppeteer Server');
    console.log('='.repeat(60));
    console.log();

    // Initialize components
    console.log('Initializing browser manager...');
    const browserManager = new BrowserManager({
        headless: options.headless,
        profileDir: options.profileDir
    });

    // Initialize tab pool if enabled
    let tabPoolManager = null;
    if (options.enablePool) {
        console.log(`Initializing tab pool (max ${options.maxTabs} tabs)...`);
        tabPoolManager = new TabPoolManager(browserManager, {
            maxTabs: options.maxTabs
        });
    }

    const executor = new CodeExecutor(browserManager, tabPoolManager);
    const server = new Server(executor, browserManager, {
        port: options.port,
        tabPoolManager
    });

    // Launch browser
    console.log('Launching browser...');
    await browserManager.launch();

    // Navigate to initial URL if provided
    const page = await browserManager.getPage('main');
    if (options.url) {
        console.log(`Navigating to ${options.url}...`);
        await page.goto(options.url, { waitUntil: 'networkidle2', timeout: 60000 });
    }

    // Wait for user to login (unless --no-prompt is set)
    if (!options.noPrompt) {
        console.log();
        console.log('-'.repeat(60));
        console.log('Browser is open. Please log in if authentication is required.');
        console.log('-'.repeat(60));
        await askQuestion('Press ENTER when ready to start the server...');
    } else {
        console.log();
        console.log('--no-prompt mode: Starting server immediately...');
    }

    // Start server
    console.log();
    await server.start();

    console.log();
    console.log('='.repeat(60));
    console.log('  Server is running!');
    console.log('='.repeat(60));
    console.log();
    console.log('Legacy Endpoints (Sequential):');
    console.log(`  POST http://localhost:${options.port}/execute  - Execute code (full response)`);
    console.log(`  POST http://localhost:${options.port}/run      - Execute code (raw result)`);
    console.log(`  POST http://localhost:${options.port}/goto     - Navigate to URL`);
    console.log(`  GET  http://localhost:${options.port}/page     - Get current page info`);

    if (options.enablePool) {
        console.log();
        console.log('Pool Endpoints (Concurrent):');
        console.log(`  POST http://localhost:${options.port}/pool/execute     - Execute with auto tab`);
        console.log(`  POST http://localhost:${options.port}/pool/acquire     - Acquire a tab`);
        console.log(`  POST http://localhost:${options.port}/pool/release/:id - Release a tab`);
        console.log(`  GET  http://localhost:${options.port}/pool/status      - Pool status`);
    }

    console.log();
    console.log('Example:');
    console.log(`  curl -X POST http://localhost:${options.port}/run \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"code": "return await page.title()"}'`);
    console.log();
    console.log('Press Ctrl+C to stop the server');
    console.log();

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\nShutting down...');
        await server.stop();
    });

    process.on('SIGTERM', async () => {
        console.log('\nShutting down...');
        await server.stop();
    });
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
