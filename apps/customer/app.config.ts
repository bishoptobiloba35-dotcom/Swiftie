import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "SwiftDrop",
  slug: "swiftdrop",
  version: "0.1.0",
  scheme: "swiftdrop",
  orientation: "portrait",
  ios: {
    supportsTablet: true,
    bundleIdentifier: process.env.IOS_BUNDLE_IDENTIFIER ?? "com.swiftdrop.customer",
    infoPlist: {
      NSLocationWhenInUseUsageDescription: "SwiftDrop uses your location to set the pickup point when you choose your current location."
    }
  },
  android: {
    package: process.env.ANDROID_PACKAGE ?? "com.swiftdrop.customer"
  },
  plugins: [
    [
      "expo-location",
      {
        isAndroidBackgroundLocationEnabled: false,
        isIosBackgroundLocationEnabled: false
      }
    ],
    "expo-notifications",
    [
      "react-native-maps",
      {
        ...(process.env.GOOGLE_MAPS_API_KEY
          ? {
              androidGoogleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
              iosGoogleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY
            }
          : {})
      }
    ]
  ]
};

export default config;
