import { app, type BrowserWindow } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export type RendererWindowKind = 'launcher' | 'overlay' | 'settings' | 'model-selector'

const isEnvDev = process.env.NODE_ENV === 'development'
const isPackaged = app.isPackaged
const isDev = isEnvDev && !isPackaged
const devServerUrl = 'http://localhost:5180'

export const getRendererEntryPath = (): string => path.join(app.getAppPath(), 'dist', 'index.html')

export const getRendererRouteUrl = (windowKind: RendererWindowKind): string => {
  if (isDev) {
    return `${devServerUrl}?window=${windowKind}`
  }

  const url = pathToFileURL(getRendererEntryPath())
  url.searchParams.set('window', windowKind)
  return url.toString()
}

export const loadRendererRoute = (
  win: Pick<BrowserWindow, 'loadFile' | 'loadURL'>,
  windowKind: RendererWindowKind,
): Promise<void> => {
  if (isDev) {
    return win.loadURL(getRendererRouteUrl(windowKind))
  }

  return win.loadFile(getRendererEntryPath(), {
    query: {
      window: windowKind,
    },
  })
}
