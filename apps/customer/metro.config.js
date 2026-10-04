const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
  if (platform === "web" && name === "react-native-maps") {
    return { type: "sourceFile", filePath: path.resolve(__dirname, "web-stubs/react-native-maps.js") };
  }
  return (upstream ?? context.resolveRequest)(context, name, platform);
};
module.exports = config;
