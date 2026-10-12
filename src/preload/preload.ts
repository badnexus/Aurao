// The bridge between the window and the engine. The renderer never sees Node or the SDK;
// it only gets these few, typed calls.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  listDir: (dir?: string) => ipcRenderer.invoke('files:list', dir),
  chooseFolder: () => ipcRenderer.invoke('files:chooseFolder'),
  statPath: (p: string) => ipcRenderer.invoke('files:stat', p),
  openPath: (p: string) => ipcRenderer.invoke('shell:openPath', p),
  reveal: (p: string) => ipcRenderer.invoke('shell:reveal', p),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  send: (text: string) => ipcRenderer.send('chat:send', text),
  interrupt: () => ipcRenderer.send('chat:interrupt'),
  answerPermission: (requestId: string, allow: boolean, always = false) =>
    ipcRenderer.send('permission:answer', { requestId, allow, always }),
  setPersona: (persona: 'standard' | 'soft') => ipcRenderer.invoke('persona:set', persona),
  setLanguage: (language: string) => ipcRenderer.invoke('language:set', language),
  setApprovalMode: (mode: string) => ipcRenderer.invoke('approvals:set', mode),
  checkHealth: (engineType?: string) => ipcRenderer.invoke('system:checkHealth', engineType),
  saveAllConfig: (newCfg: Record<string, unknown>) => ipcRenderer.invoke('config:saveAll', newCfg),
  chooseDir: (initialPath?: string, title?: string) => ipcRenderer.invoke('files:chooseDir', initialPath, title),
  restart: () => ipcRenderer.invoke('engine:restart'),
  listModels: () => ipcRenderer.invoke('models:list'),
  setModel: (model: string) => ipcRenderer.invoke('models:set', model),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getCurrentSession: () => ipcRenderer.invoke('sessions:current'),
  switchSession: (conversationId: string | null) => ipcRenderer.invoke('sessions:switch', conversationId),
  onEngineEvent: (cb: (ev: unknown) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: unknown) => cb(ev);
    ipcRenderer.on('engine:event', listener);
    return () => ipcRenderer.off('engine:event', listener);
  },
  // Deterministic: a file dropped from Windows Explorer becomes its absolute path. No model call.
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  // Dev aids (screenshot mode): switch view / echo an auto-sent message into the chat.
  onShowView: (cb: (view: string) => void) => {
    ipcRenderer.on('ui:showView', (_e, view: string) => cb(view));
  },
  onEchoUser: (cb: (text: string) => void) => {
    ipcRenderer.on('ui:echoUser', (_e, text: string) => cb(text));
  },
};

contextBridge.exposeInMainWorld('termi', api);
export type TermiApi = typeof api;
