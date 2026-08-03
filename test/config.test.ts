import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveMattermostAckSettings } from "../src/config.js";

function buildConfig(overrides: Record<string, unknown>): OpenClawConfig {
  return overrides as OpenClawConfig;
}

describe("resolveMattermostAckSettings", () => {
  const originalToken = process.env.MATTERMOST_BOT_TOKEN;
  const originalUrl = process.env.MATTERMOST_URL;

  beforeEach(() => {
    delete process.env.MATTERMOST_BOT_TOKEN;
    delete process.env.MATTERMOST_URL;
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.MATTERMOST_BOT_TOKEN;
    } else {
      process.env.MATTERMOST_BOT_TOKEN = originalToken;
    }
    if (originalUrl === undefined) {
      delete process.env.MATTERMOST_URL;
    } else {
      process.env.MATTERMOST_URL = originalUrl;
    }
  });

  it("reads botToken/baseUrl from the channel top level for the default account", () => {
    const config = buildConfig({
      channels: {
        mattermost: { botToken: "mm-token", baseUrl: "https://chat.example.com" },
      },
    });
    const settings = resolveMattermostAckSettings({ config });
    expect(settings.accountId).toBe("default");
    expect(settings.botToken).toBe("mm-token");
    expect(settings.baseUrl).toBe("https://chat.example.com");
    expect(settings.enabled).toBe(true);
  });

  it("strips a trailing slash and /api/v4 suffix from baseUrl", () => {
    const config = buildConfig({
      channels: {
        mattermost: { botToken: "mm-token", baseUrl: "https://chat.example.com/api/v4/" },
      },
    });
    const settings = resolveMattermostAckSettings({ config });
    expect(settings.baseUrl).toBe("https://chat.example.com");
  });

  it("prefers an account-scoped botToken/baseUrl over the channel-level value", () => {
    const config = buildConfig({
      channels: {
        mattermost: {
          botToken: "channel-token",
          baseUrl: "https://channel.example.com",
          accounts: {
            alerts: { botToken: "alerts-token", baseUrl: "https://alerts.example.com" },
          },
        },
      },
    });
    const settings = resolveMattermostAckSettings({ config, accountId: "alerts" });
    expect(settings.accountId).toBe("alerts");
    expect(settings.botToken).toBe("alerts-token");
    expect(settings.baseUrl).toBe("https://alerts.example.com");
  });

  it("falls back to MATTERMOST_BOT_TOKEN/MATTERMOST_URL only for the default account", () => {
    process.env.MATTERMOST_BOT_TOKEN = "env-token";
    process.env.MATTERMOST_URL = "https://env.example.com";
    const config = buildConfig({ channels: { mattermost: {} } });

    const defaultSettings = resolveMattermostAckSettings({ config });
    expect(defaultSettings.botToken).toBe("env-token");
    expect(defaultSettings.baseUrl).toBe("https://env.example.com");

    const namedAccountSettings = resolveMattermostAckSettings({
      config: buildConfig({
        channels: { mattermost: { accounts: { alerts: {} } } },
      }),
      accountId: "alerts",
    });
    expect(namedAccountSettings.botToken).toBeUndefined();
    expect(namedAccountSettings.baseUrl).toBeUndefined();
  });

  it("resolves ackReaction with account -> channel -> messages.ackReaction precedence", () => {
    const config = buildConfig({
      messages: { ackReaction: "🔥" },
      channels: {
        mattermost: {
          ackReaction: "👍",
          accounts: { alerts: { ackReaction: "🎉" } },
        },
      },
    });
    expect(resolveMattermostAckSettings({ config, accountId: "alerts" }).ackReactionRaw).toBe("🎉");
    expect(resolveMattermostAckSettings({ config, accountId: "default" }).ackReactionRaw).toBe("👍");
    expect(
      resolveMattermostAckSettings({
        config: buildConfig({ messages: { ackReaction: "🔥" }, channels: { mattermost: {} } }),
      }).ackReactionRaw,
    ).toBe("🔥");
  });

  it("treats an explicit empty-string ackReaction override as terminal (does not fall through)", () => {
    const config = buildConfig({
      messages: { ackReaction: "🔥" },
      channels: { mattermost: { ackReaction: "" } },
    });
    expect(resolveMattermostAckSettings({ config }).ackReactionRaw).toBe("");
  });

  it("resolves ackReactionScope with account -> channel -> messages.ackReactionScope precedence, defaulting to group-mentions", () => {
    expect(
      resolveMattermostAckSettings({ config: buildConfig({ channels: { mattermost: {} } }) })
        .scope,
    ).toBe("group-mentions");
    expect(
      resolveMattermostAckSettings({
        config: buildConfig({
          messages: { ackReactionScope: "all" },
          channels: { mattermost: {} },
        }),
      }).scope,
    ).toBe("all");
    expect(
      resolveMattermostAckSettings({
        config: buildConfig({
          messages: { ackReactionScope: "all" },
          channels: { mattermost: { ackReactionScope: "direct" } },
        }),
      }).scope,
    ).toBe("direct");
  });

  it("is disabled when the channel is disabled", () => {
    const config = buildConfig({ channels: { mattermost: { enabled: false } } });
    expect(resolveMattermostAckSettings({ config }).enabled).toBe(false);
  });

  it("is disabled when the specific account is disabled even if the channel is enabled", () => {
    const config = buildConfig({
      channels: { mattermost: { accounts: { alerts: { enabled: false } } } },
    });
    expect(resolveMattermostAckSettings({ config, accountId: "alerts" }).enabled).toBe(false);
  });

  it("uses channels.mattermost.defaultAccount when no accountId is supplied", () => {
    const config = buildConfig({
      channels: {
        mattermost: {
          defaultAccount: "alerts",
          accounts: { alerts: { botToken: "alerts-token", baseUrl: "https://alerts.example.com" } },
        },
      },
    });
    const settings = resolveMattermostAckSettings({ config });
    expect(settings.accountId).toBe("alerts");
    expect(settings.botToken).toBe("alerts-token");
  });

  it("reports allowPrivateNetwork when opted in at the channel or account level", () => {
    const channelOptIn = buildConfig({
      channels: { mattermost: { network: { dangerouslyAllowPrivateNetwork: true } } },
    });
    expect(resolveMattermostAckSettings({ config: channelOptIn }).allowPrivateNetwork).toBe(true);

    const accountOptIn = buildConfig({
      channels: {
        mattermost: {
          accounts: { alerts: { network: { dangerouslyAllowPrivateNetwork: true } } },
        },
      },
    });
    expect(
      resolveMattermostAckSettings({ config: accountOptIn, accountId: "alerts" })
        .allowPrivateNetwork,
    ).toBe(true);

    const noOptIn = buildConfig({ channels: { mattermost: {} } });
    expect(resolveMattermostAckSettings({ config: noOptIn }).allowPrivateNetwork).toBe(false);
  });

  it("enables lifecycle reactions unless messages.statusReactions.enabled is explicitly false", () => {
    expect(
      resolveMattermostAckSettings({ config: buildConfig({ channels: { mattermost: {} } }) })
        .statusReactionsEnabled,
    ).toBe(true);
    expect(
      resolveMattermostAckSettings({
        config: buildConfig({
          messages: { statusReactions: { enabled: true } },
          channels: { mattermost: {} },
        }),
      }).statusReactionsEnabled,
    ).toBe(true);
    expect(
      resolveMattermostAckSettings({
        config: buildConfig({
          messages: { statusReactions: { enabled: false } },
          channels: { mattermost: {} },
        }),
      }).statusReactionsEnabled,
    ).toBe(false);
  });
});
