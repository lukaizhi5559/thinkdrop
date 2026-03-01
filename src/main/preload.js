const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    send: (channel, data) => {
      const validChannels = [
        'prompt-capture:hide',
        'prompt-capture:resize',
        'prompt-capture:move',
        'prompt-capture:pick-file',
        'results-window:show',
        'results-window:close',
        'results-window:resize',
        'results-window:move',
        'results-window:set-prompt',
        'results-window:show-error',
        'ws-bridge:send-message',
        'ws-bridge:connect',
        'stategraph:process',
        'shell:open-path',
        'shell:open-url',
        'install:confirm',
        'guide:continue',
        'guide:cancel',
        'schedule:dismiss',
        'automation:cancel',
        'voice:start',
        'voice:stop',
        'voice:push-to-talk-start',
        'voice:push-to-talk-end',
        'voice:audio-chunk',
        'voice:transcript-direct',
        'skill:list',
        'skill:delete',
        'skill:store-open',
        'skill:build-start',
        'skill:build-answer',
        'ptt:input-focus',
        'ptt:input-blur',
        'ptt:keyup',
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
        'schedule:pending',
        'bridge:status',
        'voice:status',
        'voice:speaking',
        'voice:listening',
        'voice:transcript',
        'voice:response',
        'voice:error',
        'voice:inject-prompt',
        'skill:list-response',
        'skill:delete-response',
        'skill:store-trigger',
        'skill:build-done',
        'skill:build-asking',
        'voice:ptt-start',
        'voice:ptt-stop',
        'ptt:transcript',
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
        'schedule:pending',
        'bridge:status',
        'voice:status',
        'voice:speaking',
        'voice:listening',
        'voice:transcript',
        'voice:response',
        'voice:error',
        'voice:inject-prompt',
        'skill:list-response',
        'skill:delete-response',
        'skill:store-trigger',
        'skill:build-done',
        'skill:build-asking',
        'voice:ptt-start',
        'voice:ptt-stop',
        'ptt:transcript',
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
        'schedule:pending',
        'bridge:status',
        'voice:status',
        'voice:speaking',
        'voice:listening',
        'voice:transcript',
        'voice:response',
        'voice:error',
        'voice:inject-prompt',
        'skill:list-response',
        'skill:delete-response',
        'skill:store-trigger',
        'skill:build-done',
        'skill:build-asking',
        'voice:ptt-start',
        'voice:ptt-stop',
        'ptt:transcript',
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
