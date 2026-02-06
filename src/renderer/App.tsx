import { useEffect } from 'react';
import StandalonePromptCapture from './components/StandalonePromptCapture';
import ResultsWindow from './components/ResultsWindow';
import { getVSCodeBridge } from './services/vscodebridge';

function App() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');

  useEffect(() => {
    console.log('App loaded with mode:', mode);
    
    // Initialize VS Code Bridge connection
    const initBridge = async () => {
      try {
        const bridge = getVSCodeBridge({
          serverUrl: 'ws://127.0.0.1:17373',
          onMessage: (message) => {
            console.log('Bridge message:', message);
          },
          onStreamToken: (token) => {
            console.log('Bridge token:', token);
          },
          onError: (error) => {
            console.error('Bridge error:', error);
          },
        });
        
        await bridge.connect();
        console.log('✅ VS Code Bridge connected');
      } catch (error) {
        console.error('❌ Failed to connect to VS Code Bridge:', error);
        console.log('ℹ️  Make sure the VS Code extension is running');
      }
    };
    
    initBridge();
  }, [mode]);

  if (mode === 'promptcapture') {
    return <StandalonePromptCapture />;
  }

  if (mode === 'results') {
    return <ResultsWindow />;
  }

  return (
    <div className="w-full h-full flex items-center justify-center bg-gray-900 text-white">
      <p>Invalid mode. Use ?mode=promptcapture or ?mode=results</p>
    </div>
  );
}

export default App;
