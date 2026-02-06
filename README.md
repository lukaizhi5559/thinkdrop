# Standalone Copilot Screen Assistant

A lightweight Electron app that communicates with VS Code Copilot via a VS Code extension bridge. This app provides a screen capture interface that sends screenshots and prompts to VS Code Copilot for processing.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Standalone Electron App                       │
│                                                                   │
│  ┌──────────────────────┐        ┌──────────────────────┐      │
│  │ StandalonePrompt     │        │   ResultsWindow      │      │
│  │ Capture              │        │                      │      │
│  │                      │        │  - Streaming         │      │
│  │ - Text input         │        │  - Markdown render   │      │
│  │ - Highlight tags     │        │  - Code highlighting │      │
│  │ - Screenshot capture │        │                      │      │
│  └──────────┬───────────┘        └──────────▲───────────┘      │
│             │                               │                    │
│             │                               │                    │
│             │      ┌────────────────────────┘                    │
│             │      │                                             │
│             └──────▼──────────────────────┐                     │
│                VSCodeBridge Service        │                     │
│                (WebSocket Client)          │                     │
│                                            │                     │
└────────────────────────┬───────────────────┴─────────────────────┘
                         │
                         │ WebSocket (ws://localhost:3000)
                         │
┌────────────────────────▼───────────────────────────────────────┐
│                  VS Code Extension Bridge                       │
│                                                                  │
│  - Receives: { message, screenshot, timestamp }                │
│  - Sends: { type: 'stream_token', token: '...' }              │
│  - Sends: { type: 'stream_end' }                              │
│  - Sends: { type: 'error', error: '...' }                     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │         VS Code Copilot API (Internal)                   │ │
│  │                                                            │ │
│  │  - Processes screenshot + prompt                          │ │
│  │  - Streams response back to extension                     │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

## Features

- **Screen Capture**: Automatically captures screenshots when submitting prompts
- **Text Highlighting**: Select text and press `Cmd+C` to add as context tags
- **Streaming Responses**: Real-time streaming of Copilot responses
- **Markdown Rendering**: Full markdown support with code syntax highlighting
- **Draggable Windows**: Both prompt and results windows are draggable
- **Global Hotkey**: `Cmd+Shift+Space` to show/hide prompt window

## Setup

### 1. Install Dependencies

```bash
cd standalone-copilot-app
npm install
```

### 2. VS Code Extension Bridge Setup

You need to create a VS Code extension that acts as a bridge to Copilot. The extension should:

1. **Start a WebSocket server** on `ws://localhost:3000`
2. **Listen for messages** from the Electron app:
   ```typescript
   interface IncomingMessage {
     type: 'query';
     message: string;
     screenshot?: string; // base64 encoded PNG
     timestamp: number;
   }
   ```

3. **Forward to VS Code Copilot** using the internal API:
   ```typescript
   // Example using VS Code's internal Copilot API
   const response = await vscode.commands.executeCommand(
     'vscode.executeInlineCompletionProvider',
     document.uri,
     position,
     {
       triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
       selectedCompletionInfo: undefined
     }
   );
   ```

4. **Stream responses back** to the Electron app:
   ```typescript
   // Send tokens as they arrive
   ws.send(JSON.stringify({
     type: 'stream_token',
     token: 'partial response text'
   }));
   
   // Signal completion
   ws.send(JSON.stringify({
     type: 'stream_end'
   }));
   
   // Send errors
   ws.send(JSON.stringify({
     type: 'error',
     error: 'Error message'
   }));
   ```

### 3. Extension Example Structure

Create a VS Code extension with this structure:

```
vscode-copilot-bridge/
├── package.json
├── src/
│   ├── extension.ts          # Main extension entry
│   ├── server.ts             # WebSocket server
│   └── copilotBridge.ts      # Copilot API integration
```

**extension.ts**:
```typescript
import * as vscode from 'vscode';
import { startBridgeServer } from './server';

export function activate(context: vscode.ExtensionContext) {
  console.log('Copilot Bridge extension activated');
  
  // Start WebSocket server
  const server = startBridgeServer(3000);
  
  context.subscriptions.push({
    dispose: () => server.close()
  });
}
```

**server.ts**:
```typescript
import WebSocket from 'ws';
import { processCopilotQuery } from './copilotBridge';

export function startBridgeServer(port: number) {
  const wss = new WebSocket.Server({ port });
  
  wss.on('connection', (ws) => {
    console.log('Electron app connected');
    
    ws.on('message', async (data) => {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'query') {
        try {
          // Process with Copilot
          await processCopilotQuery(
            message.message,
            message.screenshot,
            (token) => {
              // Stream tokens back
              ws.send(JSON.stringify({
                type: 'stream_token',
                token
              }));
            }
          );
          
          // Signal completion
          ws.send(JSON.stringify({ type: 'stream_end' }));
        } catch (error) {
          ws.send(JSON.stringify({
            type: 'error',
            error: error.message
          }));
        }
      }
    });
  });
  
  return wss;
}
```

**copilotBridge.ts**:
```typescript
import * as vscode from 'vscode';

export async function processCopilotQuery(
  prompt: string,
  screenshot: string | undefined,
  onToken: (token: string) => void
) {
  // Build the full prompt with screenshot context
  let fullPrompt = prompt;
  if (screenshot) {
    fullPrompt = `[Screenshot attached]\n\n${prompt}`;
  }
  
  // Use VS Code's Copilot API (internal - may vary by version)
  // This is a simplified example - actual implementation depends on
  // VS Code's internal Copilot API which is not publicly documented
  
  // Alternative: Use GitHub Copilot Chat API if available
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    // Insert prompt and trigger Copilot
    // Stream response back via onToken callback
  }
}
```

## Development

### Run the Electron App

```bash
npm run dev
```

This starts:
- Vite dev server on `http://localhost:5173`
- Electron app with hot reload

### Build for Production

```bash
npm run build
```

This creates a distributable app in the `dist/` folder.

## Usage

1. **Start the VS Code extension** (ensure WebSocket server is running on port 3000)
2. **Launch the Electron app**: `npm run dev`
3. **Press `Cmd+Shift+Space`** to open the prompt window
4. **Type your question** or **highlight text** and press `Cmd+C` to add context
5. **Press Enter** to submit (screenshot is automatically captured)
6. **View results** in the results window that appears

## Configuration

Edit `src/renderer/services/vscodebridge.ts` to change the WebSocket URL:

```typescript
const bridge = getVSCodeBridge({
  serverUrl: 'ws://localhost:3000', // Change port if needed
  onMessage: (message) => { /* ... */ },
  onStreamToken: (token) => { /* ... */ },
  onError: (error) => { /* ... */ }
});
```

## Keyboard Shortcuts

- `Cmd+Shift+Space`: Show/hide prompt window
- `Enter`: Submit prompt
- `Shift+Enter`: New line in prompt
- `Esc`: Close prompt/results windows
- `Cmd+C` (with text selected): Add highlighted text as context tag

## Troubleshooting

### Connection Failed
- Ensure VS Code extension is running
- Check WebSocket server is on port 3000
- Look for errors in VS Code Output panel

### No Response from Copilot
- Verify VS Code Copilot is active and authenticated
- Check VS Code extension logs
- Ensure Copilot has necessary permissions

### Screenshot Not Captured
- Grant screen recording permissions to Electron app
- On macOS: System Preferences → Security & Privacy → Screen Recording

## Technical Stack

- **Electron 28**: Desktop app framework
- **React 18**: UI framework
- **TypeScript**: Type safety
- **Vite**: Fast build tool
- **TailwindCSS**: Styling
- **React Markdown**: Markdown rendering
- **React Syntax Highlighter**: Code highlighting

## License

MIT
