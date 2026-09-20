export type PortalTheme = 'light' | 'dark' | null

export function portalThemeFromOutput(output: string): PortalTheme {
  // org.freedesktop.appearance/color-scheme: 1 = dark, 2 = light, 0 = no preference.
  const value = /uint32\s+(\d+)/.exec(output)?.[1] ?? /<(\d+)>/.exec(output)?.[1]
  if (value === '1') return 'dark'
  if (value === '2') return 'light'
  return null
}
