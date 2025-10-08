# Meridianbet Scraper

A TypeScript Node.js application for extracting data from the Meridianbet website using Playwright for web scraping.

## Features

- **Frontend-first implementation** with modern UI
- **Login page** with password authentication
- **Main page** with Live and Pre-game modes
- **Sports selection**: Football, Basketball, Tennis
- **Interval selection** for Pre-game mode
- **Access token extraction** using Playwright
- **Responsive design** with modern styling

## Setup Instructions

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Install Playwright browsers:**
   ```bash
   npx playwright install chromium
   ```

3. **Create environment file:**
   ```bash
   cp .env.example .env
   ```
   
   **Configure Playwright settings in .env:**
   ```env
   PLAYWRIGHT_HEADLESS=true    # Set to false for debugging
   PLAYWRIGHT_TIMEOUT=30000    # Timeout in milliseconds
   PLAYWRIGHT_BLOCK_MEDIA=true # Block images, videos, fonts, stylesheets
   TOKEN_REFRESH_INTERVAL=900000 # Token refresh interval (15 minutes)
   
   # API Rate Limiting (delays in milliseconds)
   API_LEAGUE_DELAY=150        # Delay between league API calls
   API_MARKET_DELAY=200        # Delay between market API calls
   API_RETRY_DELAY=150         # Delay before retry after 401 error
   API_BATCH_DELAY=500         # Delay between batches of events
   API_EVENT_DELAY=50          # Delay between events in same batch
   
   MERIDIANBET_URL=https://meridianbet.rs/en/betting/football
   HARDCODED_PASSWORD=meridianbet2024
   ```

4. **Build the TypeScript code:**
   ```bash
   npm run build
   ```

5. **Start the development server:**
   ```bash
   npm run dev
   ```

6. **Or start the production server:**
   ```bash
   npm start
   ```

## Usage

1. Open your browser and navigate to `http://localhost:3000`
2. Enter the password: `meridianbet2024`
3. Select your preferred mode (Live or Pre-game)
4. Choose a sport (Football, Basketball, or Tennis)
5. If in Pre-game mode, select an interval
6. Click "Extract Data" to:
   - Get access token from Meridianbet using Playwright
   - Extract data with the token
   - Display results with token information

## API Endpoints

- `POST /api/auth/login` - User authentication
- `GET /api/token` - Get access token from Meridianbet
- `GET /api/health` - Health check and token status

## Project Structure

```
├── src/
│   ├── server.ts                    # Express server with authentication
│   └── services/
│       └── MeridianbetTokenService.ts # Playwright token extraction service
├── public/
│   ├── index.html                   # Main HTML file
│   ├── styles.css                   # Modern CSS styling
│   └── app.js                       # Frontend JavaScript logic
├── package.json                     # Dependencies and scripts
├── tsconfig.json                    # TypeScript configuration
└── .env.example                     # Environment variables template
```

## Authentication

The application uses a hardcoded password for authentication:
- **Password**: `meridianbet2024`

## Development

- **Watch mode**: `npm run dev:watch` (auto-restart on changes)
- **Build**: `npm run build` (compile TypeScript to JavaScript)
- **Start**: `npm start` (run compiled JavaScript)

## Environment Configuration

The application uses environment variables for configuration:

- **PLAYWRIGHT_HEADLESS**: Set to `true` for headless mode, `false` for debugging
- **PLAYWRIGHT_TIMEOUT**: Page load timeout in milliseconds (default: 30000)
- **PLAYWRIGHT_BLOCK_MEDIA**: Block media files (`true`/`false`, default: `true`)
- **MERIDIANBET_URL**: Target URL for scraping (default: football betting page)
- **HARDCODED_PASSWORD**: Authentication password
- **PORT**: Server port (default: 3000)

## Performance Optimization

The application includes several performance optimizations:

- **Media Blocking**: By default, images, videos, fonts, and stylesheets are blocked to improve loading speed
- **Resource Filtering**: Only essential resources (HTML, JavaScript, API calls) are loaded
- **Configurable**: Media blocking can be disabled by setting `PLAYWRIGHT_BLOCK_MEDIA=false`

## Token Extraction

The application uses Playwright to:
1. Navigate to the configured Meridianbet URL
2. Extract access tokens from cookies, localStorage, or network requests
3. Cache tokens with expiration tracking
4. Automatically refresh tokens when needed

## Next Steps

This implementation includes:
- ✅ Frontend with authentication
- ✅ Access token extraction using Playwright
- ✅ Token management and caching

The next phase will include:
- Actual data scraping from Meridianbet APIs
- Database integration for storing extracted data
- Real-time data extraction with intervals
- Enhanced error handling and retry logic
- Data export features
