import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.sergiofjr71.mural',
  appName: 'Mural',
  webDir: 'www',
  ios: {
    contentInset: 'never',
    scrollEnabled: false,
    backgroundColor: '#030b18',
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
