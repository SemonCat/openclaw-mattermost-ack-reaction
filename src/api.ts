// Local barrel for the public OpenClaw plugin SDK surface this plugin's
// entry point uses. Internal modules (config.ts, mattermost-client.ts) import
// their own focused SDK subpaths directly.
export { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export { ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "openclaw/plugin-sdk/ssrf-runtime";
