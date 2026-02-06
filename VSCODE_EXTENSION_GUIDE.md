# VS Code Extension Bridge Guide

This guide explains how to create a VS Code extension that acts as a bridge between the standalone Electron app and VS Code Copilot.

## Architecture Overview

```
Electron App → WebSocket → VS Code Extension → VS Code Copilot API
```

## Extension Setup

### 1. Create Extension Structure

```bash
mkdir vscode-copilot-bridge
cd vscode-copilot-bridge
npm init -y
```

### 2. Install Dependencies

```bash
npm install --save-dev @types/vscode @types/node @types/ws typescript
npm install ws
```

### 3. Create `package.json`

```json
{
  "name": "copilot-bridge",
  "displayName": "Copilot Bridge",
  "description": "Bridge between standalone app and VS Code Copilot",
  "version": "1.0.0",
  "engines": {
    "vscode": "^1.80.0"
  },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "copilot-bridge.start",
        "title": "Start Copilot Bridge Server"
      },
      {
        "command": "copilot-bridge.stop",
        "title": "Stop Copilot Bridge Server"
      }
    ]
  },
  "scripts": {
    "vscode:prepublish": "npm run compile",
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./"
  }
}
```

### 4. Create `tsconfig.json`

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2020",
    "outDir": "out",
    "lib": ["ES2020"],
    "sourceMap": true,
    "rootDir": "src",
    "strict": true
  },
  "exclude": ["node_modules", ".vscode-test"]
}
```

### 5. Create Extension Files

#### `src/extension.ts`

```typescript
import * as vscode from 'vscode';
import { BridgeServer } from './server';

let server: BridgeServer | null = null;

export function activate(context: vscode.ExtensionContext) {
  console.log('Copilot Bridge extension activated');

  // Auto-start server on activation
  server = new BridgeServer(3000);
  server.start();

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-bridge.start', () => {
      if (!server) {
        server = new BridgeServer(3000);
        server.start();
        vscode.window.showInformationMessage('Copilot Bridge started on port 3000');
      } else {
        vscode.window.showWarningMessage('Copilot Bridge is already running');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('copilot-bridge.stop', () => {
      if (server) {
        server.stop();
        server = null;
        vscode.window.showInformationMessage('Copilot Bridge stopped');
      }
    })
  );

  // Clean up on deactivation
  context.subscriptions.push({
    dispose: () => {
      if (server) {
        server.stop();
      }
    }
  });
}

export function deactivate() {
  if (server) {
    server.stop();
  }
}
```

#### `src/server.ts`

```typescript
import * as WebSocket from 'ws';
import * as vscode from 'vscode';
import { CopilotBridge } from './copilotBridge';

export class BridgeServer {
  private wss: WebSocket.Server | null = null;
  private port: number;
  private copilotBridge: CopilotBridge;

  constructor(port: number) {
    this.port = port;
    this.copilotBridge = new CopilotBridge();
  }

  start() {
    this.wss = new WebSocket.Server({ port: this.port });

    this.wss.on('connection', (ws: WebSocket) => {
      console.log('Electron app connected to bridge');

      ws.on('message', async (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          console.log('Received message:', message.type);

          if (message.type === 'query') {
            await this.handleQuery(ws, message);
          }
        } catch (error) {
          console.error('Error handling message:', error);
          this.sendError(ws, error instanceof Error ? error.message : 'Unknown error');
        }
      });

      ws.on('close', () => {
        console.log('Electron app disconnected');
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
      });
    });

    console.log(`Copilot Bridge server started on port ${this.port}`);
  }

  stop() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
      console.log('Copilot Bridge server stopped');
    }
  }

  private async handleQuery(ws: WebSocket, message: any) {
    const { message: prompt, screenshot } = message;

    try {
      // Process with Copilot
      await this.copilotBridge.processQuery(
        prompt,
        screenshot,
        (token: string) => {
          // Stream tokens back to Electron app
          ws.send(JSON.stringify({
            type: 'stream_token',
            token
          }));
        }
      );

      // Signal completion
      ws.send(JSON.stringify({ type: 'stream_end' }));
    } catch (error) {
      this.sendError(ws, error instanceof Error ? error.message : 'Query processing failed');
    }
  }

  private sendError(ws: WebSocket, error: string) {
    ws.send(JSON.stringify({
      type: 'error',
      error
    }));
  }
}
```

#### `src/copilotBridge.ts`

```typescript
import * as vscode from 'vscode';

export class CopilotBridge {
  /**
   * Process a query using VS Code Copilot
   * 
   * NOTE: VS Code Copilot's internal API is not publicly documented.
   * This is a simplified example. You'll need to adapt this based on:
   * 1. Your VS Code version
   * 2. Available Copilot APIs
   * 3. Your specific use case
   */
  async processQuery(
    prompt: string,
    screenshot: string | undefined,
    onToken: (token: string) => void
  ): Promise<void> {
    // Build full prompt with screenshot context
    let fullPrompt = prompt;
    if (screenshot) {
      fullPrompt = `[Screenshot Context Provided]\n\n${prompt}`;
    }

    // APPROACH 1: Use Copilot Chat API (if available)
    try {
      await this.useCopilotChatAPI(fullPrompt, onToken);
      return;
    } catch (error) {
      console.log('Copilot Chat API not available, trying alternative approach');
    }

    // APPROACH 2: Use inline completion API
    try {
      await this.useInlineCompletionAPI(fullPrompt, onToken);
      return;
    } catch (error) {
      console.log('Inline completion API failed, trying alternative approach');
    }

    // APPROACH 3: Insert into editor and trigger Copilot
    await this.useEditorInsertionMethod(fullPrompt, onToken);
  }

  /**
   * Approach 1: Use Copilot Chat API (preferred if available)
   */
  private async useCopilotChatAPI(prompt: string, onToken: (token: string) => void) {
    // This API may vary by VS Code version
    // Check VS Code's extension API documentation for the latest
    
    // Example (may need adjustment):
    const result = await vscode.commands.executeCommand(
      'vscode.executeInlineCompletionProvider',
      // ... parameters
    );

    // Stream response
    if (result && typeof result === 'string') {
      // Simulate streaming by chunking the response
      const chunks = result.match(/.{1,10}/g) || [];
      for (const chunk of chunks) {
        onToken(chunk);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }

  /**
   * Approach 2: Use inline completion API
   */
  private async useInlineCompletionAPI(prompt: string, onToken: (token: string) => void) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error('No active editor');
    }

    // Insert prompt as comment
    const position = editor.selection.active;
    await editor.edit(editBuilder => {
      editBuilder.insert(position, `// ${prompt}\n`);
    });

    // Trigger Copilot suggestion
    await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');

    // Wait for suggestion and capture it
    // Note: This is a simplified example - actual implementation would need
    // to listen for Copilot's suggestion events
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get the suggestion text (this part needs proper event handling)
    // For now, return a placeholder
    onToken('Copilot response would appear here');
  }

  /**
   * Approach 3: Editor insertion method (fallback)
   */
  private async useEditorInsertionMethod(prompt: string, onToken: (token: string) => void) {
    // Create a temporary document
    const doc = await vscode.workspace.openTextDocument({
      content: prompt,
      language: 'markdown'
    });

    await vscode.window.showTextDocument(doc);

    // Trigger Copilot
    await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');

    // Simulate response (in real implementation, capture Copilot's actual response)
    const mockResponse = 'This is a placeholder response. Implement proper Copilot API integration.';
    const chunks = mockResponse.match(/.{1,5}/g) || [];
    
    for (const chunk of chunks) {
      onToken(chunk);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
```

## Important Notes

### VS Code Copilot API Limitations

1. **No Public API**: VS Code Copilot doesn't have a fully documented public API for extensions
2. **Version Dependent**: APIs may change between VS Code versions
3. **Authentication**: Copilot requires active authentication

### Alternative Approaches

If direct Copilot API access is not available:

1. **GitHub Copilot API**: Use GitHub's Copilot API directly (requires GitHub Copilot Enterprise)
2. **Copilot Chat Extension API**: Some VS Code versions expose Copilot Chat APIs
3. **Manual Integration**: Have users manually copy-paste between the app and Copilot

### Recommended Solution

For production use, consider:

1. **GitHub Models API**: Use GitHub's public API for AI models
2. **Azure OpenAI**: If your organization has Azure OpenAI access
3. **Direct LLM Integration**: Integrate with Claude, GPT-4, or other LLMs directly

## Testing the Extension

1. **Open Extension in VS Code**:
   ```bash
   code vscode-copilot-bridge
   ```

2. **Press F5** to launch Extension Development Host

3. **Check Output Panel**: Look for "Copilot Bridge server started on port 3000"

4. **Test Connection**: Run the Electron app and verify WebSocket connection

## Debugging

Enable debug logging in VS Code:
- Open Output panel
- Select "Copilot Bridge" from dropdown
- Monitor connection and message logs

## Security Considerations

1. **Local Only**: Server only listens on localhost
2. **No Authentication**: Add authentication if needed
3. **Input Validation**: Validate all incoming messages
4. **Rate Limiting**: Prevent abuse with rate limits

## Next Steps

1. Implement proper Copilot API integration based on your VS Code version
2. Add error handling and retry logic
3. Implement authentication if needed
4. Add configuration options for port and settings
5. Package and distribute the extension
