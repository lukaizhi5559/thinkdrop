/**
 * VS Code Extension Bridge Service
 * 
 * Communicates with VS Code extension via WebSocket/HTTP
 * The extension acts as a bridge to VS Code Copilot
 */

export interface BridgeConfig {
  serverUrl: string;
  onMessage?: (message: any) => void;
  onStreamToken?: (token: string) => void;
  onError?: (error: string) => void;
}

export class VSCodeBridge {
  private ws: WebSocket | null = null;
  public config: BridgeConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 2000;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        console.log('🔌 [BRIDGE] Connecting to VS Code extension:', this.config.serverUrl);
        
        this.ws = new WebSocket(this.config.serverUrl);

        this.ws.onopen = () => {
          console.log('✅ [BRIDGE] Connected to VS Code extension');
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            console.log('📨 [BRIDGE] Message received:', message);
            this.handleMessage(message);
          } catch (error) {
            console.error('❌ [BRIDGE] Failed to parse message:', error);
          }
        };

        this.ws.onerror = (error) => {
          console.error('❌ [BRIDGE] WebSocket error:', error);
          this.config.onError?.('Connection error');
        };

        this.ws.onclose = () => {
          console.log('🔌 [BRIDGE] Disconnected from VS Code extension');
          this.ws = null;
          this.attemptReconnect();
        };

        setTimeout(() => {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            reject(new Error('Connection timeout'));
          }
        }, 5000);

      } catch (error) {
        console.error('❌ [BRIDGE] Connection failed:', error);
        reject(error);
      }
    });
  }

  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('❌ [BRIDGE] Max reconnection attempts reached');
      this.config.onError?.('Failed to reconnect to VS Code extension');
      return;
    }

    this.reconnectAttempts++;
    console.log(`🔄 [BRIDGE] Reconnecting... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    setTimeout(() => {
      this.connect().catch(err => {
        console.error('❌ [BRIDGE] Reconnection failed:', err);
      });
    }, this.reconnectDelay);
  }

  private handleMessage(message: any) {
    switch (message.type) {
      case 'stream_token':
        this.config.onStreamToken?.(message.token);
        break;
      
      case 'stream_end':
        this.config.onMessage?.({ type: 'stream_end' });
        break;
      
      case 'error':
        this.config.onError?.(message.error);
        break;
      
      default:
        this.config.onMessage?.(message);
    }
  }

  async sendMessage(message: string, screenshot?: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to VS Code extension');
    }

    const payload = {
      type: 'query',
      message,
      screenshot,
      timestamp: Date.now(),
    };

    console.log('📤 [BRIDGE] Sending message to VS Code extension');
    this.ws.send(JSON.stringify(payload));
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

let bridgeInstance: VSCodeBridge | null = null;

export function getVSCodeBridge(config?: BridgeConfig): VSCodeBridge {
  if (!bridgeInstance && config) {
    bridgeInstance = new VSCodeBridge(config);
  }
  if (!bridgeInstance) {
    throw new Error('VSCodeBridge not initialized');
  }
  return bridgeInstance;
}

export function hasBridge(): boolean {
  return bridgeInstance !== null;
}
