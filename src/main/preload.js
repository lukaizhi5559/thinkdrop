const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    send: (channel, data) => {
      const validChannels = [
        'prompt-capture:hide',
        'prompt-capture:resize',
        'prompt-capture:move',
        'prompt-capture:capture-screenshot',
        'prompt-capture:screenshot-result',
        'results-window:show',
        'results-window:close',
        'results-window:resize',
        'results-window:move',
        'results-window:set-prompt',
        'results-window:show-error',
        'ws-bridge:send-message',
        'ws-bridge:connect',
        'stategraph:process',
      ];
      if (validChannels.includes(channel)) {
        ipcRenderer.send(channel, data);
      }
    },
    on: (channel, func) => {
      const validChannels = [
        'prompt-capture:show',
        'prompt-capture:capture-screenshot',
        'prompt-capture:screenshot-result',
        'results-window:show',
        'prompt-capture:add-highlight',
        'results-window:set-prompt',
        'results-window:display-error',
        'ws-bridge:connected',
        'ws-bridge:disconnected',
        'ws-bridge:message',
        'ws-bridge:error',
        'automation:progress',
      ];
      if (validChannels.includes(channel)) {
        ipcRenderer.on(channel, func);
      }
    },
    removeAllListeners: (channel) => {
      const validChannels = [
        'prompt-capture:show',
        'prompt-capture:add-highlight',
        'prompt-capture:capture-screenshot',
        'prompt-capture:screenshot-result',
        'results-window:show',
        'results-window:set-prompt',
        'results-window:display-error',
        'ws-bridge:connected',
        'ws-bridge:disconnected',
        'ws-bridge:message',
        'ws-bridge:error',
        'automation:progress',
      ];
      if (validChannels.includes(channel)) {
        ipcRenderer.removeAllListeners(channel);
      }
    },
    removeListener: (channel, func) => {
      const validChannels = [
        'prompt-capture:show',
        'prompt-capture:add-highlight',
        'prompt-capture:capture-screenshot',
        'prompt-capture:screenshot-result',
        'results-window:show',
        'results-window:set-prompt',
        'results-window:display-error',
        'ws-bridge:connected',
        'ws-bridge:disconnected',
        'ws-bridge:message',
        'ws-bridge:error',
        'automation:progress',
      ];
      if (validChannels.includes(channel)) {
        ipcRenderer.removeListener(channel, func);
      }
    },
    invoke: (channel, data) => {
      // const validChannels = ['capture-screenshot'];
      // if (validChannels.includes(channel)) {
      //   return ipcRenderer.invoke(channel, data);
      // }
    },
  },
});
