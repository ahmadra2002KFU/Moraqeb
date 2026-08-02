// Moraqeb (مراقب) Configuration — all settings with env var overrides

import "./apis/utils/env.mjs"; // Load .env first
import { resolveLLMConfig } from "./lib/llm/config.mjs";

export default {
  port: parseInt(process.env.PORT) || 3117,
  refreshIntervalMinutes: parseInt(process.env.REFRESH_INTERVAL_MINUTES) || 15,
  blogIntervalMinutes: parseInt(process.env.BLOG_INTERVAL_MINUTES) || 60,

  llm: resolveLLMConfig(process.env),

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || null,
    chatId: process.env.TELEGRAM_CHAT_ID || null,
    botPollingInterval: parseInt(process.env.TELEGRAM_POLL_INTERVAL) || 5000,
    channels: process.env.TELEGRAM_CHANNELS || null, // Comma-separated extra channel IDs
  },

  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || null,
    channelId: process.env.DISCORD_CHANNEL_ID || null,
    guildId: process.env.DISCORD_GUILD_ID || null, // Server ID (for instant slash command registration)
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || null, // Fallback: webhook-only alerts (no bot needed)
  },

  // MiniMax API key (for chat and blog)
  minimaxApiKey: process.env.MINIMAX_API_KEY || (process.env.LLM_PROVIDER === 'minimax' ? process.env.LLM_API_KEY : null) || null,
  minimaxModel: process.env.MINIMAX_MODEL || 'MiniMax-M2.7',

  // Gemini API key (voice only)
  geminiApiKey: process.env.GEMINI_API_KEY || null,

  // Delta engine thresholds — override defaults from lib/delta/engine.mjs
  // Set to null to use built-in defaults
  delta: {
    thresholds: {
      numeric: {
        // Example overrides (uncomment to customize):
        // vix: 3,       // more sensitive to VIX moves
        // wti: 5,       // less sensitive to oil moves
      },
      count: {
        // urgent_posts: 3,     // need ±3 urgent posts to flag
        // thermal_total: 1000, // need ±1000 thermal detections
      },
    },
  },
};
