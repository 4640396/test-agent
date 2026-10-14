/// <reference types="vite/client" />

import type { DesktopApi, LocalHostApi } from '../types.js'

declare global {
  interface Window {
    testAgent: DesktopApi
    testAgentLocal: LocalHostApi
  }
}

export {}
