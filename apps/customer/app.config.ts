import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "SwiftDrop",
  slug: "swiftdrop",
  version: "0.1.0",
  scheme: "swiftdrop",
  orientation: "portrait",
  ios: {
    supportsTablet: true,
    config: { googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY ?? "ci-validation-placeholder" },
    bundleIdentifier: process.env.IOS_BUNDLE_IDENTIFIER ?? "com.swiftdrop.customer",
    infoPlist: {
      NSLocationWhenInUseUsageDescription: "SwiftDrop uses your location to set the pickup point when you choose your current location."
    }
  },
  android: {
    package: process.env.ANDROID_PACKAGE ?? "com.swiftdrop.customer",
    config: { googleMaps: { apiKey: process.env.GOOGLE_MAPS_API_KEY ?? "ci-validation-placeholder" } }
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
    ["expo-image-picker", { photosPermission: "SwiftDrop uses your photos so you can add product images to marketplace listings.", cameraPermission: "SwiftDrop uses your camera so you can photograph products for marketplace listings.", microphonePermission: false }]
  ]
};

export default config;
