declare module '*.mp3' {
  const src: string;
  export default src;
}

declare global {
  interface Window {
    electron: {
      ipcRenderer: {
        send: (channel: string, data?: any) => void;
        on: (channel: string, func: (...args: any[]) => void) => void;
        once: (channel: string, func: (...args: any[]) => void) => void;
        removeAllListeners: (channel: string) => void;
        removeListener: (channel: string, func: (...args: any[]) => void) => void;
        invoke: (channel: string, data?: any) => Promise<any>;
      };
    };
  }
}

export {};
