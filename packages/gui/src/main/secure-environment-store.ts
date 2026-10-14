export interface EnvironmentProfileData {
  id: string
  projectPath: string
  name: string
  apiBaseUrl: string
  openApiUrl: string
  uiEntryUrl: string
  coverageTarget: number
  apiHeaders: Array<{ key: string; value: string }>
  env: Array<{ key: string; value: string }>
}

interface SecretCodec {
  encrypt(value: string): string
  decrypt(value: string): string
}

type StoredProfile = Omit<EnvironmentProfileData, 'apiHeaders' | 'env'> & {
  apiHeaders: Array<{ key: string; encryptedValue: string }>
  env: Array<{ key: string; encryptedValue: string }>
}

export function sealProfiles(profiles: EnvironmentProfileData[], codec: SecretCodec): StoredProfile[] {
  return profiles.map(profile => ({
    ...profile,
    apiHeaders: profile.apiHeaders.map(entry => ({ key: entry.key, encryptedValue: codec.encrypt(entry.value) })),
    env: profile.env.map(entry => ({ key: entry.key, encryptedValue: codec.encrypt(entry.value) }))
  }))
}

export function openProfiles(profiles: StoredProfile[], codec: SecretCodec): EnvironmentProfileData[] {
  return profiles.map(profile => ({
    ...profile,
    apiHeaders: profile.apiHeaders.map(entry => ({ key: entry.key, value: codec.decrypt(entry.encryptedValue) })),
    env: profile.env.map(entry => ({ key: entry.key, value: codec.decrypt(entry.encryptedValue) }))
  }))
}
