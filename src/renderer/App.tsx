import VoiceCompanion from './components/VoiceCompanion';
import { UnifiedOverlay } from './components/UnifiedOverlay';

function App() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');

  if (mode === 'unified') {
    return <UnifiedOverlay />;
  }

  if (mode === 'voice-companion') {
    return <VoiceCompanion />;
  }

  if (mode === 'testoverlay') {
    return (
      <div className="w-full h-full flex items-center justify-center bg-purple-900 text-white">
        <p>Test Overlay Mode</p>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex items-center justify-center bg-gray-900 text-white">
      <p>Invalid mode. Use ?mode=promptcapture or ?mode=results</p>
    </div>
  );
}

export default App;
