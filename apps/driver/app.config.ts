import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "SwiftDrop Driver",
  slug: "swiftdrop-driver",
  version: "0.1.0",
  scheme: "swiftdrop-driver",
  orientation: "portrait",
  ios: {
    supportsTablet: true,
    bundleIdentifier: process.env.IOS_BUNDLE_IDENTIFIER ?? "com.swiftdrop.driver",
    infoPlist: {
      NSCameraUsageDescription: "SwiftDrop uses the camera to capture parcel condition at pickup.",
      NSLocationWhenInUseUsageDescription: "SwiftDrop uses your location to provide live delivery tracking while a delivery is active.",
      NSLocationAlwaysAndWhenInUseUsageDescription: "SwiftDrop uses your location in the background during an active delivery so the sender and receiver can follow the parcel."
    }
  },
  android: {
    package: process.env.ANDROID_PACKAGE ?? "com.swiftdrop.driver"
  },
  plugins: [
    "expo-camera",
    [
      "expo-location",
      {
        isAndroidBackgroundLocationEnabled: true,
        isIosBackgroundLocationEnabled: true
      }
    ],
    "expo-notifications"
  ]
};

export default config;
