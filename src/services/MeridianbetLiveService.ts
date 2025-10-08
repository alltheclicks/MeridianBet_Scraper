import WebSocket from 'ws';
import { MeridianbetTokenService } from './MeridianbetTokenService';
import { EventData, MarketData, Market, Selection as MarketSelection } from './MeridianbetDataService';

export interface LiveEventUpdate {
  header: EventData['header'];
  games: MarketData[];
}

export interface LiveOfferUpdate {
  header: {
    eventId: number;
    code: string;
    offerType: string;
    offerSubType: string;
    startTime: number;
    state: string;
    sport: {
      sportId: number;
      name: string;
      slug: string;
    };
    region: {
      regionId: number;
      name: string;
      slug: string;
    };
    league: {
      leagueId: number;
      name: string;
      slug: string;
      favoriteLeague: boolean;
    };
    result: {
      periods: any[];
      extraData: Record<string, string>;
    };
    formattedResult: {
      periodScores: any[];
      redCards: number[];
      yellowCards: number[];
    };
    matchTime: string;
    rivals: string[];
    rivalsSlug: string;
    periodDuration: string;
    topMatch: boolean;
    setEventOrder: number;
    numberOfVisibleSelections: number;
    hasEarlyPayout: boolean;
  };
  positions: Array<{
    index: number;
    groups: Array<{
      selections?: Array<{
        selectionId: string;
        state: string;
        price: number;
        marketId: number;
        gameTemplateId: number;
        placeholder: boolean;
      }>;
      overUnder?: number;
      name?: string;
      containsTemplateWithVariableMarketName: boolean;
      earlyPayoutMarket: boolean;
    }>;
  }>;
}

export class MeridianbetLiveService {
  private ws: WebSocket | null = null;
  private pingInterval: number = 25000; // Default ping interval
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnected: boolean = false;
  private isHandshakeComplete: boolean = false;
  private sessionId: string | null = null;
  private subscribedEvents: Set<number> = new Set();
  private currentSportId: number | null = null;
  private onDataCallback: ((data: any) => void) | null = null;
  private onErrorCallback: ((error: Error) => void) | null = null;

  // Live data storage
  private liveEvents: Map<number, LiveEventUpdate> = new Map();
  private liveMarkets: Map<number, MarketData[]> = new Map();
  private lastUpdateTime: Date = new Date();

  // Configuration from environment variables
  private readonly WEBSOCKET_URL = 'wss://online-ws.meridianbet.com/betshop-online/';
  private readonly LIVE_EVENTS_DELAY = parseInt(process.env.API_LIVE_EVENTS_DELAY || '1000');
  private readonly LIVE_MARKETS_DELAY = parseInt(process.env.API_LIVE_MARKETS_DELAY || '500');
  private readonly RECONNECT_DELAY = parseInt(process.env.WEBSOCKET_RECONNECT_DELAY || '5000');
  private readonly MAX_RECONNECT_ATTEMPTS = parseInt(process.env.WEBSOCKET_MAX_RECONNECT_ATTEMPTS || '5');

  constructor(
    private tokenService: MeridianbetTokenService
  ) { }

  /**
   * Set callback for live data updates
   */
  public setDataCallback(callback: (data: any) => void): void {
    this.onDataCallback = callback;
  }

  /**
   * Set callback for error handling
   */
  public setErrorCallback(callback: (error: Error) => void): void {
    this.onErrorCallback = callback;
  }

  /**
   * Get current live data
   */
  public getCurrentLiveData(): { events: LiveEventUpdate[], markets: Map<number, MarketData[]>, lastUpdate: Date } {
    return {
      events: Array.from(this.liveEvents.values()),
      markets: new Map(this.liveMarkets),
      lastUpdate: this.lastUpdateTime
    };
  }

  /**
   * Start live data extraction for a specific sport
   */
  public async startLiveExtraction(sportId: number): Promise<void> {
    console.log(`Starting live extraction for sport ${sportId}`);
    this.currentSportId = sportId;

    try {
      // Step 1: Connect to WebSocket first
      await this.connectWebSocket();

      // Step 2: Wait for handshake to complete
      await this.waitForHandshake();

      // Step 3: Get initial live events
      const events = await this.getInitialLiveEvents(sportId);
      console.log(`Found ${events.length} live events`);

      // Step 4: Get initial odds data for all events
      const markets = await this.getInitialLiveMarkets(events);
      console.log(`Got initial markets for ${markets.size} events`);

      // Step 5: Store initial data
      this.storeInitialData(events, markets);

      // Step 6: Subscribe to live updates
      await this.subscribeToLiveUpdates(sportId, events);

      console.log('Live extraction started successfully');

    } catch (error) {
      console.error('Failed to start live extraction:', error);
      if (this.onErrorCallback) {
        this.onErrorCallback(error instanceof Error ? error : new Error('Unknown error'));
      }
    }
  }

  /**
   * Wait for WebSocket handshake to complete
   */
  private async waitForHandshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Handshake timeout'));
      }, 10000);

      const checkHandshake = () => {
        if (this.isHandshakeComplete) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkHandshake, 100);
        }
      };

      checkHandshake();
    });
  }

  /**
   * Stop live data extraction
   */
  public stopLiveExtraction(): void {
    console.log('Stopping live extraction');

    this.disconnectWebSocket();
    this.subscribedEvents.clear();
    this.currentSportId = null;
  }

  /**
   * Get initial live events from API
   */
  private async getInitialLiveEvents(sportId: number): Promise<EventData[]> {
    const tokenData = this.tokenService.getCurrentToken();
    if (!tokenData) {
      throw new Error('No valid token available for live events API');
    }

    const url = `https://online.meridianbet.com/betshop/api/v2/live/sport/events?sorting=TOP_LEAGUES&sportId=${sportId}`;

    console.log(`Fetching live events from: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${tokenData.accessToken}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'en'
      }
    });

    if (!response.ok) {
      if (response.status === 401) {
        console.log('Token expired for live events API, refreshing...');
        await this.tokenService.waitForTokenRefresh();
        return this.getInitialLiveEvents(sportId); // Retry with new token
      }
      throw new Error(`Failed to fetch live events: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (data.errorCode !== null) {
      throw new Error(`API error: ${data.errorMessages?.join(', ') || 'Unknown error'}`);
    }

    const events: EventData[] = data.payload?.events || [];
    console.log(`Retrieved ${events.length} live events for sport ${sportId}`);

    return events;
  }

  /**
   * Get initial markets data for live events using batch calls
   */
  private async getInitialLiveMarkets(events: EventData[]): Promise<Map<number, MarketData[]>> {
    const markets = new Map<number, MarketData[]>();
    
    if (events.length === 0) {
      return markets;
    }

    console.log(`Fetching markets for ${events.length} events using batch calls`);

    // Process events in batches of 5
    const batchSize = 5;
    const batches = [];
    
    for (let i = 0; i < events.length; i += batchSize) {
      batches.push(events.slice(i, i + batchSize));
    }

    // Process each batch
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      console.log(`Processing batch ${batchIndex + 1}/${batches.length} with ${batch.length} events`);

      // Create concurrent promises for this batch
      const batchPromises = batch.map(async (event, eventIndex) => {
        try {
          // Stagger calls within batch
          await this.delay(eventIndex * 100);
          
          const eventMarkets = await this.getEventMarkets(event.header.eventId);
          console.log(`Batch ${batchIndex + 1}: Got ${eventMarkets.length} market groups for event ${event.header.eventId}`);
          
          return {
            eventId: event.header.eventId,
            markets: eventMarkets
          };
        } catch (error) {
          console.error(`Batch ${batchIndex + 1}: Failed to get markets for event ${event.header.eventId}:`, error);
          return {
            eventId: event.header.eventId,
            markets: []
          };
        }
      });

      // Wait for all events in this batch to complete
      const batchResults = await Promise.all(batchPromises);
      
      // Store results
      batchResults.forEach(result => {
        if (result.markets.length > 0) {
          markets.set(result.eventId, result.markets);
        }
      });

      // Delay between batches to avoid rate limiting
      if (batchIndex < batches.length - 1) {
        await this.delay(this.LIVE_MARKETS_DELAY);
      }
    }

    console.log(`Completed fetching markets for ${events.length} events. Got markets for ${markets.size} events.`);
    return markets;
  }

  /**
   * Store initial data and broadcast to frontend
   */
  private storeInitialData(events: EventData[], markets: Map<number, MarketData[]>): void {
    // Clear existing data
    this.liveEvents.clear();
    this.liveMarkets.clear();

    // Store events
    for (const event of events) {
      this.liveEvents.set(event.header.eventId, {
        header: event.header,
        games: markets.get(event.header.eventId) || []
      });
    }

    // Store markets
    for (const [eventId, marketData] of markets) {
      this.liveMarkets.set(eventId, marketData);
    }

    // Update timestamp
    this.lastUpdateTime = new Date();

    // Broadcast initial data to frontend
    this.broadcastLiveData();
  }

  /**
   * Broadcast current live data to frontend
   */
  private broadcastLiveData(): void {
    if (this.onDataCallback) {
      const liveData = {
        type: 'live_data',
        events: Array.from(this.liveEvents.values()),
        markets: Object.fromEntries(this.liveMarkets),
        lastUpdate: this.lastUpdateTime.toISOString(),
        mode: 'live'
      };
      
      this.onDataCallback(liveData);
    }
  }

  /**
   * Merge event data with existing data
   */
  private mergeEventData(eventId: number, newEventData: LiveEventUpdate): void {
    const existingEvent = this.liveEvents.get(eventId);
    
    if (existingEvent) {
      // Merge header data
      const mergedHeader = {
        ...existingEvent.header,
        ...newEventData.header
      };
      
      // Merge games/markets data
      const mergedGames = [...existingEvent.games];
      
      // Update or add games from new data
      newEventData.games.forEach(newGame => {
        const existingGameIndex = mergedGames.findIndex(game => 
          game.gameTemplateId === newGame.gameTemplateId
        );
        
        if (existingGameIndex >= 0) {
          // Update existing game
          mergedGames[existingGameIndex] = {
            ...mergedGames[existingGameIndex],
            ...newGame
          };
        } else {
          // Add new game
          mergedGames.push(newGame);
        }
      });
      
      this.liveEvents.set(eventId, {
        header: mergedHeader,
        games: mergedGames
      });
    } else {
      // Add new event
      this.liveEvents.set(eventId, newEventData);
    }
  }

  /**
   * Merge market data with existing data
   */
  private mergeMarketData(eventId: number, newMarketData: MarketData[]): void {
    const existingMarkets = this.liveMarkets.get(eventId) || [];
    
    // Create a map of existing markets by gameTemplateId for quick lookup
    const existingMarketsMap = new Map();
    existingMarkets.forEach(market => {
      existingMarketsMap.set(market.gameTemplateId, market);
    });
    
    // Merge new market data
    const mergedMarkets: MarketData[] = [];
    
    newMarketData.forEach(newMarket => {
      const existingMarket = existingMarketsMap.get(newMarket.gameTemplateId);
      
      if (existingMarket) {
        // Merge existing market with new data
        const mergedMarket: MarketData = {
          ...existingMarket,
          ...newMarket,
          markets: this.mergeMarkets(existingMarket.markets, newMarket.markets)
        };
        mergedMarkets.push(mergedMarket);
      } else {
        // Add new market
        mergedMarkets.push(newMarket);
      }
    });
    
    // Add any existing markets that weren't updated
    existingMarkets.forEach(existingMarket => {
      if (!newMarketData.some(newMarket => newMarket.gameTemplateId === existingMarket.gameTemplateId)) {
        mergedMarkets.push(existingMarket);
      }
    });
    
    this.liveMarkets.set(eventId, mergedMarkets);
  }

  /**
   * Merge individual markets within a market group
   */
  private mergeMarkets(existingMarkets: Market[], newMarkets: Market[]): Market[] {
    const mergedMarkets: Market[] = [];
    const existingMarketsMap = new Map();
    
    existingMarkets.forEach(market => {
      existingMarketsMap.set(market.marketId, market);
    });
    
    newMarkets.forEach(newMarket => {
      const existingMarket = existingMarketsMap.get(newMarket.marketId);
      
      if (existingMarket) {
        // Merge existing market with new data
        const mergedMarket: Market = {
          ...existingMarket,
          ...newMarket,
          selections: this.mergeSelections(existingMarket.selections, newMarket.selections)
        };
        mergedMarkets.push(mergedMarket);
      } else {
        // Add new market
        mergedMarkets.push(newMarket);
      }
    });
    
    // Add any existing markets that weren't updated
    existingMarkets.forEach(existingMarket => {
      if (!newMarkets.some(newMarket => newMarket.marketId === existingMarket.marketId)) {
        mergedMarkets.push(existingMarket);
      }
    });
    
    return mergedMarkets;
  }

  /**
   * Merge selections within a market
   */
  private mergeSelections(existingSelections: MarketSelection[], newSelections: MarketSelection[]): MarketSelection[] {
    const mergedSelections: MarketSelection[] = [];
    const existingSelectionsMap = new Map();
    
    existingSelections.forEach(selection => {
      existingSelectionsMap.set(selection.selectionId, selection);
    });
    
    newSelections.forEach(newSelection => {
      const existingSelection = existingSelectionsMap.get(newSelection.selectionId);
      
      if (existingSelection) {
        // Merge existing selection with new data
        mergedSelections.push({
          ...existingSelection,
          ...newSelection
        });
      } else {
        // Add new selection
        mergedSelections.push(newSelection);
      }
    });
    
    // Add any existing selections that weren't updated
    existingSelections.forEach(existingSelection => {
      if (!newSelections.some(newSelection => newSelection.selectionId === existingSelection.selectionId)) {
        mergedSelections.push(existingSelection);
      }
    });
    
    return mergedSelections;
  }

  /**
   * Get markets for a specific event
   */
  private async getEventMarkets(eventId: number): Promise<MarketData[]> {
    const tokenData = this.tokenService.getCurrentToken();
    if (!tokenData) {
      throw new Error('No valid token available for markets API');
    }

    const url = `https://online.meridianbet.com/betshop/api/v2/events/${eventId}/markets?gameGroupId=all`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${tokenData.accessToken}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'en'
      }
    });

    if (!response.ok) {
      if (response.status === 401) {
        console.log('Token expired for markets API, refreshing...');
        await this.tokenService.waitForTokenRefresh();
        return this.getEventMarkets(eventId); // Retry with new token
      }
      throw new Error(`Failed to fetch markets for event ${eventId}: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (data.errorCode !== null) {
      throw new Error(`API error for event ${eventId}: ${data.errorMessages?.join(', ') || 'Unknown error'}`);
    }

    return data.payload || [];
  }

  /**
   * Connect to WebSocket
   */
  private async connectWebSocket(): Promise<void> {
    const tokenData = this.tokenService.getCurrentToken();
    if (!tokenData) {
      throw new Error('No valid token available for WebSocket connection');
    }

    const wsUrl = `${this.WEBSOCKET_URL}?access_token=${tokenData.accessToken}&language=en&EIO=4&transport=websocket`;

    console.log('Connecting to WebSocket...');

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('WebSocket connected successfully');
        this.isConnected = true;
        
        // Send initial connection message "40" as per Socket.IO protocol
        console.log('Sending initial connection message: 40');
        this.ws!.send('40');
        
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleWebSocketMessage(data.toString());
      });

      this.ws.on('error', (error: Error) => {
        console.error('WebSocket error:', error);
        this.isConnected = false;
        if (this.onErrorCallback) {
          this.onErrorCallback(error);
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.log(`WebSocket closed: ${code} ${reason.toString()}`);
        this.isConnected = false;
        this.clearPingTimer();
        this.scheduleReconnect();
      });

      // Set timeout for connection
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('WebSocket connection timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Disconnect WebSocket
   */
  private disconnectWebSocket(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.clearPingTimer();
    this.clearReconnectTimer();
    this.isConnected = false;
    this.isHandshakeComplete = false;
    this.sessionId = null;
  }

  /**
   * Handle WebSocket messages
   */
  private handleWebSocketMessage(message: string): void {
    try {
      console.log('Received WebSocket message:', message.substring(0, 100) + '...');

      // Handle initial connection message
      if (message.startsWith('0{')) {
        const data = JSON.parse(message.substring(1));
        this.pingInterval = data.pingInterval || 25000;
        console.log(`Set ping interval to ${this.pingInterval}ms`);
        this.startPingTimer();
        return;
      }

      // Handle connection confirmation
      if (message === '40') {
        console.log('Received connection confirmation');
        return;
      }

      // Handle handshake completion (40{"sid":"..."})
      if (message.startsWith('40{')) {
        const data = JSON.parse(message.substring(2));
        this.sessionId = data.sid;
        this.isHandshakeComplete = true;
        console.log(`Handshake complete with session ID: ${this.sessionId}`);
        return;
      }

      // Handle ping response
      if (message === '3') {
        console.log('Received pong');
        return;
      }

      // Handle subscription and data messages
      if (message.startsWith('42[')) {
        const data = JSON.parse(message.substring(2));
        const [messageType, payload] = data;

        switch (messageType) {
          case 'subscriptions':
            console.log('Subscription response:', payload);
            break;

          case 'single-event-update':
            this.handleSingleEventUpdate(payload);
            break;

          case 'offer-feed-update-live':
            this.handleOfferFeedUpdate(payload);
            break;

          default:
            console.log(`Unknown message type: ${messageType}`);
        }
      }

    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }

  /**
   * Handle single event update
   */
  private handleSingleEventUpdate(payload: string): void {
    try {
      const data: LiveEventUpdate = JSON.parse(payload);
      console.log(`Single event update for event ${data.header.eventId}: ${data.header.matchTime}`);

      // Merge event data instead of replacing
      this.mergeEventData(data.header.eventId, data);
      this.lastUpdateTime = new Date();

      // Broadcast updated data
      this.broadcastLiveData();
    } catch (error) {
      console.error('Error parsing single event update:', error);
    }
  }

  /**
   * Handle offer feed update
   */
  private handleOfferFeedUpdate(payload: string): void {
    try {
      const data: LiveOfferUpdate = JSON.parse(payload);
      console.log(`Offer feed update for event ${data.header.eventId}: ${data.header.matchTime}`);

      const eventId = data.header.eventId;
      
      // Check if this event exists in our live events
      const existingEvent = this.liveEvents.get(eventId);
      
      if (!existingEvent) {
        // Create new event from the offer feed update
        console.log(`Creating new event ${eventId} from offer feed update`);
        this.createEventFromOfferUpdate(data);
        return;
      }
      
      // Get existing market data for this event
      const existingMarkets = this.liveMarkets.get(eventId) || [];
      
      // Create a map of existing markets by gameTemplateId for quick lookup
      const existingMarketsMap = new Map();
      existingMarkets.forEach(market => {
        existingMarketsMap.set(market.gameTemplateId, market);
      });
      
      // Process each position (market group) from the update
      data.positions.forEach(position => {
        position.groups.forEach(group => {
          if (!group.selections || group.selections.length === 0) return;
          
          // Find the market group that matches this position
          const gameTemplateId = group.selections[0]?.gameTemplateId;
          if (!gameTemplateId) return;
          
          const existingMarket = existingMarketsMap.get(gameTemplateId);
          if (!existingMarket) return;
          
          // Update selections within this market group
          group.selections.forEach(updateSelection => {
            // Find the corresponding market in the existing data
            const existingMarketGroup = existingMarket.markets.find((market: Market) => 
              market.marketId === updateSelection.marketId
            );
            
            if (existingMarketGroup) {
              // Find the corresponding selection and update it
              const existingSelection = existingMarketGroup.selections.find((selection: MarketSelection) => 
                selection.selectionId === updateSelection.selectionId
              );
              
              if (existingSelection) {
                // Update the existing selection with new data
                existingSelection.price = updateSelection.price;
                existingSelection.state = updateSelection.state;
              } else {
                // Add new selection if it doesn't exist
                existingMarketGroup.selections.push({
                  selectionId: updateSelection.selectionId,
                  price: updateSelection.price,
                  state: updateSelection.state,
                  name: `Selection ${updateSelection.selectionId.split('_').pop() || 'Unknown'}`
                });
              }
            }
          });
        });
      });
      
      // Update the stored markets
      this.liveMarkets.set(eventId, existingMarkets);
      this.lastUpdateTime = new Date();

      // Broadcast updated data
      this.broadcastLiveData();
    } catch (error) {
      console.error('Error parsing offer feed update:', error);
    }
  }

  /**
   * Create a new event from offer feed update data
   */
  private createEventFromOfferUpdate(data: LiveOfferUpdate): void {
    const eventId = data.header.eventId;
    
    // Create event header from offer feed data
    const eventHeader: EventData['header'] = {
      eventId: eventId,
      code: data.header.code,
      offerType: data.header.offerType,
      offerSubType: data.header.offerSubType,
      startTime: data.header.startTime,
      state: data.header.state,
      sport: data.header.sport,
      region: data.header.region,
      league: data.header.league,
      result: data.header.result,
      formattedResult: data.header.formattedResult,
      matchTime: data.header.matchTime || '',
      rivals: data.header.rivals || [],
      rivalsSlug: data.header.rivalsSlug || '',
      periodDuration: data.header.periodDuration || '',
      topMatch: data.header.topMatch || false,
      setEventOrder: data.header.setEventOrder || 0,
      numberOfVisibleSelections: data.header.numberOfVisibleSelections || 0,
      hasEarlyPayout: data.header.hasEarlyPayout || false,
      homeTeamName: data.header.rivals?.[0] || 'Home',
      awayTeamName: data.header.rivals?.[1] || 'Away'
    };
    
    // Convert positions to market data
    const marketData: MarketData[] = data.positions.map(position => ({
      markets: position.groups.map(group => ({
        name: group.name || 'Unknown Market',
        selections: (group.selections || []).map(selection => ({
          selectionId: selection.selectionId,
          price: selection.price,
          state: selection.state,
          name: this.getSelectionName(selection.selectionId, group.name)
        })),
        marketId: group.selections?.[0]?.marketId || 0,
        state: 'ACTIVE',
        overUnder: group.overUnder,
        handicap: undefined,
        isEarlyPayout: group.earlyPayoutMarket
      })),
      gameTemplateId: position.groups[0]?.selections?.[0]?.gameTemplateId || 0,
      marketName: position.groups[0]?.name || 'Unknown Market',
      priority: 0,
      marketType: 'REGULAR',
      hasEarlyPayout: position.groups[0]?.earlyPayoutMarket || false,
      favorite: false
    }));
    
    // Create live event data
    const liveEvent: LiveEventUpdate = {
      header: eventHeader,
      games: marketData
    };
    
    // Store the new event and markets
    this.liveEvents.set(eventId, liveEvent);
    this.liveMarkets.set(eventId, marketData);
    this.lastUpdateTime = new Date();
    
    console.log(`Created new event ${eventId} with ${marketData.length} market groups`);
    
    // Broadcast the updated data
    this.broadcastLiveData();
  }

  /**
   * Get proper selection name based on selection ID and market name
   */
  private getSelectionName(selectionId: string, marketName?: string): string {
    const parts = selectionId.split('_');
    const selectionIndex = parts[parts.length - 1];
    
    // Try to determine selection name based on market type
    if (marketName?.toLowerCase().includes('final score') || marketName?.toLowerCase().includes('scores')) {
      switch (selectionIndex) {
        case '0': return '1';
        case '1': return 'X';
        case '2': return '2';
        default: return `Selection ${selectionIndex}`;
      }
    } else if (marketName?.toLowerCase().includes('total goals') || marketName?.toLowerCase().includes('over')) {
      switch (selectionIndex) {
        case '0': return 'Under';
        case '1': return 'Over';
        default: return `Selection ${selectionIndex}`;
      }
    } else if (marketName?.toLowerCase().includes('double chance')) {
      switch (selectionIndex) {
        case '0': return '1X';
        case '1': return '12';
        case '2': return 'X2';
        default: return `Selection ${selectionIndex}`;
      }
    } else {
      // Default selection names
      switch (selectionIndex) {
        case '0': return '1';
        case '1': return 'X';
        case '2': return '2';
        default: return `Selection ${selectionIndex}`;
      }
    }
  }

  /**
   * Subscribe to live updates
   */
  private async subscribeToLiveUpdates(sportId: number, events: EventData[]): Promise<void> {
    if (!this.ws || !this.isConnected) {
      throw new Error('WebSocket not connected');
    }

    if (!this.isHandshakeComplete) {
      throw new Error('WebSocket handshake not complete');
    }

    // Subscribe to sport updates
    this.sendMessage('subscriptions', JSON.stringify({
      subscriptionType: 'SPORT_UPDATE_LIVE',
      action: 'SUBSCRIBE'
    }));

    // Subscribe to target sport
    this.sendMessage('subscriptions', JSON.stringify({
      subscriptionType: 'OFFER_UPDATE_LIVE_SPORT',
      action: 'SUBSCRIBE',
      sportId: sportId,
      selectedGroupIndices: [0, 0, 0]
    }));

    // Subscribe to individual events
    for (const event of events) {
      this.sendMessage('subscriptions', JSON.stringify({
        subscriptionType: 'SINGLE_EVENT_UPDATE_V2',
        action: 'SUBSCRIBE',
        eventId: event.header.eventId,
        selectedGameGroup: 'all'
      }));

      this.subscribedEvents.add(event.header.eventId);
      console.log(`Subscribed to event ${event.header.eventId}`);
    }

    console.log(`Subscribed to ${events.length} live events`);
  }

  /**
   * Send WebSocket message
   */
  private sendMessage(messageType: string, payload: string): void {
    if (!this.ws || !this.isConnected) {
      console.error('Cannot send message: WebSocket not connected');
      return;
    }

    if (!this.isHandshakeComplete) {
      console.error('Cannot send message: WebSocket handshake not complete');
      return;
    }

    // Properly escape the JSON payload for Socket.IO message
    const escapedPayload = payload.replace(/"/g, '\\"');
    const message = `42["${messageType}","${escapedPayload}"]`;
    console.log(`Sending message: ${message.substring(0, 100)}...`);
    this.ws.send(message);
  }

  /**
   * Start ping timer
   */
  private startPingTimer(): void {
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.isConnected) {
        console.log('Sending ping');
        this.ws.send('2');
      }
    }, this.pingInterval);
  }

  /**
   * Clear ping timer
   */
  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Schedule reconnection
   */
  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(async () => {
      console.log('Attempting to reconnect WebSocket...');
      try {
        await this.connectWebSocket();
        if (this.currentSportId) {
          // Re-subscribe to events
          const events = Array.from(this.subscribedEvents);
          const eventData = events.map(eventId => ({ header: { eventId } as EventData['header'] }));
          await this.subscribeToLiveUpdates(this.currentSportId, eventData as EventData[]);
        }
      } catch (error) {
        console.error('Reconnection failed:', error);
        this.scheduleReconnect(); // Try again
      }
    }, this.RECONNECT_DELAY);
  }

  /**
   * Clear reconnect timer
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Cleanup resources
   */
  public close(): void {
    this.stopLiveExtraction();
  }
}
