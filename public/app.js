class MeridianbetApp {
    constructor() {
        this.isAuthenticated = false;
        this.currentMode = 'live';
        this.currentSport = 'football';
        this.currentInterval = '1min';
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiresAt = null;
        this.extractionInterval = null;
        this.isExtracting = false;
        this.isRunning = false;
        this.eventSource = null;
        
        this.init();
    }

    init() {
        this.bindEvents();
        this.checkAuthState();
    }

    bindEvents() {
        // Login form
        const loginForm = document.getElementById('login-form');
        loginForm.addEventListener('submit', (e) => this.handleLogin(e));

        // Logout button
        const logoutBtn = document.getElementById('logout-btn');
        logoutBtn.addEventListener('click', () => this.handleLogout());

        // Mode buttons
        const liveModeBtn = document.getElementById('live-mode-btn');
        const pregameModeBtn = document.getElementById('pregame-mode-btn');
        
        liveModeBtn.addEventListener('click', () => this.handleModeChange('live'));
        pregameModeBtn.addEventListener('click', () => this.handleModeChange('pregame'));

        // Sport selector
        const sportSelect = document.getElementById('sport-select');
        sportSelect.addEventListener('change', (e) => this.handleSportChange(e.target.value));

        // Interval selector
        const intervalSelect = document.getElementById('interval-select');
        intervalSelect.addEventListener('change', (e) => this.handleIntervalChange(e.target.value));

        // Extract button
        const extractBtn = document.getElementById('extract-btn');
        extractBtn.addEventListener('click', () => this.handleExtractData());
    }

    async handleLogin(e) {
        e.preventDefault();
        
        const password = document.getElementById('password').value;
        const errorMessage = document.getElementById('error-message');
        
        if (!password) {
            this.showError('Please enter a password');
            return;
        }

        try {
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ password }),
            });

            const data = await response.json();

            if (response.ok) {
                this.isAuthenticated = true;
                this.showMainPage();
                this.hideError();
            } else {
                this.showError(data.error || 'Login failed');
            }
        } catch (error) {
            this.showError('Network error. Please try again.');
            console.error('Login error:', error);
        }
    }

    handleLogout() {
        this.isAuthenticated = false;
        this.showLoginPage();
        document.getElementById('password').value = '';
        this.hideError();
    }

    handleModeChange(mode) {
        this.currentMode = mode;
        const intervalSelector = document.getElementById('interval-selector');
        
        // Update button states
        const liveBtn = document.getElementById('live-mode-btn');
        const pregameBtn = document.getElementById('pregame-mode-btn');
        
        // Remove active class from all buttons
        liveBtn.classList.remove('active');
        pregameBtn.classList.remove('active');
        
        // Add active class to selected button
        if (mode === 'live') {
            liveBtn.classList.add('active');
        } else {
            pregameBtn.classList.add('active');
        }
        
        if (mode === 'pregame') {
            intervalSelector.style.display = 'block';
        } else {
            intervalSelector.style.display = 'none';
        }
        
        this.updateDataDisplay();
    }

    handleSportChange(sport) {
        this.currentSport = sport;
        this.updateDataDisplay();
    }

    handleIntervalChange(interval) {
        this.currentInterval = interval;
        this.updateDataDisplay();
    }

    async handleExtractData() {
        const extractBtn = document.getElementById('extract-btn');
        const dataContent = document.getElementById('data-content');
        
        if (!this.isRunning) {
            // Start data extraction
            await this.startDataExtraction(extractBtn, dataContent);
        } else {
            // Stop data extraction
            this.stopDataExtraction(extractBtn, dataContent);
        }
    }

    async startDataExtraction(extractBtn, dataContent) {
        try {
            extractBtn.disabled = true;
            extractBtn.innerHTML = '<span class="loading"></span> Starting...';
            dataContent.innerHTML = '<p class="placeholder">Starting data extraction, please wait...</p>';

            // Start backend periodic extraction
            const response = await fetch('/api/extraction/start', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ 
                    mode: this.currentMode,
                    sport: this.currentSport,
                    interval: this.currentInterval
                }),
            });

            const data = await response.json();

            if (response.ok && data.success) {
                this.isRunning = true;
                extractBtn.innerHTML = 'Stop';
                extractBtn.disabled = false;
                
                // Disable mode selection controls
                this.disableModeSelection();
                
                // Start SSE connection for real-time updates
                this.startSSEConnection();
                
                dataContent.innerHTML = '<p class="placeholder">Data extraction started. Waiting for data...</p>';
            } else {
                throw new Error(data.error || 'Failed to start data extraction');
            }
        } catch (error) {
            dataContent.innerHTML = `<p style="color: #e74c3c;">Error: ${error.message}</p>`;
            console.error('Start extraction error:', error);
            extractBtn.innerHTML = 'Start';
            extractBtn.disabled = false;
            
            // Re-enable mode selection controls on error
            this.enableModeSelection();
        }
    }

    stopDataExtraction(extractBtn, dataContent) {
        try {
            // Stop backend extraction
            fetch('/api/extraction/stop', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            // Stop SSE connection
            this.stopSSEConnection();

            // Clear any intervals
            if (this.extractionInterval) {
                clearInterval(this.extractionInterval);
                this.extractionInterval = null;
            }

            this.isRunning = false;
            extractBtn.innerHTML = 'Start';
            
            // Enable mode selection controls
            this.enableModeSelection();
            
            dataContent.innerHTML = '<p class="placeholder">Data extraction stopped.</p>';
        } catch (error) {
            console.error('Stop extraction error:', error);
        }
    }

    startSSEConnection() {
        if (this.eventSource) {
            this.eventSource.close();
        }

        this.eventSource = new EventSource('/api/extraction/stream');
        
        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleStreamData(data);
            } catch (error) {
                console.error('Error parsing SSE data:', error);
            }
        };

        this.eventSource.onerror = (error) => {
            console.error('SSE connection error:', error);
            // Attempt to reconnect after 5 seconds
            setTimeout(() => {
                if (this.isRunning) {
                    this.startSSEConnection();
                }
            }, 5000);
        };
    }

    stopSSEConnection() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
    }

    handleStreamData(data) {
        const dataContent = document.getElementById('data-content');
        
        if (data.type === 'data') {
            if (this.currentMode === 'pregame') {
                this.displayPreGameData(data.payload);
            } else if (this.currentMode === 'live') {
                this.displayLiveData(data.payload);
            } else {
                this.displayExtractedData(data.payload);
            }
        } else if (data.type === 'live-data') {
            // Handle real-time live updates
            this.handleLiveUpdate(data.payload);
        } else if (data.type === 'error') {
            dataContent.innerHTML = `<p style="color: #e74c3c;">Error: ${data.message}</p>`;
        } else if (data.type === 'status') {
            dataContent.innerHTML = `<p class="placeholder">${data.message}</p>`;
        }
    }

    /**
     * Disable mode selection controls
     */
    disableModeSelection() {
        const liveBtn = document.getElementById('live-mode-btn');
        const pregameBtn = document.getElementById('pregame-mode-btn');
        const sportSelect = document.getElementById('sport-select');
        const intervalSelect = document.getElementById('interval-select');
        
        liveBtn.disabled = true;
        pregameBtn.disabled = true;
        sportSelect.disabled = true;
        intervalSelect.disabled = true;
        
        // Add visual indication
        liveBtn.classList.add('disabled');
        pregameBtn.classList.add('disabled');
        sportSelect.classList.add('disabled');
        intervalSelect.classList.add('disabled');
    }

    /**
     * Enable mode selection controls
     */
    enableModeSelection() {
        const liveBtn = document.getElementById('live-mode-btn');
        const pregameBtn = document.getElementById('pregame-mode-btn');
        const sportSelect = document.getElementById('sport-select');
        const intervalSelect = document.getElementById('interval-select');
        
        liveBtn.disabled = false;
        pregameBtn.disabled = false;
        sportSelect.disabled = false;
        intervalSelect.disabled = false;
        
        // Remove visual indication
        liveBtn.classList.remove('disabled');
        pregameBtn.classList.remove('disabled');
        sportSelect.classList.remove('disabled');
        intervalSelect.classList.remove('disabled');
    }

    async handlePreGameExtraction(extractBtn, dataContent) {
        extractBtn.innerHTML = '<span class="loading"></span> Extracting Pre-game Data...';
        dataContent.innerHTML = '<p class="placeholder">Extracting pre-game data, please wait...</p>';
        
        try {
            // Extract pre-game data
            const response = await fetch('/api/pregame/extract', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ sport: this.currentSport }),
            });

            const data = await response.json();

            if (response.ok && data.success) {
                this.displayPreGameData(data.data);
                
                // Start periodic extraction if interval is selected
                if (this.currentInterval !== 'none') {
                    this.startPeriodicExtraction();
                    extractBtn.innerHTML = 'Stop Extraction';
                    extractBtn.onclick = () => this.stopPeriodicExtraction();
                } else {
                    extractBtn.innerHTML = 'Extract Data';
                }
            } else {
                throw new Error(data.error || 'Failed to extract pre-game data');
            }
        } catch (error) {
            throw new Error(`Pre-game extraction failed: ${error.message}`);
        }
    }

    async handleLiveExtraction(extractBtn, dataContent) {
        // Update button text
        extractBtn.innerHTML = '<span class="loading"></span> Extracting...';
        dataContent.innerHTML = '<p class="placeholder">Extracting data with access token, please wait...</p>';
        
        // Simulate API call (replace with actual scraping logic later)
        await this.simulateDataExtraction();
        
        // Display mock data
        this.displayExtractedData();
    }

    async getAccessToken() {
        try {
            console.log('Getting saved access token...');
            
            const response = await fetch('/api/token', {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            const data = await response.json();

            if (response.ok && data.success) {
                this.accessToken = data.token;
                this.refreshToken = data.refreshToken;
                this.tokenExpiresAt = new Date(data.expiresAt);
                console.log('Access token obtained successfully');
                console.log('Refresh token:', this.refreshToken ? 'Available' : 'Not available');
                console.log('Token expires at:', this.tokenExpiresAt);
            } else {
                throw new Error(data.error || 'Failed to get access token');
            }
        } catch (error) {
            console.error('Error getting access token:', error);
            throw new Error(`Failed to get access token: ${error.message}`);
        }
    }

    isTokenValid() {
        if (!this.accessToken || !this.tokenExpiresAt) {
            return false;
        }
        
        const now = new Date();
        const timeUntilExpiry = this.tokenExpiresAt.getTime() - now.getTime();
        
        // Consider token invalid if it expires within the next 5 minutes
        return timeUntilExpiry > 5 * 60 * 1000;
    }




    getOrCreateModeStatus() {
        let modeStatus = document.getElementById('mode-status');
        if (!modeStatus) {
            modeStatus = document.createElement('div');
            modeStatus.id = 'mode-status';
            modeStatus.className = 'mode-status-container';
            
            const modeButtons = document.querySelector('.mode-buttons');
            modeButtons.parentNode.insertBefore(modeStatus, modeButtons.nextSibling);
        }
        return modeStatus;
    }

    async simulateDataExtraction() {
        // Simulate network delay
        return new Promise(resolve => setTimeout(resolve, 2000));
    }

    startPeriodicExtraction() {
        if (this.extractionInterval) {
            clearInterval(this.extractionInterval);
        }

        const intervalMs = this.getIntervalMs(this.currentInterval);
        console.log(`Starting periodic extraction every ${this.currentInterval}`);

        this.extractionInterval = setInterval(async () => {
            if (this.isExtracting) {
                console.log('Extraction already in progress, skipping...');
                return;
            }

            this.isExtracting = true;
            console.log('Running periodic pre-game extraction...');

            try {
                const response = await fetch('/api/pregame/extract', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ sport: this.currentSport }),
                });

                const data = await response.json();

                if (response.ok && data.success) {
                    this.displayPreGameData(data.data);
                    console.log(`Periodic extraction completed: ${data.message}`);
                } else {
                    console.error('Periodic extraction failed:', data.error);
                }
            } catch (error) {
                console.error('Periodic extraction error:', error);
            } finally {
                this.isExtracting = false;
            }
        }, intervalMs);
    }

    stopPeriodicExtraction() {
        if (this.extractionInterval) {
            clearInterval(this.extractionInterval);
            this.extractionInterval = null;
            console.log('Periodic extraction stopped');
        }

        const extractBtn = document.getElementById('extract-btn');
        extractBtn.innerHTML = 'Extract Data';
        extractBtn.onclick = () => this.handleExtractData();
    }

    getIntervalMs(interval) {
        const intervals = {
            '1min': 60 * 1000,
            '5min': 5 * 60 * 1000,
            '15min': 15 * 60 * 1000,
            '30min': 30 * 60 * 1000,
            '1hour': 60 * 60 * 1000
        };
        return intervals[interval] || 60 * 1000;
    }

    displayExtractedData() {
        const dataContent = document.getElementById('data-content');
        
        const mockData = this.generateMockData();
        const tokenExpiry = this.tokenExpiresAt ? this.tokenExpiresAt.toLocaleString() : 'N/A';
        
        dataContent.innerHTML = `
            <div class="data-summary">
                <h3>Data Summary</h3>
                <p><strong>Mode:</strong> ${this.currentMode.charAt(0).toUpperCase() + this.currentMode.slice(1)}</p>
                <p><strong>Sport:</strong> ${this.currentSport.charAt(0).toUpperCase() + this.currentSport.slice(1)}</p>
                ${this.currentMode === 'pregame' ? `<p><strong>Interval:</strong> ${this.currentInterval}</p>` : ''}
                <p><strong>Token Expires:</strong> ${tokenExpiry}</p>
                <p><strong>Records Found:</strong> ${mockData.length}</p>
            </div>
            
            <div class="data-table">
                <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
                    <thead>
                        <tr style="background: #f8f9fa;">
                            <th style="padding: 12px; border: 1px solid #dee2e6; text-align: left;">Match</th>
                            <th style="padding: 12px; border: 1px solid #dee2e6; text-align: left;">Odds</th>
                            <th style="padding: 12px; border: 1px solid #dee2e6; text-align: left;">Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${mockData.map(item => `
                            <tr>
                                <td style="padding: 12px; border: 1px solid #dee2e6;">${item.match}</td>
                                <td style="padding: 12px; border: 1px solid #dee2e6;">${item.odds}</td>
                                <td style="padding: 12px; border: 1px solid #dee2e6;">
                                    <span style="color: ${item.status === 'Live' ? '#27ae60' : '#3498db'};">
                                        ${item.status}
                                    </span>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    displayPreGameData(data) {
        const dataContent = document.getElementById('data-content');
        const tokenExpiry = this.tokenExpiresAt ? this.tokenExpiresAt.toLocaleString() : 'N/A';
        
        // Convert markets object to array for display
        // Note: data.markets is now a plain object (not Map) due to JSON serialization
        const marketsArray = Object.entries(data.markets).map(([eventId, marketDataArray]) => ({
            eventId: parseInt(eventId), // Ensure it's a number
            markets: marketDataArray.flatMap(marketData => marketData.markets)
        }));

        // Debug logging
        console.log('Frontend Debug Info:');
        console.log('- Total events:', data.events.length);
        console.log('- Total market groups:', Object.keys(data.markets).length);
        console.log('- Sample event IDs:', data.events.slice(0, 5).map(e => e.header.eventId));
        console.log('- Sample market event IDs:', Object.keys(data.markets).slice(0, 5));
        console.log('- Markets array length:', marketsArray.length);
        console.log('- Raw markets data:', data.markets);
        console.log('- First market group sample:', Object.entries(data.markets)[0]);
        console.log('- Markets array sample:', marketsArray[0]);

        // Group events by league for better organization
        const eventsByLeague = {};
        data.events.forEach(event => {
            const leagueName = event.header.leagueName || 'Unknown League';
            if (!eventsByLeague[leagueName]) {
                eventsByLeague[leagueName] = [];
            }
            eventsByLeague[leagueName].push(event);
        });

        dataContent.innerHTML = `
            <div class="data-summary">
                <h3>Pre-game Data Summary</h3>
                <div class="summary-grid">
                    <div class="summary-item">
                        <span class="summary-label">Mode:</span>
                        <span class="summary-value">${this.currentMode.charAt(0).toUpperCase() + this.currentMode.slice(1)}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Sport:</span>
                        <span class="summary-value">${this.currentSport.charAt(0).toUpperCase() + this.currentSport.slice(1)}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Interval:</span>
                        <span class="summary-value">${this.currentInterval}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Total Events:</span>
                        <span class="summary-value">${data.summary.totalEvents}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Total Markets:</span>
                        <span class="summary-value">${data.summary.totalMarkets}</span>
                    </div>
                </div>
                <div class="extraction-time">
                    <strong>Extracted At:</strong> ${data.summary.extractedAt.toLocaleString()}
                </div>
            </div>
            
            <div class="odds-display">
                <h3>Pre-game Odds (${data.events.length} events)</h3>
                
                <div class="leagues-container">
                    ${Object.entries(eventsByLeague).map(([leagueName, events]) => `
                        <div class="league-section">
                            <h4 class="league-title">${leagueName} (${events.length} events)</h4>
                            <div class="events-grid">
                                ${events.map(event => {
                                    // Find markets for this event
                                    const marketData = marketsArray.find(m => m.eventId.toString() === event.header.eventId.toString());
                                    const markets = marketData ? marketData.markets : [];
                                    
                                    return `
                                        <div class="event-card">
                                            <div class="event-header">
                                                <span class="event-id">#${event.header.eventId}</span>
                                                <span class="event-status ${event.header.status || 'scheduled'}">${event.header.status || 'Scheduled'}</span>
                                            </div>
                                            <div class="event-details">
                                                <div class="event-teams">
                                                    ${event.header.rivals && event.header.rivals.length >= 2 
                                                        ? `${event.header.rivals[0]} vs ${event.header.rivals[1]}`
                                                        : event.header.homeTeamName && event.header.awayTeamName
                                                            ? `${event.header.homeTeamName} vs ${event.header.awayTeamName}`
                                                            : 'Home vs Away'
                                                    }
                                                </div>
                                                <div class="event-time">
                                                    ${event.header.startTime ? new Date(event.header.startTime).toLocaleString() : 'TBD'}
                                                </div>
                                            </div>
                                            
                                            ${markets.length > 0 ? `
                                                <div class="event-markets">
                                                    <div class="markets-header">
                                                        <h5>Markets (${markets.length})</h5>
                                                    </div>
                                                    <div class="markets-grid">
                                                        ${markets.map(market => `
                                                            <div class="market-card">
                                                                <div class="market-header">
                                                                    <span class="market-name">${market.name}</span>
                                                                    <span class="market-state ${market.state.toLowerCase()}">${market.state}</span>
                                                                </div>
                                                                <div class="market-selections">
                                                                    ${market.selections.map(selection => `
                                                                        <div class="selection-item">
                                                                            <span class="selection-name">${selection.name}</span>
                                                                            <span class="selection-price ${selection.state.toLowerCase()}">${selection.price}</span>
                                                                        </div>
                                                                    `).join('')}
                                                                </div>
                                                                ${market.overUnder ? `<div class="market-overunder">Over/Under: ${market.overUnder}</div>` : ''}
                                                                ${market.handicap ? `<div class="market-handicap">Handicap: ${market.handicap}</div>` : ''}
                                                            </div>
                                                        `).join('')}
                                                    </div>
                                                </div>
                                            ` : `
                                                <div class="no-markets">
                                                    <span class="no-markets-text">No markets available</span>
                                                </div>
                                            `}
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    generateMockData() {
        const sports = {
            football: ['Manchester United vs Liverpool', 'Barcelona vs Real Madrid', 'Bayern Munich vs Dortmund'],
            basketball: ['Lakers vs Warriors', 'Celtics vs Heat', 'Nets vs Bucks'],
            tennis: ['Djokovic vs Nadal', 'Federer vs Murray', 'Williams vs Osaka']
        };

        const matches = sports[this.currentSport] || sports.football;
        
        return matches.map(match => ({
            match: match,
            odds: `${(Math.random() * 3 + 1).toFixed(2)} - ${(Math.random() * 3 + 1).toFixed(2)} - ${(Math.random() * 3 + 1).toFixed(2)}`,
            status: this.currentMode === 'live' ? 'Live' : 'Pre-game'
        }));
    }

    updateDataDisplay() {
        const dataContent = document.getElementById('data-content');
        dataContent.innerHTML = '<p class="placeholder">Select mode, sport, and click "Extract Data" to begin</p>';
    }

    showLoginPage() {
        document.getElementById('login-page').style.display = 'flex';
        document.getElementById('main-page').style.display = 'none';
    }

    showMainPage() {
        document.getElementById('login-page').style.display = 'none';
        document.getElementById('main-page').style.display = 'block';
    }

    showError(message) {
        const errorMessage = document.getElementById('error-message');
        errorMessage.textContent = message;
        errorMessage.style.display = 'block';
    }

    hideError() {
        const errorMessage = document.getElementById('error-message');
        errorMessage.style.display = 'none';
    }

    checkAuthState() {
        // Check if user is already authenticated (in a real app, this would check localStorage or cookies)
        // For now, always show login page
        this.showLoginPage();
    }

    displayLiveData(data) {
        const dataContent = document.getElementById('data-content');
        
        if (data.message === 'Live extraction started') {
            dataContent.innerHTML = `
                <div class="data-summary">
                    <h3>Live Data Extraction Started</h3>
                    <div class="summary-grid">
                        <div class="summary-item">
                            <span class="summary-label">Mode:</span>
                            <span class="summary-value">${data.mode}</span>
                        </div>
                        <div class="summary-item">
                            <span class="summary-label">Sport:</span>
                            <span class="summary-value">${data.sport}</span>
                        </div>
                        <div class="summary-item">
                            <span class="summary-label">Sport ID:</span>
                            <span class="summary-value">${data.sportId}</span>
                        </div>
                    </div>
                    <p class="extraction-time">Started at: ${new Date().toLocaleString()}</p>
                </div>
                <div class="live-updates-container">
                    <h3>Live Updates</h3>
                    <div id="live-updates-list" class="live-updates-list">
                        <p class="placeholder">Waiting for live data...</p>
                    </div>
                </div>
            `;
        } else if (data.type === 'live_data' && data.events) {
            // Display actual live events and markets data
            this.displayLiveEventsAndMarkets(data);
        } else {
            dataContent.innerHTML = `<p class="placeholder">${data.message}</p>`;
        }
    }

    displayLiveEventsAndMarkets(data) {
        const dataContent = document.getElementById('data-content');
        
        if (!data.events || data.events.length === 0) {
            dataContent.innerHTML = '<p class="placeholder">No live events available</p>';
            return;
        }

        let html = `
            <div class="data-summary">
                <h3>Live Events & Markets</h3>
                <div class="summary-grid">
                    <div class="summary-item">
                        <span class="summary-label">Total Events:</span>
                        <span class="summary-value">${data.events.length}</span>
                    </div>
                    <div class="summary-item">
                        <span class="summary-label">Last Update:</span>
                        <span class="summary-value">${new Date(data.lastUpdate).toLocaleString()}</span>
                    </div>
                </div>
            </div>
            <div class="live-data-container">
                <div class="events-container">
        `;

        // Display each live event with its markets
        data.events.forEach(event => {
            const eventId = event.header.eventId;
            const markets = data.markets[eventId] || [];
            
            html += `
                <div class="event-card">
                    <div class="event-header">
                        <div class="event-teams">
                            ${event.header.rivals && event.header.rivals.length >= 2 
                                ? `${event.header.rivals[0]} vs ${event.header.rivals[1]}`
                                : event.header.homeTeamName && event.header.awayTeamName
                                    ? `${event.header.homeTeamName} vs ${event.header.awayTeamName}`
                                    : 'Home vs Away'
                            }
                        </div>
                        <div class="event-info">
                            <span class="event-id">ID: ${eventId}</span>
                            <span class="match-time">${event.header.matchTime || 'Live'}</span>
                            <span class="event-state">${event.header.state || 'ACTIVE'}</span>
                        </div>
                    </div>
                    
                    <div class="event-markets">
                        <div class="markets-header">
                            <h4>Markets (${markets.length})</h4>
                        </div>
            `;

            if (markets.length > 0) {
                markets.forEach(marketGroup => {
                    html += `
                        <div class="market-group">
                            <h5>${marketGroup.marketName}</h5>
                            <div class="selections-grid">
                    `;
                    
                    marketGroup.markets.forEach(market => {
                        html += `
                            <div class="market-card">
                                <div class="market-name">${market.name}</div>
                                ${market.overUnder ? `<div class="over-under">${market.overUnder}</div>` : ''}
                                <div class="selections">
                        `;
                        
                        market.selections.forEach(selection => {
                            html += `
                                <div class="selection">
                                    <span class="selection-name">${selection.name}</span>
                                    <span class="selection-price">${selection.price}</span>
                                    <span class="selection-state ${selection.state.toLowerCase()}">${selection.state}</span>
                                </div>
                            `;
                        });
                        
                        html += `
                                </div>
                            </div>
                        `;
                    });
                    
                    html += `
                            </div>
                        </div>
                    `;
                });
            } else {
                html += '<p class="no-markets">No markets available for this event</p>';
            }

            html += `
                    </div>
                </div>
            `;
        });

        html += '</div></div>';
        dataContent.innerHTML = html;
    }

    handleLiveUpdate(updateData) {
        // If this is a live data update (not individual event updates), refresh the main display
        if (updateData.type === 'live_data' && updateData.events) {
            this.displayLiveEventsAndMarkets(updateData);
            return;
        }

        // For individual updates, add to the updates list
        const liveUpdatesList = document.getElementById('live-updates-list');
        if (!liveUpdatesList) return;

        const updateElement = document.createElement('div');
        updateElement.className = 'live-update-item';
        
        if (updateData.type === 'single-event-update') {
            const event = updateData.data.header;
            updateElement.innerHTML = `
                <div class="live-event-update">
                    <h4>Event Update: ${event.eventId}</h4>
                    <div class="event-info">
                        <span class="match-time">${event.matchTime}</span>
                        <span class="event-state">${event.state}</span>
                    </div>
                    <div class="games-count">${updateData.data.games.length} market groups</div>
                    <div class="update-time">${new Date(updateData.timestamp).toLocaleTimeString()}</div>
                </div>
            `;
        } else if (updateData.type === 'offer-feed-update-live') {
            const event = updateData.data.header;
            updateElement.innerHTML = `
                <div class="live-offer-update">
                    <h4>Offer Update: ${event.eventId}</h4>
                    <div class="event-info">
                        <span class="match-time">${event.matchTime}</span>
                        <span class="event-state">${event.state}</span>
                    </div>
                    <div class="teams">${event.rivals.join(' vs ')}</div>
                    <div class="positions-count">${updateData.data.positions.length} positions</div>
                    <div class="update-time">${new Date(updateData.timestamp).toLocaleTimeString()}</div>
                </div>
            `;
        } else {
            updateElement.innerHTML = `
                <div class="live-update-item">
                    <h4>Unknown Update</h4>
                    <div class="update-time">${new Date(updateData.timestamp).toLocaleTimeString()}</div>
                </div>
            `;
        }

        // Add to top of list
        liveUpdatesList.insertBefore(updateElement, liveUpdatesList.firstChild);
        
        // Keep only last 20 updates
        while (liveUpdatesList.children.length > 20) {
            liveUpdatesList.removeChild(liveUpdatesList.lastChild);
        }
    }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new MeridianbetApp();
});
