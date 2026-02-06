# Setup Guide

Quick start guide for the Standalone Copilot Screen Assistant.

## Prerequisites

- Node.js 18+ and npm
- VS Code with Copilot extension installed
- macOS (for screen capture permissions)

## Installation

### 1. Install Electron App Dependencies

```bash
cd standalone-copilot-app
npm install
```

### 2. Set Up VS Code Extension

Follow the detailed guide in [`VSCODE_EXTENSION_GUIDE.md`](./VSCODE_EXTENSION_GUIDE.md) to create the bridge extension.

Quick summary:
```bash
# Create extension
mkdir ../vscode-copilot-bridge
cd ../vscode-copilot-bridge

# Copy extension code from guide
# Then compile and run
npm install
npm run compile
```

### 3. Grant Permissions (macOS)

The app needs screen recording permission:

1. Open **System Preferences** → **Security & Privacy** → **Privacy**
2. Select **Screen Recording** from the left sidebar
3. Click the lock icon to make changes
4. Add the Electron app when prompted

## Running the App

### Development Mode

1. **Start VS Code Extension**:
   - Open the extension folder in VS Code
   - Press `F5` to launch Extension Development Host
   - Verify "Copilot Bridge started on port 3000" in Output panel

2. **Start Electron App**:
   ```bash
   cd standalone-copilot-app
   npm run dev
   ```

3. **Test the Connection**:
   - Press `Cmd+Shift+Space` to open prompt window
   - Type a question and press Enter
   - Check console for connection status

### Production Build

```bash
npm run build
```

The built app will be in the `dist/` folder.

## Usage

1. **Open Prompt Window**: Press `Cmd+Shift+Space`
2. **Add Context**: Highlight text anywhere and press `Cmd+C` to add as context tag
3. **Ask Question**: Type your question in the prompt box
4. **Submit**: Press Enter (screenshot is automatically captured)
5. **View Results**: Results window appears with streaming response
6. **Close**: Press `Esc` or click the × button

## Troubleshooting

### "Connection Failed" Error

**Problem**: Cannot connect to VS Code extension

**Solutions**:
- Ensure VS Code extension is running (check Output panel)
- Verify WebSocket server is on port 3000
- Check firewall settings
- Restart both the extension and Electron app

### No Response from Copilot

**Problem**: Query sent but no response received

**Solutions**:
- Verify VS Code Copilot is active and authenticated
- Check VS Code extension logs for errors
- Ensure Copilot has necessary permissions
- Try a simpler query first

### Screenshot Not Captured

**Problem**: Screenshot capture fails

**Solutions**:
- Grant screen recording permission (see step 3 above)
- Restart the Electron app after granting permission
- Check console for specific error messages

### Extension Not Starting

**Problem**: VS Code extension fails to activate

**Solutions**:
- Check VS Code version compatibility (requires 1.80+)
- Review extension logs in Output panel
- Reinstall extension dependencies: `npm install`
- Rebuild extension: `npm run compile`

## Configuration

### Change WebSocket Port

Edit `src/renderer/App.tsx`:
```typescript
const bridge = getVSCodeBridge({
  serverUrl: 'ws://localhost:YOUR_PORT', // Change port here
  // ...
});
```

Also update the VS Code extension's `src/server.ts`:
```typescript
constructor(port: number) {
  this.port = YOUR_PORT; // Match the port
}
```

### Adjust Window Sizes

Edit `src/main/main.js`:
```javascript
// Prompt window size
const windowWidth = 500;  // Change width
const windowHeight = 120; // Change height

// Results window size
const windowMinWidth = 400;  // Change min width
const windowMaxHeight = 800; // Change max height
```

## Development Tips

### Hot Reload

The app supports hot reload in development mode:
- Renderer changes: Automatic reload
- Main process changes: Restart with `Cmd+R` in Electron window

### Debug Mode

Enable debug logging:
```bash
NODE_ENV=development npm run dev
```

Check console in:
- Electron app: Built-in DevTools (auto-opens in dev mode)
- VS Code extension: Output panel → "Copilot Bridge"

### Testing Without Extension

For testing UI without the extension:
1. Comment out bridge connection in `App.tsx`
2. Mock responses in `ResultsWindow.tsx`
3. Test UI interactions

## Next Steps

- Customize UI styling in `src/renderer/index.css`
- Add additional keyboard shortcuts in `src/main/main.js`
- Implement error recovery and retry logic
- Add user preferences and settings
- Package for distribution

## Support

For issues and questions:
- Check console logs for error messages
- Review VS Code extension Output panel
- Verify all prerequisites are met
- Test with a minimal query first
