import { describe, expect, it } from 'vitest'
import { openProfiles, sealProfiles, type EnvironmentProfileData } from './secure-environment-store.js'

const codec = {
  encrypt: (value: string) => Buffer.from(`protected:${value}`).toString('base64'),
  decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8').replace(/^protected:/, '')
}

describe('secure environment profiles', () => {
  it('never leaves secret values in the serialized representation', () => {
    const input: EnvironmentProfileData[] = [{
      id: 'dev', projectPath: 'C:/project-a', name: '开发环境', apiBaseUrl: 'https://api.example.test', openApiUrl: '', uiEntryUrl: '', coverageTarget: 80,
      apiHeaders: [{ key: 'Authorization', value: 'Bearer secret-token' }], env: [{ key: 'TEST_PASSWORD', value: 'secret-password' }]
    }]
    const sealed = sealProfiles(input, codec)
    const serialized = JSON.stringify(sealed)
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain('secret-password')
    expect(openProfiles(sealed, codec)).toEqual(input)
  })
})
