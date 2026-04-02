import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.brimstone.game',
  appName: 'Brimstone',
  webDir: 'www',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#0d0f16',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0d0f16',
    },
  },
  android: {
    minWebViewVersion: 61,
  },
};

export default config;
