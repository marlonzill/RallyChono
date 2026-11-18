import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'br.com.pitstopsports.coletor',
  appName: 'PitStop Sports',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
  android: {
    backgroundColor: '#070B12',
    allowMixedContent: true,
  },
};

export default config;
