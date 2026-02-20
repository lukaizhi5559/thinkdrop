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
        'vscode-bridge:send-message',
        'vscode-bridge:connect',
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
        'vscode-bridge:message',
        'vscode-bridge:error',
      ];
      if (validChannels.includes(channel)) {
        ipcRenderer.on(channel, (event, ...args) => func(event, ...args));
      }
    },
    removeListener: (channel, func) => {
      const validChannels = [
        'prompt-capture:show',
        'prompt-capture:add-highlight',
        'prompt-capture:capture-screenshot',
        'prompt-capture:screenshot-result',
        'results-window:set-prompt',
        'results-window:display-error',
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
