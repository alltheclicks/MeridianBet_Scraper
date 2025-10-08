import { MeridianbetTokenService, TokenData } from './MeridianbetTokenService';

export interface LeagueData {
  regionId: number;
  regionName: string;
  regionSlug: string;
  leagueId: number;
  leagueName: string;
  leagueSlug: string;
  favoriteLeague: boolean;
  events: EventData[];
}

export interface EventData {
  header: {
    eventId: number;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface MarketData {
  markets: Market[];
  gameTemplateId: number;
  marketName: string;
  priority: number;
  marketType: string;
  hasEarlyPayout: boolean;
  favorite: boolean;
}

export interface Market {
  name: string;
  selections: Selection[];
  marketId: number;
  state: string;
  overUnder?: number;
  handicap?: number;
  isEarlyPayout: boolean;
}

export interface Selection {
  selectionId: string;
  price: number;
  state: string;
  name: string;
}

export interface LeaguesResponse {
  errorCode: string | null;
  parameters: any;
  errorMessages: string[] | null;
  payload: {
    usedTimeFilter: any;
    firstAvailableTimeFilter: any;
    page: number;
    leagues: LeagueData[];
  };
}

export interface MarketsResponse {
  errorCode: string | null;
  parameters: any;
  errorMessages: string[] | null;
  payload: MarketData[];
}

export class MeridianbetDataService {
  private tokenService: MeridianbetTokenService;
  private readonly BASE_URL = 'https://online.meridianbet.com/betshop/api';
  private readonly SPORTS_IDS = {
    football: 58,
    basketball: 55,
    tennis: 56
  };
  
  // Rate limiting delays (in milliseconds)
  private readonly LEAGUE_DELAY = parseInt(process.env.API_LEAGUE_DELAY || '150');
  private readonly MARKET_DELAY = parseInt(process.env.API_MARKET_DELAY || '200');
  private readonly RETRY_DELAY = parseInt(process.env.API_RETRY_DELAY || '150');
  private readonly BATCH_DELAY = parseInt(process.env.API_BATCH_DELAY || '500');
  private readonly EVENT_DELAY = parseInt(process.env.API_EVENT_DELAY || '50');


  constructor(tokenService: MeridianbetTokenService) {
    this.tokenService = tokenService;
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }


  async getLeagues(sport: 'football' | 'basketball' | 'tennis'): Promise<EventData[]> {
    const sportId = this.SPORTS_IDS[sport];
    const allEvents: EventData[] = [];

    console.log(`Fetching leagues for ${sport} (ID: ${sportId})`);

    // Call API 5 times with different pages until we get empty leagues
    for (let page = 0; page < 5; page++) {
      try {
        const tokenData = await this.tokenService.refreshTokenIfNeeded();

        const url = `${this.BASE_URL}/v1/standard/sport/${sportId}/leagues?time=ONE_DAY&page=${page}`;

        console.log(`Fetching page ${page} from: ${url}`);
        
        // Add delay to prevent rate limiting
        await this.delay(this.LEAGUE_DELAY); // Configurable delay between league requests
        
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${tokenData.accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept-Language': 'en'
          }
        });

        if (!response.ok) {
          if (response.status === 401) {
            console.log('Token expired or invalid, refreshing...');
            // Token might be invalid, try to refresh
            const newTokenData = await this.tokenService.refreshTokenIfNeeded();

            // Add delay before retry
            await this.delay(this.RETRY_DELAY); // Configurable delay before retry
            
            // Retry with new token
            const retryResponse = await fetch(url, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${newTokenData.accessToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'en'
              }
            });

            if (!retryResponse.ok) {
              throw new Error(`HTTP error after token refresh! status: ${retryResponse.status}`);
            }

            const retryData: LeaguesResponse = await retryResponse.json();
            this.processLeaguesResponse(retryData, allEvents, page);
            continue;
          } else {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
        }

        const data: LeaguesResponse = await response.json();
        this.processLeaguesResponse(data, allEvents, page);

        // Small delay between requests to avoid rate limiting
        await this.delay(this.LEAGUE_DELAY); // Configurable delay between league page requests

      } catch (error) {
        console.error(`Error fetching page ${page}:`, error);
        // Continue with next page even if one fails
      }
    }

    console.log(`Total events collected: ${allEvents.length}`);
    return allEvents;
  }

  private processLeaguesResponse(data: LeaguesResponse, allEvents: EventData[], page: number): void {
    if (data.errorCode) {
      throw new Error(`API error: ${data.errorCode} - ${data.errorMessages?.join(', ')}`);
    }

    console.log(`Page ${page}: Found ${data.payload.leagues.length} leagues`);

    // Extract events from all leagues
    data.payload.leagues.forEach(league => {
      if (league.events && league.events.length > 0) {
        allEvents.push(...league.events);
      }
    });

    // If no leagues found, break the loop
    if (data.payload.leagues.length === 0) {
      console.log(`No more leagues found on page ${page}, stopping pagination`);
    }
  }

  async getEventMarkets(eventId: number): Promise<MarketData[]> {
    try {
      const tokenData = await this.tokenService.refreshTokenIfNeeded();

      const url = `${this.BASE_URL}/v2/events/${eventId}/markets?gameGroupId=all`;

      console.log(`Fetching markets for event ${eventId} from URL: ${url}`);

      // Add delay to prevent rate limiting
      await this.delay(this.MARKET_DELAY); // Configurable delay between market requests

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${tokenData.accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept-Language': 'en'
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          console.log(`Token expired for event ${eventId}, coordinating refresh...`);
        // Use coordinated token refresh to prevent multiple concurrent refreshes
        const newTokenData = await this.tokenService.waitForTokenRefresh();
          
          console.log(`New token obtained for event ${eventId}: ${newTokenData.accessToken.substring(0, 20)}...`);
          
          // Add delay before retry
          await this.delay(this.RETRY_DELAY); // Configurable delay before retry
          
          // Retry with new token
          const retryResponse = await fetch(url, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${newTokenData.accessToken}`,
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept-Language': 'en'
            }
          });

          console.log(`Retry response status for event ${eventId}: ${retryResponse.status}`);

          if (!retryResponse.ok) {
            console.error(`Token refresh failed for event ${eventId}. Status: ${retryResponse.status}`);
            console.log('This might indicate the refresh token is also expired or invalid');
            throw new Error(`HTTP error after token refresh! status: ${retryResponse.status}`);
          }

          const retryData: MarketsResponse = await retryResponse.json();

          if (retryData.errorCode) {
            throw new Error(`API error: ${retryData.errorCode} - ${retryData.errorMessages?.join(', ')}`);
          }

          console.log(`Found ${retryData.payload.length} market groups for event ${eventId} (retry)`);
          return retryData.payload;
        } else {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
      }

      const data: MarketsResponse = await response.json();

      if (data.errorCode) {
        throw new Error(`API error: ${data.errorCode} - ${data.errorMessages?.join(', ')}`);
      }

      console.log(`Found ${data.payload.length} market groups for event ${eventId}`);
      return data.payload;

    } catch (error) {
      console.error(`Error fetching markets for event ${eventId}:`, error);
      return [];
    }
  }

  async getAllEventMarkets(eventIds: number[]): Promise<Map<number, MarketData[]>> {
    const eventMarkets = new Map<number, MarketData[]>();

    console.log(`Fetching markets for ${eventIds.length} events`);

    // Process events in batches to avoid overwhelming the API
    const batchSize = 5;
    for (let i = 0; i < eventIds.length; i += batchSize) {
      const batch = eventIds.slice(i, i + batchSize);

      console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(eventIds.length / batchSize)}`);

      // Process batch concurrently
      const promises = batch.map(async (eventId, index) => {
        // Add small delay between events within batch
        if (index > 0) {
          await this.delay(this.EVENT_DELAY); // Configurable delay between events in same batch
        }
        
        const markets = await this.getEventMarkets(eventId);
        if (markets.length > 0) {
          eventMarkets.set(eventId, markets);
        }
        return { eventId, markets };
      });

      await Promise.all(promises);

      // Small delay between batches
      await this.delay(this.BATCH_DELAY); // Configurable delay between batches
    }

    console.log(`Successfully fetched markets for ${eventMarkets.size} events`);
    return eventMarkets;
  }

  async extractPreGameData(sport: 'football' | 'basketball' | 'tennis'): Promise<{
    events: EventData[];
    markets: Map<number, MarketData[]>;
    summary: {
      totalEvents: number;
      totalMarkets: number;
      sport: string;
      extractedAt: Date;
    };
  }> {
    console.log(`Starting pre-game data extraction for ${sport}`);

    // Step 1: Get all events from leagues
    const events = await this.getLeagues(sport);

    if (events.length === 0) {
      console.log(`No events found for ${sport}`);
      return {
        events: [],
        markets: new Map(),
        summary: {
          totalEvents: 0,
          totalMarkets: 0,
          sport,
          extractedAt: new Date()
        }
      };
    }

    // Step 2: Extract event IDs
    const eventIds = events.map(event => event.header.eventId);
    console.log(`Extracted ${eventIds.length} event IDs`);
    console.log(`Sample event IDs: ${eventIds.slice(0, 5).join(', ')}`);

    // Step 3: Get markets for all events
    console.log('Starting market extraction...');
    const markets = await this.getAllEventMarkets(eventIds);
    console.log(`Market extraction completed. Map size: ${markets.size}`);

    // Step 4: Calculate summary
    const totalMarkets = Array.from(markets.values()).reduce((sum, marketList) => {
      return sum + marketList.reduce((marketSum, market) => marketSum + market.markets.length, 0);
    }, 0);

    const summary = {
      totalEvents: events.length,
      totalMarkets,
      sport,
      extractedAt: new Date()
    };

    console.log(`Pre-game data extraction completed:`, summary);

    return {
      events,
      markets,
      summary
    };
  }
}
