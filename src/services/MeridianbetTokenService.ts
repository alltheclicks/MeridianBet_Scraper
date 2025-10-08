import { chromium, Browser, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import moment from 'moment';
import * as CryptoJS from 'crypto-js';

export interface TokenData {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  extractedAt: Date;
}

export class MeridianbetTokenService {
  private browser: Browser | null = null;
  private tokenData: TokenData | null = null;
  private readonly MERIDIANBET_URL = process.env.MERIDIANBET_URL || 'https://meridianbet.rs/en/betting/football';
  private readonly HEADLESS = process.env.PLAYWRIGHT_HEADLESS === 'true';
  private readonly TIMEOUT = parseInt(process.env.PLAYWRIGHT_TIMEOUT || '30000');
  private readonly BLOCK_MEDIA = process.env.PLAYWRIGHT_BLOCK_MEDIA !== 'false';
  private readonly TOKEN_FILE_PATH = path.join(process.cwd(), 'tokens.json');
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly REFRESH_INTERVAL = parseInt(process.env.TOKEN_REFRESH_INTERVAL || '840000'); // 14 minutes default
  private refreshInProgress = false;
  private refreshPromise: Promise<TokenData> | null = null;
  private clientId: string | null = null;
  private clientName: string | null = null;

  async initialize(): Promise<void> {
    try {
      this.browser = await chromium.launch({
        headless: this.HEADLESS,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      });
      console.log(`Playwright browser initialized successfully (headless: ${this.HEADLESS})`);
      
      // Try to load existing tokens
      await this.loadTokensFromFile();
      
      // Start automatic token refresh if we have tokens
      if (this.tokenData) {
        this.startAutomaticRefresh();
      }
    } catch (error) {
      console.error('Failed to initialize Playwright browser:', error);
      throw error;
    }
  }

  startAutomaticRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    console.log(`Starting automatic token refresh every ${this.REFRESH_INTERVAL / 1000 / 60} minutes`);
    
    this.refreshTimer = setInterval(async () => {
      try {
        console.log('Automatic token refresh triggered...');
        await this.refreshTokenIfNeeded();
        console.log('Automatic token refresh completed successfully');
      } catch (error) {
        console.error('Automatic token refresh failed:', error);
      }
    }, this.REFRESH_INTERVAL);
  }

  stopAutomaticRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      console.log('Automatic token refresh stopped');
    }
  }

  private async saveTokensToFile(): Promise<void> {
    try {
      if (this.tokenData) {
        const tokenDataToSave = {
          ...this.tokenData,
          expiresAt: this.tokenData.expiresAt.toISOString(),
          extractedAt: this.tokenData.extractedAt.toISOString()
        };
        
        await fs.promises.writeFile(
          this.TOKEN_FILE_PATH, 
          JSON.stringify(tokenDataToSave, null, 2),
          'utf8'
        );
        console.log('Tokens saved to file successfully');
      }
    } catch (error) {
      console.error('Failed to save tokens to file:', error);
    }
  }

  async loadTokensFromFile(): Promise<boolean> {
    try {
      if (fs.existsSync(this.TOKEN_FILE_PATH)) {
        const fileContent = await fs.promises.readFile(this.TOKEN_FILE_PATH, 'utf8');
        const tokenData = JSON.parse(fileContent);
        
        this.tokenData = {
          ...tokenData,
          expiresAt: new Date(tokenData.expiresAt),
          extractedAt: new Date(tokenData.extractedAt)
        };
        
        console.log('Tokens loaded from file successfully');
        if (this.tokenData) {
          console.log(`Token expires at: ${this.tokenData.expiresAt.toLocaleString()}`);
        }
        
        return true;
      } else {
        console.log('No token file found, will extract new tokens');
        return false;
      }
    } catch (error) {
      console.error('Failed to load tokens from file:', error);
      return false;
    }
  }

  async refreshTokenUsingRefreshToken(): Promise<TokenData | null> {
    if (!this.tokenData?.refreshToken) {
      console.log('No refresh token available');
      return null;
    }

    try {
      console.log('Attempting to refresh token using refresh token...');
      
      // Create form data for the refresh token request
      const formData = new URLSearchParams();
      formData.append('grant_type', 'refresh_token');
      formData.append('refresh_token', this.tokenData.refreshToken);
      formData.append('locale', 'en');

      // Generate dynamic Authorization header
      const authHeader = this.generateAuthorizationHeader();
      
      const response = await fetch('https://auth.meridianbet.com/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': authHeader
        },
        body: formData.toString()
      });

      console.log(`Refresh token response status: ${response.status}`);

      if (response.ok) {
        const data = await response.json();
        
        this.tokenData = {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: new Date(data.expires_at),
          extractedAt: new Date()
        };

        await this.saveTokensToFile();
        console.log('Token refreshed successfully using refresh token');
        console.log(`New token expires at: ${this.tokenData.expiresAt.toLocaleString()}`);
        
        // Ensure automatic refresh is running
        this.startAutomaticRefresh();
        
        return this.tokenData;
      } else {
        const errorText = await response.text();
        console.log(`Refresh token API failed with status ${response.status}: ${errorText}`);
        console.log('Falling back to Playwright extraction...');
        return null;
      }
    } catch (error) {
      console.error('Error refreshing token:', error);
      return null;
    }
  }

  private async extractClientInfo(page: Page): Promise<void> {
    try {
      console.log('Extracting CLIENT_ID and CLIENT_NAME from page...');
      
      const clientInfo = await page.evaluate(() => {
        // Look for the script tag containing CLIENT_ID and CLIENT_NAME
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
          const content = script.textContent || '';
          if (content.includes('CLIENT_ID') && content.includes('CLIENT_NAME')) {
            // Extract CLIENT_ID and CLIENT_NAME using regex
            const clientIdMatch = content.match(/var CLIENT_ID = "([^"]+)"/);
            const clientNameMatch = content.match(/var CLIENT_NAME = "([^"]+)"/);
            
            if (clientIdMatch && clientNameMatch) {
              return {
                clientId: clientIdMatch[1],
                clientName: clientNameMatch[1]
              };
            }
          }
        }
        return null;
      });

      if (clientInfo) {
        this.clientId = clientInfo.clientId;
        this.clientName = clientInfo.clientName;
        console.log('Extracted CLIENT_ID:', this.clientId);
        console.log('Extracted CLIENT_NAME:', this.clientName);
      } else {
        console.log('Could not extract CLIENT_ID and CLIENT_NAME from page');
      }
    } catch (error) {
      console.error('Error extracting client info:', error);
    }
  }

  private prepareClientId(): string {
    if (!this.clientId) {
      throw new Error('CLIENT_ID not available');
    }
    
    // Generate timestamp in YYYYMMDDHH format
    const timestamp = moment().utc().format('YYYYMMDDHH');
    
    // Create the string to hash: CLIENT_ID + timestamp
    const stringToHash = this.clientId + timestamp;
    
    // Generate SHA512 hash
    const hash = CryptoJS.SHA512(stringToHash).toString();
    
    console.log('Prepared client ID:', hash.substring(0, 20) + '...');
    return hash;
  }

  private generateAuthorizationHeader(): string {
    if (!this.clientName) {
      throw new Error('CLIENT_NAME not available');
    }
    
    const preparedClientId = this.prepareClientId();
    const credentials = `${this.clientName}:${preparedClientId}`;
    const encoded = Buffer.from(credentials).toString('base64');
    
    console.log('Generated Authorization header:', `Basic ${encoded.substring(0, 20)}...`);
    return `Basic ${encoded}`;
  }

  async extractAccessToken(): Promise<TokenData> {
    if (!this.browser) {
      await this.initialize();
    }

    if (!this.browser) {
      throw new Error('Browser not initialized');
    }

    const context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US'
    });

    // Block media files if configured
    if (this.BLOCK_MEDIA) {
      await context.route('**/*', (route) => {
        const resourceType = route.request().resourceType();
        const url = route.request().url();
        
        // Block media files
        if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
          route.abort();
        } else {
          route.continue();
        }
      });
      
      console.log('Media blocking enabled - images, videos, fonts, and stylesheets will be blocked');
    }

    const page = await context.newPage();

    try {
      console.log('Navigating to Meridianbet...');
      
      // Navigate to the Meridianbet page
      await page.goto(this.MERIDIANBET_URL, {
        waitUntil: 'domcontentloaded',
        timeout: this.TIMEOUT
      });

      // Wait for 25 seconds instead of networkidle
      await page.waitForTimeout(20000);

      console.log('Page loaded, waiting for cookies...');
      
      // Wait a bit for any dynamic content and cookies to load
      await page.waitForTimeout(5000);

      // Extract CLIENT_ID and CLIENT_NAME from page
      await this.extractClientInfo(page);

      // Get all cookies
      const cookies = await context.cookies();
      console.log('Retrieved cookies:', cookies.length);

      // Look for specific cookie names
      const accessTokenCookie = cookies.find(cookie => cookie.name === 'access_token');
      const refreshTokenCookie = cookies.find(cookie => cookie.name === 'refresh_token');
      const expiresAtCookie = cookies.find(cookie => cookie.name === 'expires_at');

      if (accessTokenCookie) {
        console.log('Found access_token cookie:', accessTokenCookie.value);
        console.log('Found refresh_token cookie:', refreshTokenCookie?.value || 'Not found');
        console.log('Found expires_at cookie:', expiresAtCookie?.value || 'Not found');
        
        // Extract expiry time from expires_at cookie
        let expiresAt: Date;
        let accessToken: string = accessTokenCookie.value;
        
        if (expiresAtCookie) {
          console.log('Found expires_at cookie:', expiresAtCookie.value);
          // expires_at contains the actual expiry time in milliseconds
          const expiresAtMs = parseInt(expiresAtCookie.value);
          if (!isNaN(expiresAtMs)) {
            expiresAt = new Date(expiresAtMs);
            console.log('Using expires_at from cookie:', expiresAt);
          } else {
            console.log('Invalid expires_at value, falling back to cookie.expires');
            expiresAt = new Date(accessTokenCookie.expires * 1000);
          }
        } else {
          // Fallback to cookie.expires if no expires_at cookie found
          // Cookie expires is in epoch seconds, convert to milliseconds for Date constructor
          expiresAt = new Date(accessTokenCookie.expires * 1000);
          console.log(`No expires_at cookie found, using cookie.expires (${accessTokenCookie.expires}):`, expiresAt);
        }
        
        this.tokenData = {
          accessToken: accessToken,
          refreshToken: refreshTokenCookie?.value,
          expiresAt: expiresAt,
          extractedAt: new Date()
        };

        console.log(`Access token extracted successfully: ${accessToken.substring(0, 20)}...`);
        
        if (refreshTokenCookie) {
          console.log(`Refresh token also extracted: ${refreshTokenCookie.value}`);
        } else {
          console.log('No refresh token found in cookies');
        }

        // Save tokens to file
        await this.saveTokensToFile();
        
        // Start automatic refresh
        this.startAutomaticRefresh();
        
        return this.tokenData;
      }

      // If no access token cookie found, log error
      console.log('No access token cookie found');

      // If still no token found, try to extract from network requests
      console.log('No token found in cookies, monitoring network requests...');
      
      const networkRequests: string[] = [];
      
      page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('api') || url.includes('auth') || url.includes('token')) {
          try {
            const headers = response.headers();
            const authorization = headers['authorization'] || headers['Authorization'];
            if (authorization) {
              networkRequests.push(authorization);
            }
          } catch (error) {
            // Ignore errors when reading response headers
          }
        }
      });

      // Wait a bit more for any API calls
      await page.waitForTimeout(10000);

      if (networkRequests.length > 0) {
        const token = networkRequests[0].replace('Bearer ', '').replace('bearer ', '');
        console.log('Found access token in network requests');
        
        this.tokenData = {
          accessToken: token,
          refreshToken: undefined, // Network requests typically don't contain refresh tokens
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // Assume 24 hours expiry
          extractedAt: new Date()
        };

        console.log('Note: Refresh token not available from network requests');
        return this.tokenData;
      }

      throw new Error('No access token found in cookies, localStorage, or network requests');

    } catch (error) {
      console.error('Error extracting access token:', error);
      throw error;
    } finally {
      await context.close();
    }
  }

  getCurrentToken(): TokenData | null {
    return this.tokenData;
  }

  isTokenValid(): boolean {
    if (!this.tokenData) {
      return false;
    }
    
    const now = new Date();
    const timeUntilExpiry = this.tokenData.expiresAt.getTime() - now.getTime();
    
    // Consider token invalid if it expires within the next 5 minutes
    return timeUntilExpiry > 5 * 60 * 1000;
  }

  async refreshTokenIfNeeded(): Promise<TokenData> {
    if (this.isTokenValid()) {
      return this.tokenData!;
    }

    // If refresh is already in progress, wait for it
    if (this.refreshInProgress && this.refreshPromise) {
      console.log('Token refresh already in progress, waiting...');
      return await this.refreshPromise;
    }

    // Start new refresh
    this.refreshInProgress = true;
    this.refreshPromise = this.performTokenRefresh();

    try {
      const result = await this.refreshPromise;
      return result;
    } finally {
      this.refreshInProgress = false;
      this.refreshPromise = null;
    }
  }

  private async performTokenRefresh(): Promise<TokenData> {
    console.log('Token expired or not found, attempting refresh...');
    
    // First try to refresh using refresh token
    const refreshedToken = await this.refreshTokenUsingRefreshToken();
    if (refreshedToken) {
      return refreshedToken;
    }

    // If refresh token fails, extract new token using Playwright
    console.log('Refresh token failed, extracting new token using Playwright...');
    return await this.extractAccessToken();
  }

  // Method for other services to wait for token refresh completion
  async waitForTokenRefresh(): Promise<TokenData> {
    if (this.refreshInProgress && this.refreshPromise) {
      console.log('Waiting for ongoing token refresh to complete...');
      return await this.refreshPromise;
    }
    
    // If no refresh in progress, return current token or trigger refresh
    return await this.refreshTokenIfNeeded();
  }

  async close(): Promise<void> {
    // Stop automatic refresh timer
    this.stopAutomaticRefresh();
    
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
