import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { MeridianbetTokenService } from './services/MeridianbetTokenService';
import { MeridianbetDataService } from './services/MeridianbetDataService';
import { MeridianbetLiveService } from './services/MeridianbetLiveService';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize services
const tokenService = new MeridianbetTokenService();
const dataService = new MeridianbetDataService(tokenService);
const liveService = new MeridianbetLiveService(tokenService);

// Set up live service callbacks
liveService.setDataCallback((data) => {
  console.log('Live data received:', data.type);
  broadcastToClients({
    type: 'live-data',
    payload: data,
    timestamp: new Date().toISOString()
  });
});

liveService.setErrorCallback((error) => {
  console.error('Live service error:', error);
  broadcastToClients({
    type: 'error',
    message: error.message,
    timestamp: new Date().toISOString()
  });
});

// Flag to track if server is ready
let serverReady = false;

// Extraction state management
let extractionState = {
  isRunning: false,
  mode: null as string | null,
  sport: null as string | null,
  interval: null as string | null,
  intervalId: null as NodeJS.Timeout | null,
  clients: new Set()
};

// Middleware to block requests until server is ready
app.use((req, res, next) => {
  if (!serverReady) {
    return res.status(503).json({
      error: 'Server is initializing, please wait...',
      message: 'Tokens are being loaded/fetched. Please try again in a moment.'
    });
  }
  next();
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Hardcoded password for authentication
const HARDCODED_PASSWORD = process.env.HARDCODED_PASSWORD || 'meridianbet2024';

// Authentication endpoint
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  
  if (!password) {
    return res.status(400).json({ error: 'Password is required' });
  }
  
  if (password === HARDCODED_PASSWORD) {
    res.json({ success: true, message: 'Login successful' });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Get access token endpoint
app.get('/api/token', async (req, res) => {
  try {
    console.log('Token request received');
    
    // Check if we have a valid token
    if (tokenService.isTokenValid()) {
      const tokenData = tokenService.getCurrentToken();
      console.log('Returning existing valid token');
      return res.json({
        success: true,
        token: tokenData?.accessToken,
        refreshToken: tokenData?.refreshToken,
        expiresAt: tokenData?.expiresAt,
        extractedAt: tokenData?.extractedAt
      });
    }

    // If no valid token, wait for refresh to complete
    console.log('No valid token found, waiting for refresh...');
    const tokenData = await tokenService.waitForTokenRefresh();
    
    res.json({
      success: true,
      token: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAt: tokenData.expiresAt,
      extractedAt: tokenData.extractedAt
    });

  } catch (error) {
    console.error('Error getting access token:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get access token',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    tokenValid: tokenService.isTokenValid()
  });
});

// Start extraction endpoint
app.post('/api/extraction/start', async (req, res) => {
  try {
    const { mode, sport, interval } = req.body;
    
    if (extractionState.isRunning) {
      return res.json({
        success: false,
        error: 'Extraction is already running'
      });
    }

    if (!mode || !sport) {
      return res.status(400).json({
        success: false,
        error: 'Mode and sport are required'
      });
    }

    console.log(`Starting ${mode} extraction for ${sport} with interval ${interval}`);
    
    // Set extraction state
    extractionState.isRunning = true;
    extractionState.mode = mode;
    extractionState.sport = sport;
    extractionState.interval = interval;

    // Define extraction function
    const runExtraction = async () => {
      try {
        console.log(`Running ${mode} extraction for ${sport}`);
        
        let result;
        if (mode === 'pregame') {
          const rawResult = await dataService.extractPreGameData(sport as 'football' | 'basketball' | 'tennis');
          
          // Convert Map to object for JSON serialization (same as in /api/pregame/extract)
          result = {
            ...rawResult,
            markets: Object.fromEntries(rawResult.markets)
          };
        } else if (mode === 'live') {
          // For live mode, start live service
          const sportId = getSportId(sport);
          await liveService.startLiveExtraction(sportId);
          result = { 
            message: 'Live extraction started',
            mode: 'live',
            sport: sport,
            sportId: sportId
          };
        } else {
          result = { message: 'Unknown mode' };
        }

        // Send data to all connected clients
        broadcastToClients({
          type: 'data',
          payload: result,
          timestamp: new Date().toISOString()
        });

      } catch (error) {
        console.error('Extraction error:', error);
        broadcastToClients({
          type: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        });
      }
    };

    // Run extraction immediately
    runExtraction();

    // Start periodic extraction only for pre-game mode
    // Live mode uses WebSocket for real-time updates, no need for periodic extraction
    if (mode === 'pregame') {
      const intervalMs = getIntervalMs(interval);
      extractionState.intervalId = setInterval(runExtraction, intervalMs);
    }

    res.json({
      success: true,
      message: `Started ${mode} extraction for ${sport}`
    });

  } catch (error) {
    console.error('Error starting extraction:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start extraction',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Stop extraction endpoint
app.post('/api/extraction/stop', async (req, res) => {
  try {
    if (!extractionState.isRunning) {
      return res.json({
        success: false,
        error: 'No extraction is currently running'
      });
    }

    console.log('Stopping extraction...');
    
    // Clear interval
    if (extractionState.intervalId) {
      clearInterval(extractionState.intervalId);
      extractionState.intervalId = null;
    }

    // Stop live service if running
    if (extractionState.mode === 'live') {
      liveService.stopLiveExtraction();
    }

    // Reset state
    extractionState.isRunning = false;
    extractionState.mode = null;
    extractionState.sport = null;
    extractionState.interval = null;

    // Notify clients
    broadcastToClients({
      type: 'status',
      message: 'Extraction stopped',
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      message: 'Extraction stopped'
    });

  } catch (error) {
    console.error('Error stopping extraction:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to stop extraction',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// SSE stream endpoint
app.get('/api/extraction/stream', (req, res) => {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  // Add client to the set
  const clientId = Date.now();
  extractionState.clients.add({ id: clientId, res });

  console.log(`SSE client connected: ${clientId}`);

  // Send initial status
  res.write(`data: ${JSON.stringify({
    type: 'status',
    message: extractionState.isRunning ? 'Extraction is running' : 'Extraction is stopped',
    timestamp: new Date().toISOString()
  })}\n\n`);

  // Handle client disconnect
  req.on('close', () => {
    console.log(`SSE client disconnected: ${clientId}`);
    extractionState.clients.delete({ id: clientId, res });
  });
});

// Helper function to broadcast to all connected clients
function broadcastToClients(data: any) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  
  extractionState.clients.forEach((client: any) => {
    try {
      client.res.write(message);
    } catch (error) {
      console.error('Error sending SSE message:', error);
      extractionState.clients.delete(client);
    }
  });
}

// Helper function to get interval in milliseconds
function getIntervalMs(interval: string): number {
  const intervals: { [key: string]: number } = {
    '1min': 60 * 1000,
    '5min': 5 * 60 * 1000,
    '15min': 15 * 60 * 1000,
    '30min': 30 * 60 * 1000,
    '1hour': 60 * 60 * 1000
  };
  return intervals[interval] || 60 * 1000; // Default to 1 minute
}

// Helper function to get sport ID
function getSportId(sport: string): number {
  switch (sport) {
    case 'football': return 58;
    case 'basketball': return 55;
    case 'tennis': return 56;
    default: return 58; // Default to football
  }
}

// Serve the main HTML file
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Initialize token service and extract tokens on startup
async function initializeApp(): Promise<boolean> {
  try {
    console.log('Initializing token service...');
    
    // First, try to load tokens from file
    const tokensLoaded = await tokenService.loadTokensFromFile();
    
    if (tokensLoaded && tokenService.isTokenValid()) {
      const tokenData = tokenService.getCurrentToken();
      console.log('Valid tokens loaded from file');
      console.log(`Token expires at: ${tokenData?.expiresAt.toLocaleString()}`);
    } else {
      console.log('No valid tokens found in file, fetching new tokens using Playwright...');
      try {
        const tokenData = await tokenService.extractAccessToken();
        console.log('New tokens extracted successfully on startup');
        console.log(`Token expires at: ${tokenData.expiresAt.toLocaleString()}`);
      } catch (error) {
        console.error('Failed to extract tokens on startup:', error);
        console.log('Server startup failed - no valid tokens available');
        return false;
      }
    }
    
    // Initialize the service (this will start automatic refresh)
    await tokenService.initialize();
    console.log('Token service initialized successfully');
    
    return true;
  } catch (error) {
    console.error('Failed to initialize token service:', error);
    console.log('Server startup failed - token service initialization error');
    return false;
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  liveService.close();
  await tokenService.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  liveService.close();
  await tokenService.close();
  process.exit(0);
});

// Start server
app.listen(PORT, async () => {
  console.log(`Server is starting on http://localhost:${PORT}`);
  console.log('Server is not ready yet - tokens are being initialized...');
  
  // Initialize app and wait for valid token
  const initialized = await initializeApp();
  
  if (!initialized) {
    console.error('Failed to initialize application - shutting down server');
    process.exit(1);
  }
  
  // Server is now ready
  serverReady = true;
  console.log('✅ Server is now ready and accessible!');
  console.log('Application initialized successfully with valid tokens');
});
