import type { ExpoConfig } from "expo/config";

const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? "";
const isProduction = process.env.EAS_BUILD_PROFILE === "production" || process.env.NODE_ENV === "production";
if (isProduction && (!apiUrl || apiUrl.includes("example.com"))) {
  throw new Error("Production mobile builds require EXPO_PUBLIC_API_URL to point to the real HTTPS SwiftDrop API.");
}
if (isProduction && apiUrl && !apiUrl.startsWith("https://")) {
  throw new Error("Production mobile builds require an HTTPS EXPO_PUBLIC_API_URL.");
}

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
    ["expo-location", { isAndroidBackgroundLocationEnabled: true, isIosBackgroundLocationEnabled: true }],
    "expo-notifications"
  ]
};

export default config;
