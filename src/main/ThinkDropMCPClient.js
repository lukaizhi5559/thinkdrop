/**
 * ThinkDropMCPClient - HTTP client for all ThinkDrop MCP services
 *
 * Maps service names to base URLs and handles the MCP protocol:
 *   POST {baseUrl}/{action}
 *   Body: { version: 'mcp.v1', service, requestId, action, payload }
 *   Response: { success, data, error }
 *
 * Service name → URL mapping is driven by environment variables so
 * any service URL can be changed without touching code.
 */

const http = require('http');
const https = require('https');

class ThinkDropMCPClient {
  /**
   * @param {Object} options
   * @param {Object} [options.serviceUrls] - Override default service URLs
   * @param {Object} [options.apiKeys]     - Per-service API keys (Bearer token)
   * @param {number} [options.timeoutMs]   - Request timeout (default: 10000)
   * @param {Object} [options.logger]      - Logger (default: console)
   */
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.timeoutMs = options.timeoutMs || 10000;

    // Default service URL map — override via env vars or options.serviceUrls
    this.serviceUrls = {
      'conversation':        process.env.MCP_CONVERSATION_URL        || 'http://localhost:3004',
      'user-memory':         process.env.MCP_USER_MEMORY_URL         || 'http://localhost:3001',
      'web-search':          process.env.MCP_WEB_SEARCH_URL          || 'http://localhost:3002',
      'command':             process.env.MCP_COMMAND_URL             || 'http://localhost:3007',
      'screen-intelligence': process.env.MCP_SCREEN_INTELLIGENCE_URL || 'http://localhost:3008',
      'phi4':                process.env.MCP_PHI4_URL                || 'http://localhost:3005',
      'coreference':         process.env.MCP_COREFERENCE_URL         || 'http://localhost:3006',
      ...(options.serviceUrls || {})
    };

    // Per-service API keys (sent as Authorization: Bearer <key>)
    this.apiKeys = {
      'conversation':        process.env.MCP_CONVERSATION_API_KEY        || process.env.MCP_API_KEY || '',
      'user-memory':         process.env.MCP_USER_MEMORY_API_KEY         || process.env.MCP_API_KEY || '',
      'web-search':          process.env.MCP_WEB_SEARCH_API_KEY          || process.env.MCP_API_KEY || '',
      'command':             process.env.MCP_COMMAND_API_KEY             || process.env.MCP_API_KEY || '',
      'screen-intelligence': process.env.MCP_SCREEN_INTELLIGENCE_API_KEY || process.env.MCP_API_KEY || '',
      'phi4':                process.env.MCP_PHI4_API_KEY                || process.env.MCP_API_KEY || '',
      'coreference':         process.env.MCP_COREFERENCE_API_KEY         || process.env.MCP_API_KEY || '',
      ...(options.apiKeys || {})
    };
  }

  /**
   * Call an MCP service action.
   *
   * @param {string} serviceName - e.g. 'conversation', 'user-memory'
   * @param {string} action      - e.g. 'message.add', 'memory.search'
   * @param {Object} payload     - Action-specific parameters
   * @returns {Promise<Object>}  - Response data (unwrapped from MCP envelope)
   */
  async callService(serviceName, action, payload = {}) {
    const baseUrl = this.serviceUrls[serviceName];
    if (!baseUrl) {
      throw new Error(`[MCPClient] Unknown service: "${serviceName}". Add it to serviceUrls.`);
    }

    const url = `${baseUrl}/${action}`;
    const requestId = `mcp_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;

    const body = JSON.stringify({
      version: 'mcp.v1',
      service: serviceName,
      requestId,
      action,
      payload
    });

    const apiKey = this.apiKeys[serviceName];
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    };
    if (apiKey) {
      // conversation-service uses x-api-key; all others use Authorization: Bearer
      if (serviceName === 'conversation') {
        headers['x-api-key'] = apiKey;
      } else {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
    }

    this.logger.debug(`[MCPClient] ${serviceName}.${action} → ${url}`);

    try {
      const responseText = await this._httpPost(url, headers, body);
      const response = JSON.parse(responseText);

      // Handle both MCP response envelope formats:
      //   conversation-service: { success: bool, data, error }
      //   web-search / user-memory: { status: 'ok'|'error', data, error }
      const isFailure =
        response.success === false ||
        response.status === 'error' ||
        (response.error && !response.data && response.success !== true);

      if (isFailure) {
        const errMsg = typeof response.error === 'object'
          ? response.error.message || JSON.stringify(response.error)
          : response.error || `${serviceName}.${action} returned failure`;
        throw new Error(errMsg);
      }

      // Always return the full response — nodes unwrap .data themselves
      return response;

    } catch (error) {
      this.logger.error(`[MCPClient] ${serviceName}.${action} failed:`, error.message);
      throw error;
    }
  }

  /**
   * Check if a service is reachable (lightweight health check).
   * @param {string} serviceName
   * @returns {Promise<boolean>}
   */
  async isServiceHealthy(serviceName) {
    const baseUrl = this.serviceUrls[serviceName];
    if (!baseUrl) return false;

    // Try common health endpoints
    const healthPaths = ['/service.health', '/health'];

    for (const path of healthPaths) {
      try {
        const text = await this._httpGet(`${baseUrl}${path}`);
        const data = JSON.parse(text);
        if (
          data.status === 'up' ||
          data.status === 'healthy' ||
          data.status === 'ok' ||
          data.success === true
        ) {
          return true;
        }
      } catch {
        // try next path
      }
    }
    return false;
  }

  /**
   * Get list of currently healthy services.
   * @returns {Promise<string[]>}
   */
  async getHealthyServices() {
    const serviceNames = Object.keys(this.serviceUrls);
    const results = await Promise.allSettled(
      serviceNames.map(async (name) => ({ name, healthy: await this.isServiceHealthy(name) }))
    );
    return results
      .filter(r => r.status === 'fulfilled' && r.value.healthy)
      .map(r => r.value.name);
  }

  // ─── Internal HTTP helpers ────────────────────────────────────────────────

  _httpPost(url, headers, body) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;

      const req = lib.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + (parsed.search || ''),
          method: 'POST',
          headers
        },
        (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            } else {
              resolve(data);
            }
          });
        }
      );

      req.setTimeout(this.timeoutMs, () => {
        req.destroy();
        reject(new Error(`[MCPClient] Request timeout after ${this.timeoutMs}ms: ${url}`));
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _httpGet(url) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;

      const req = lib.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + (parsed.search || ''),
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        },
        (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => resolve(data));
        }
      );

      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error('health check timeout'));
      });

      req.on('error', reject);
      req.end();
    });
  }
}

module.exports = ThinkDropMCPClient;
