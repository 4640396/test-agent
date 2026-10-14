import { defineConfig } from '@playwright/test'
import baseConfig from './playwright.config'

/** Use when the renderer dev server is already running separately. */
export default defineConfig({ ...baseConfig, webServer: undefined })
