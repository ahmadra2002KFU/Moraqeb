#!/usr/bin/env node
// Moraqeb Intelligence Engine — Dev Server
// Serves the Jarvis dashboard, runs sweep cycle, pushes live updates via SSE

import express from 'express';
import { createServer } from 'http';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { WebSocketServer } from 'ws';
import config from './crucix.config.mjs';
import { getLocale, currentLanguage, getSupportedLocales } from './lib/i18n.mjs';
import { fullBriefing } from './apis/briefing.mjs';
import { synthesize, generateIdeas } from './dashboard/inject.mjs';
import { MemoryManager } from './lib/delta/index.mjs';
import { createLLMProvider } from './lib/llm/index.mjs';
import { generateLLMIdeas } from './lib/llm/ideas.mjs';
import { TelegramAlerter } from './lib/alerts/telegram.mjs';
import { DiscordAlerter } from './lib/alerts/discord.mjs';
import { buildIntelligenceContext } from './lib/context/builder.mjs';
import { getChatSystemPrompt, getVoiceSystemPrompt } from './lib/prompts/strategist.mjs';
import { GeminiLiveSession } from './lib/llm/gemini-live.mjs';
import { generateSITREP } from './lib/blog/generator.mjs';
import { BlogStore } from './lib/blog/store.mjs';
import { generatePost } from './lib/posts/generator.mjs';
import { PostStore } from './lib/posts/store.mjs';
import { TokenTracker } from './lib/token-tracker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const RUNS_DIR = join(ROOT, 'runs');
const MEMORY_DIR = join(RUNS_DIR, 'memory');

const BLOG_DIR = join(RUNS_DIR, 'blog');
const POSTS_DIR = join(RUNS_DIR, 'posts');

// Ensure directories exist
for (const dir of [RUNS_DIR, MEMORY_DIR, join(MEMORY_DIR, 'cold'), BLOG_DIR, POSTS_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// === Blog Store + Token Tracker ===
const blogStore = new BlogStore(BLOG_DIR);
const postStore = new PostStore(POSTS_DIR);
const tokenTracker = new TokenTracker(RUNS_DIR);

// === State ===
let currentData = null;    // Current synthesized dashboard data
let lastSweepTime = null;  // Timestamp of last sweep
let sweepStartedAt = null; // Timestamp when current/last sweep started
let sweepInProgress = false;
const startTime = Date.now();
const sseClients = new Set();

// === Delta/Memory ===
const memory = new MemoryManager(RUNS_DIR);

// === LLM + Telegram + Discord ===
const llmProvider = createLLMProvider(config.llm);
const telegramAlerter = new TelegramAlerter(config.telegram);
const discordAlerter = new DiscordAlerter(config.discord || {});

if (llmProvider) console.log(`[Moraqeb] LLM enabled: ${llmProvider.name} (${llmProvider.model})`);
if (telegramAlerter.isConfigured) {
  console.log('[Moraqeb] Telegram alerts enabled');

  // ─── Two-Way Bot Commands ───────────────────────────────────────────────

  telegramAlerter.onCommand('/status', async () => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const sourcesOk = currentData?.meta?.sourcesOk || 0;
    const sourcesTotal = currentData?.meta?.sourcesQueried || 0;
    const sourcesFailed = currentData?.meta?.sourcesFailed || 0;
    const llmStatus = llmProvider?.isConfigured ? `✅ ${llmProvider.name}` : '❌ Disabled';
    const nextSweep = lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()
      : 'pending';

    return [
      `🖥️ *MORAQEB STATUS*`,
      ``,
      `Uptime: ${h}h ${m}m`,
      `Last sweep: ${lastSweepTime ? new Date(lastSweepTime).toLocaleTimeString() + ' UTC' : 'never'}`,
      `Next sweep: ${nextSweep} UTC`,
      `Sweep in progress: ${sweepInProgress ? '🔄 Yes' : '⏸️ No'}`,
      `Sources: ${sourcesOk}/${sourcesTotal} OK${sourcesFailed > 0 ? ` (${sourcesFailed} failed)` : ''}`,
      `LLM: ${llmStatus}`,
      `SSE clients: ${sseClients.size}`,
      `Dashboard: http://localhost:${config.port}`,
    ].join('\n');
  });

  telegramAlerter.onCommand('/sweep', async () => {
    if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
    // Fire and forget — don't block the bot response
    runSweepCycle().catch(err => console.error('[Moraqeb] Manual sweep failed:', err.message));
    return '🚀 Manual sweep triggered. You\'ll receive alerts if anything significant is detected.';
  });

  telegramAlerter.onCommand('/brief', async () => {
    if (!currentData) return '⏳ No data yet — waiting for first sweep to complete.';

    const tg = currentData.tg || {};
    const energy = currentData.energy || {};
    const delta = memory.getLastDelta();
    const ideas = (currentData.ideas || []).slice(0, 3);

    const sections = [
      `📋 *MORAQEB BRIEF*`,
      `_${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_`,
      ``,
    ];

    // Delta direction
    if (delta?.summary) {
      const dirEmoji = { 'risk-off': '📉', 'risk-on': '📈', 'mixed': '↔️' }[delta.summary.direction] || '↔️';
      sections.push(`${dirEmoji} Direction: *${delta.summary.direction.toUpperCase()}* | ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical`);
      sections.push('');
    }

    // Key metrics
    const vix = currentData.fred?.find(f => f.id === 'VIXCLS');
    const hy = currentData.fred?.find(f => f.id === 'BAMLH0A0HYM2');
    if (vix || energy.wti) {
      sections.push(`📊 VIX: ${vix?.value || '--'} | WTI: $${energy.wti || '--'} | Brent: $${energy.brent || '--'}`);
      if (hy) sections.push(`   HY Spread: ${hy.value} | NatGas: $${energy.natgas || '--'}`);
      sections.push('');
    }

    // OSINT
    if (tg.urgent?.length > 0) {
      sections.push(`📡 OSINT: ${tg.urgent.length} urgent signals, ${tg.posts || 0} total posts`);
      // Top 2 urgent
      for (const p of tg.urgent.slice(0, 2)) {
        sections.push(`  • ${(p.text || '').substring(0, 80)}`);
      }
      sections.push('');
    }

    // Top ideas
    if (ideas.length > 0) {
      sections.push(`💡 *Top Ideas:*`);
      for (const idea of ideas) {
        sections.push(`  ${idea.type === 'long' ? '📈' : idea.type === 'hedge' ? '🛡️' : '👁️'} ${idea.title}`);
      }
    }

    return sections.join('\n');
  });

  telegramAlerter.onCommand('/portfolio', async () => {
    return '📊 Portfolio integration requires Alpaca MCP connection.\nUse the Moraqeb dashboard or Claude agent for portfolio queries.';
  });

  // Start polling for bot commands
  telegramAlerter.startPolling(config.telegram.botPollingInterval);
}

// === Discord Bot ===
if (discordAlerter.isConfigured) {
  console.log('[Moraqeb] Discord bot enabled');

  // Reuse the same command handlers as Telegram (DRY)
  discordAlerter.onCommand('status', async () => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const sourcesOk = currentData?.meta?.sourcesOk || 0;
    const sourcesTotal = currentData?.meta?.sourcesQueried || 0;
    const sourcesFailed = currentData?.meta?.sourcesFailed || 0;
    const llmStatus = llmProvider?.isConfigured ? `✅ ${llmProvider.name}` : '❌ Disabled';
    const nextSweep = lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()
      : 'pending';

    return [
      `**🖥️ MORAQEB STATUS**\n`,
      `Uptime: ${h}h ${m}m`,
      `Last sweep: ${lastSweepTime ? new Date(lastSweepTime).toLocaleTimeString() + ' UTC' : 'never'}`,
      `Next sweep: ${nextSweep} UTC`,
      `Sweep in progress: ${sweepInProgress ? '🔄 Yes' : '⏸️ No'}`,
      `Sources: ${sourcesOk}/${sourcesTotal} OK${sourcesFailed > 0 ? ` (${sourcesFailed} failed)` : ''}`,
      `LLM: ${llmStatus}`,
      `SSE clients: ${sseClients.size}`,
      `Dashboard: http://localhost:${config.port}`,
    ].join('\n');
  });

  discordAlerter.onCommand('sweep', async () => {
    if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
    runSweepCycle().catch(err => console.error('[Moraqeb] Manual sweep failed:', err.message));
    return '🚀 Manual sweep triggered. You\'ll receive alerts if anything significant is detected.';
  });

  discordAlerter.onCommand('brief', async () => {
    if (!currentData) return '⏳ No data yet — waiting for first sweep to complete.';

    const tg = currentData.tg || {};
    const energy = currentData.energy || {};
    const delta = memory.getLastDelta();
    const ideas = (currentData.ideas || []).slice(0, 3);

    const sections = [`**📋 MORAQEB BRIEF**\n_${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_\n`];

    if (delta?.summary) {
      const dirEmoji = { 'risk-off': '📉', 'risk-on': '📈', 'mixed': '↔️' }[delta.summary.direction] || '↔️';
      sections.push(`${dirEmoji} Direction: **${delta.summary.direction.toUpperCase()}** | ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical\n`);
    }

    const vix = currentData.fred?.find(f => f.id === 'VIXCLS');
    const hy = currentData.fred?.find(f => f.id === 'BAMLH0A0HYM2');
    if (vix || energy.wti) {
      sections.push(`📊 VIX: ${vix?.value || '--'} | WTI: $${energy.wti || '--'} | Brent: $${energy.brent || '--'}`);
      if (hy) sections.push(`   HY Spread: ${hy.value} | NatGas: $${energy.natgas || '--'}`);
      sections.push('');
    }

    if (tg.urgent?.length > 0) {
      sections.push(`📡 OSINT: ${tg.urgent.length} urgent signals, ${tg.posts || 0} total posts`);
      for (const p of tg.urgent.slice(0, 2)) {
        sections.push(`  • ${(p.text || '').substring(0, 80)}`);
      }
      sections.push('');
    }

    if (ideas.length > 0) {
      sections.push(`**💡 Top Ideas:**`);
      for (const idea of ideas) {
        sections.push(`  ${idea.type === 'long' ? '📈' : idea.type === 'hedge' ? '🛡️' : '👁️'} ${idea.title}`);
      }
    }

    return sections.join('\n');
  });

  discordAlerter.onCommand('portfolio', async () => {
    return '📊 Portfolio integration requires Alpaca MCP connection.\nUse the Moraqeb dashboard or Claude agent for portfolio queries.';
  });

  // Start the Discord bot (non-blocking — connection happens async)
  discordAlerter.start().catch(err => {
    console.error('[Moraqeb] Discord bot startup failed (non-fatal):', err.message);
  });
}

// === Express Server ===
const app = express();
app.use(express.static(join(ROOT, 'dashboard/public')));

// Serve loading page until first sweep completes, then the dashboard with injected locale
app.get('/', (req, res) => {
  if (!currentData) {
    res.sendFile(join(ROOT, 'dashboard/public/loading.html'));
  } else {
    const htmlPath = join(ROOT, 'dashboard/public/jarvis.html');
    let html = readFileSync(htmlPath, 'utf-8');
    
    // Inject locale data into the HTML
    const locale = getLocale();
    const localeScript = `<script>window.__CRUCIX_LOCALE__ = ${JSON.stringify(locale).replace(/<\/script>/gi, '<\\/script>')};</script>`;
    html = html.replace('</head>', `${localeScript}\n</head>`);
    
    res.type('html').send(html);
  }
});

// API: current data
app.get('/api/data', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData);
});

// API: health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastSweep: lastSweepTime,
    nextSweep: lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toISOString()
      : null,
    sweepInProgress,
    sweepStartedAt,
    sourcesOk: currentData?.meta?.sourcesOk || 0,
    sourcesFailed: currentData?.meta?.sourcesFailed || 0,
    llmEnabled: !!config.llm.provider,
    llmProvider: config.llm.provider,
    telegramEnabled: !!(config.telegram.botToken && config.telegram.chatId),
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    language: currentLanguage,
  });
});

// API: available locales
app.get('/api/locales', (req, res) => {
  res.json({
    current: currentLanguage,
    supported: getSupportedLocales(),
  });
});

// === Page Routes (Chat, Voice, Blog) ===
app.get('/chat', (req, res) => res.sendFile(join(ROOT, 'dashboard/public/chat.html')));
app.get('/voice', (req, res) => res.sendFile(join(ROOT, 'dashboard/public/voice.html')));
app.get('/blog', (req, res) => res.sendFile(join(ROOT, 'dashboard/public/blog.html')));
app.get('/posts', (req, res) => res.sendFile(join(ROOT, 'dashboard/public/posts.html')));

// === Chat API (MiniMax M2.7 streaming) ===
app.use(express.json());

app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const apiKey = config.minimaxApiKey;
  if (!apiKey) return res.status(503).json({ error: 'MiniMax API key not configured' });

  // Build intelligence context from current sweep
  const delta = memory.getLastDelta();
  const context = buildIntelligenceContext(currentData, delta);
  const systemPrompt = getChatSystemPrompt(context);

  // Build conversation messages for MiniMax (OpenAI-compatible)
  const messages = [{ role: 'system', content: systemPrompt }];
  if (history?.length) {
    for (const msg of history) {
      // Convert Gemini-style { role: "model", parts } to OpenAI-style { role: "assistant", content }
      const role = msg.role === 'model' ? 'assistant' : msg.role;
      const content = msg.parts?.map(p => p.text).join('') || '';
      messages.push({ role, content });
    }
  }
  messages.push({ role: 'user', content: message });

  // Stream from MiniMax
  const minimaxUrl = 'https://api.minimax.io/v1/chat/completions';

  try {
    const minimaxRes = await fetch(minimaxUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.minimaxModel,
        max_tokens: 8192,
        stream: true,
        messages,
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (!minimaxRes.ok) {
      const errText = await minimaxRes.text().catch(() => '');
      console.error('[Moraqeb Chat] MiniMax error:', minimaxRes.status, errText.substring(0, 300));
      return res.status(502).json({ error: `MiniMax API error: ${minimaxRes.status}` });
    }

    // Relay the SSE stream
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const reader = minimaxRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let chatInputTokens = 0, chatOutputTokens = 0;
    let insideThink = false; // Track <think> blocks to suppress reasoning output
    let thinkBuffer = '';    // Buffer partial tags across chunks

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.substring(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta;
            let text = delta?.content || '';
            if (text) {
              // Filter out <think>...</think> blocks from streaming output
              thinkBuffer += text;
              let filtered = '';
              while (thinkBuffer.length > 0) {
                if (insideThink) {
                  const closeIdx = thinkBuffer.indexOf('</think>');
                  if (closeIdx !== -1) {
                    thinkBuffer = thinkBuffer.substring(closeIdx + 8);
                    insideThink = false;
                  } else {
                    thinkBuffer = ''; // Still inside think, discard
                    break;
                  }
                } else {
                  const openIdx = thinkBuffer.indexOf('<think>');
                  if (openIdx !== -1) {
                    filtered += thinkBuffer.substring(0, openIdx);
                    thinkBuffer = thinkBuffer.substring(openIdx + 7);
                    insideThink = true;
                  } else {
                    // Check for partial <think tag at the end
                    const partialIdx = thinkBuffer.lastIndexOf('<');
                    if (partialIdx !== -1 && '<think>'.startsWith(thinkBuffer.substring(partialIdx))) {
                      filtered += thinkBuffer.substring(0, partialIdx);
                      thinkBuffer = thinkBuffer.substring(partialIdx);
                      break;
                    }
                    filtered += thinkBuffer;
                    thinkBuffer = '';
                  }
                }
              }
              if (filtered) {
                res.write(`data: ${JSON.stringify({ text: filtered })}\n\n`);
              }
            }
            // Capture token usage from the last chunk
            if (parsed.usage) {
              chatInputTokens = parsed.usage.prompt_tokens || chatInputTokens;
              chatOutputTokens = parsed.usage.completion_tokens || chatOutputTokens;
            }
          } catch { /* skip malformed chunks */ }
        }
      }
    }

    // Record chat token usage
    if (chatInputTokens || chatOutputTokens) {
      tokenTracker.record('chat', chatInputTokens, chatOutputTokens);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('[Moraqeb Chat] Error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

// === Blog API ===
app.get('/api/blog', (req, res) => {
  const latest = blogStore.getLatest();
  if (!latest) return res.status(404).json({ error: 'No SITREP generated yet' });
  res.json(latest);
});

app.get('/api/blog/archive', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json(blogStore.getArchive(limit));
});

app.get('/api/blog/archive/:timestamp', (req, res) => {
  const sitrep = blogStore.getByTimestamp(req.params.timestamp);
  if (!sitrep) return res.status(404).json({ error: 'SITREP not found' });
  res.json(sitrep);
});

// === Posts API ===
app.get('/api/posts', (req, res) => {
  const latest = postStore.getLatest();
  if (!latest) return res.status(404).json({ error: 'No posts generated yet' });
  res.json(latest);
});

app.get('/api/posts/archive', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(postStore.getArchive(limit));
});

app.get('/api/posts/archive/:timestamp', (req, res) => {
  const post = postStore.getByTimestamp(req.params.timestamp);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json(post);
});

// === Token Usage API ===
app.get('/api/usage', (req, res) => {
  res.json(tokenTracker.getSummary(config.minimaxModel));
});

// SSE: live updates
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// === Sweep Cycle ===
async function runSweepCycle() {
  if (sweepInProgress) {
    console.log('[Moraqeb] Sweep already in progress, skipping');
    return;
  }

  sweepInProgress = true;
  sweepStartedAt = new Date().toISOString();
  broadcast({ type: 'sweep_start', timestamp: sweepStartedAt });
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Moraqeb] Starting sweep at ${new Date().toLocaleTimeString()}`);
  console.log(`${'='.repeat(60)}`);

  try {
    // 1. Run the full briefing sweep
    const rawData = await fullBriefing();

    // 2. Save to runs/latest.json
    writeFileSync(join(RUNS_DIR, 'latest.json'), JSON.stringify(rawData, null, 2));
    lastSweepTime = new Date().toISOString();

    // 3. Synthesize into dashboard format
    console.log('[Moraqeb] Synthesizing dashboard data...');
    const synthesized = await synthesize(rawData);

    // 4. Delta computation + memory
    const delta = memory.addRun(synthesized);
    synthesized.delta = delta;

    // 5. LLM-powered trade ideas (LLM-only feature) — isolated so failures don't kill sweep
    if (llmProvider?.isConfigured) {
      try {
        console.log('[Moraqeb] Generating LLM trade ideas...');
        const previousIdeas = memory.getLastRun()?.ideas || [];
        const llmIdeas = await generateLLMIdeas(llmProvider, synthesized, delta, previousIdeas);
        if (llmIdeas) {
          synthesized.ideas = llmIdeas;
          synthesized.ideasSource = 'llm';
          if (llmIdeas._usage) tokenTracker.record('ideas', llmIdeas._usage.inputTokens, llmIdeas._usage.outputTokens);
          console.log(`[Moraqeb] LLM generated ${llmIdeas.length} ideas`);
        } else {
          synthesized.ideas = [];
          synthesized.ideasSource = 'llm-failed';
        }
      } catch (llmErr) {
        console.error('[Moraqeb] LLM ideas failed (non-fatal):', llmErr.message);
        synthesized.ideas = [];
        synthesized.ideasSource = 'llm-failed';
      }
    } else {
      synthesized.ideas = [];
      synthesized.ideasSource = 'disabled';
    }

    // 6. Alert evaluation — Telegram + Discord (LLM with rule-based fallback, multi-tier, semantic dedup)
    if (delta?.summary?.totalChanges > 0) {
      if (telegramAlerter.isConfigured) {
        telegramAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Moraqeb] Telegram alert error:', err.message);
        });
      }
      if (discordAlerter.isConfigured) {
        discordAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Moraqeb] Discord alert error:', err.message);
        });
      }
    }

    // Prune old alerted signals
    memory.pruneAlertedSignals();

    currentData = synthesized;

    // 6. Push to all connected browsers
    broadcast({ type: 'update', data: currentData });

    console.log(`[Moraqeb] Sweep complete — ${currentData.meta.sourcesOk}/${currentData.meta.sourcesQueried} sources OK`);
    console.log(`[Moraqeb] ${currentData.ideas.length} ideas (${synthesized.ideasSource}) | ${currentData.news.length} news | ${currentData.newsFeed.length} feed items`);
    if (delta?.summary) console.log(`[Moraqeb] Delta: ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical, direction: ${delta.summary.direction}`);
    console.log(`[Moraqeb] Next sweep at ${new Date(Date.now() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()}`);

  } catch (err) {
    console.error('[Moraqeb] Sweep failed:', err.message);
    broadcast({ type: 'sweep_error', error: err.message });
  } finally {
    sweepInProgress = false;
  }
}

// === Blog Cycle (decoupled from sweep) ===
let blogInProgress = false;
let lastBlogTime = null;

async function runBlogCycle() {
  if (blogInProgress) {
    console.log('[Moraqeb Blog] Generation already in progress, skipping');
    return;
  }
  if (!config.minimaxApiKey) {
    console.log('[Moraqeb Blog] No MiniMax API key — skipping');
    return;
  }
  if (!currentData) {
    console.log('[Moraqeb Blog] No sweep data yet — skipping');
    return;
  }

  blogInProgress = true;
  console.log(`[Moraqeb Blog] Starting blog generation cycle...`);

  try {
    const delta = memory.getLastDelta();
    const previousSitrep = blogStore.getLatest();
    const result = await generateSITREP(config.minimaxApiKey, config.minimaxModel, currentData, delta, previousSitrep);
    if (result) {
      const { sitrep, tokenUsage } = result;
      blogStore.save(sitrep);
      broadcast({ type: 'blog_update', timestamp: sitrep.timestamp });
      lastBlogTime = new Date().toISOString();
      // Record token usage
      if (tokenUsage?.blog) tokenTracker.record('blog', tokenUsage.blog.inputTokens, tokenUsage.blog.outputTokens);
      if (tokenUsage?.blogSummary) tokenTracker.record('blogSummary', tokenUsage.blogSummary.inputTokens, tokenUsage.blogSummary.outputTokens);
      console.log(`[Moraqeb Blog] SITREP generated (EN + AR) with summaries`);
    }
  } catch (err) {
    console.error('[Moraqeb Blog] Generation failed:', err.message);
  } finally {
    blogInProgress = false;
  }
}

// === Post Cycle (every 15 minutes) ===
let postInProgress = false;
let lastPostTime = null;
let lastPostDataHash = null;

async function runPostCycle() {
  if (postInProgress) {
    console.log('[Moraqeb Post] Generation already in progress, skipping');
    return;
  }
  if (!config.minimaxApiKey) {
    console.log('[Moraqeb Post] No MiniMax API key — skipping');
    return;
  }
  if (!currentData) {
    console.log('[Moraqeb Post] No sweep data yet — skipping');
    return;
  }

  // Skip if sweep data hasn't changed since last post
  const dataHash = createHash('md5').update(JSON.stringify(currentData)).digest('hex').substring(0, 16);
  if (dataHash === lastPostDataHash) {
    console.log('[Moraqeb Post] Sweep data unchanged since last post — skipping');
    return;
  }

  postInProgress = true;
  console.log('[Moraqeb Post] Starting post generation...');

  try {
    const delta = memory.getLastDelta();
    const recentTopics = postStore.getRecentTopics(24);
    const dedupCheck = (enContent) => postStore.checkDuplicate(enContent);
    const result = await generatePost(config.minimaxApiKey, config.minimaxModel, currentData, delta, recentTopics, dedupCheck);
    if (result?.skipped) {
      console.log(`[Moraqeb Post] Skipped — ${result.reason}`);
      lastPostDataHash = dataHash; // Mark data as consumed even on skip
    } else if (result) {
      const { post, tokenUsage } = result;
      // Don't save posts where both languages failed
      const bothFailed = post.en.title === 'Update Unavailable' && post.ar.title === 'التحديث غير متوفر';
      if (bothFailed) {
        console.log('[Moraqeb Post] Both EN + AR failed — not saving fallback post');
      } else {
        postStore.save(post);
        broadcast({ type: 'post_update', timestamp: post.timestamp });
        lastPostTime = new Date().toISOString();
        lastPostDataHash = dataHash;
        if (tokenUsage?.post) tokenTracker.record('post', tokenUsage.post.inputTokens, tokenUsage.post.outputTokens);
        console.log(`[Moraqeb Post] Post generated (EN + AR)`);
      }
    }
  } catch (err) {
    console.error('[Moraqeb Post] Generation failed:', err.message);
  } finally {
    postInProgress = false;
  }
}

// === Startup ===
async function start() {
  const port = config.port;

  console.log(`
  ╔══════════════════════════════════════════════╗
  ║        MORAQEB (مراقب) — THE OBSERVER        ║
  ║       AI Intelligence Engine · 27 Sources    ║
  ╠══════════════════════════════════════════════╣
  ║  Dashboard:  http://localhost:${port}${' '.repeat(14 - String(port).length)}║
  ║  Health:     http://localhost:${port}/api/health${' '.repeat(4 - String(port).length)}║
  ║  Refresh:    Every ${config.refreshIntervalMinutes} min${' '.repeat(20 - String(config.refreshIntervalMinutes).length)}║
  ║  LLM:        ${(config.llm.provider || 'disabled').padEnd(31)}║
  ║  Telegram:   ${config.telegram.botToken ? 'enabled' : 'disabled'}${' '.repeat(config.telegram.botToken ? 24 : 23)}║
  ║  Discord:    ${config.discord?.botToken ? 'enabled' : config.discord?.webhookUrl ? 'webhook only' : 'disabled'}${' '.repeat(config.discord?.botToken ? 24 : config.discord?.webhookUrl ? 20 : 23)}║
  ║  Chat:       /chat                          ║
  ║  Voice:      /voice                         ║
  ║  Blog:       /blog (every ${config.blogIntervalMinutes} min)${' '.repeat(14 - String(config.blogIntervalMinutes).length)}║
  ╚══════════════════════════════════════════════╝
  `);

  const server = createServer(app);

  // === WebSocket Server for Voice ===
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/api/voice') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (clientWs) => {
    const apiKey = config.geminiApiKey;
    if (!apiKey) {
      clientWs.send(JSON.stringify({ type: 'error', message: 'Gemini API key not configured' }));
      clientWs.close();
      return;
    }

    console.log('[Moraqeb Voice] Client connected');
    tokenTracker.recordVoiceSession();

    // Build voice context
    const delta = memory.getLastDelta();
    const context = buildIntelligenceContext(currentData, delta);
    const systemPrompt = getVoiceSystemPrompt(context);

    // Create Gemini Live session
    const session = new GeminiLiveSession(apiKey, systemPrompt);

    session.waitForSetup().then(() => {
      clientWs.send(JSON.stringify({ type: 'ready' }));
      console.log('[Moraqeb Voice] Gemini session ready');
    }).catch(err => {
      console.error('[Moraqeb Voice] Setup failed:', err.message);
      clientWs.send(JSON.stringify({ type: 'error', message: 'Voice session setup failed' }));
      clientWs.close();
    });

    // Relay audio: client → Gemini
    clientWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'audio' && msg.data) {
          session.sendAudio(msg.data);
        }
      } catch { /* ignore malformed messages */ }
    });

    // Relay audio: Gemini → client
    session.onAudio((base64Audio) => {
      if (clientWs.readyState === 1) {
        clientWs.send(JSON.stringify({ type: 'audio', data: base64Audio }));
      }
    });

    session.onTurnComplete(() => {
      if (clientWs.readyState === 1) {
        clientWs.send(JSON.stringify({ type: 'turnComplete' }));
      }
    });

    session.onError((err) => {
      console.error('[Moraqeb Voice] Session error:', err.message);
      if (clientWs.readyState === 1) {
        clientWs.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    });

    // Cleanup on disconnect
    clientWs.on('close', () => {
      console.log('[Moraqeb Voice] Client disconnected');
      session.close();
    });
  });

  server.listen(port);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[Moraqeb] FATAL: Port ${port} is already in use!`);
      console.error(`[Moraqeb] A previous Moraqeb instance may still be running.`);
      console.error(`[Moraqeb] Fix:  taskkill /F /IM node.exe   (Windows)`);
      console.error(`[Moraqeb]       kill $(lsof -ti:${port})   (macOS/Linux)`);
      console.error(`[Moraqeb] Or change PORT in .env\n`);
    } else {
      console.error(`[Moraqeb] Server error:`, err.stack || err.message);
    }
    process.exit(1);
  });

  server.on('listening', async () => {
    console.log(`[Moraqeb] Server running on http://localhost:${port}`);

    // Auto-open browser
    // NOTE: On Windows, `start` in PowerShell is an alias for Start-Service, not cmd's start.
    // We must use `cmd /c start ""` to ensure it works in both cmd.exe and PowerShell.
    const openCmd = process.platform === 'win32' ? 'cmd /c start ""' :
                    process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${openCmd} "http://localhost:${port}"`, (err) => {
      if (err) console.log('[Moraqeb] Could not auto-open browser:', err.message);
    });

    // Try to load existing data first for instant display (await so dashboard shows immediately)
    try {
      const existing = JSON.parse(readFileSync(join(RUNS_DIR, 'latest.json'), 'utf8'));
      const data = await synthesize(existing);
      currentData = data;
      console.log('[Moraqeb] Loaded existing data from runs/latest.json — dashboard ready instantly');
      broadcast({ type: 'update', data: currentData });
    } catch {
      console.log('[Moraqeb] No existing data found — first sweep required');
    }

    // Run first sweep (refreshes data in background)
    console.log('[Moraqeb] Running initial sweep...');
    runSweepCycle().catch(err => {
      console.error('[Moraqeb] Initial sweep failed:', err.message || err);
    });

    // Schedule recurring sweeps
    setInterval(runSweepCycle, config.refreshIntervalMinutes * 60 * 1000);

    // Schedule blog generation (decoupled from sweep)
    if (config.minimaxApiKey) {
      // First blog after initial sweep finishes (2-minute delay)
      setTimeout(() => {
        runBlogCycle().catch(err => console.error('[Moraqeb Blog] Initial blog failed:', err.message));
      }, 2 * 60 * 1000);
      // Then every blogIntervalMinutes
      setInterval(runBlogCycle, config.blogIntervalMinutes * 60 * 1000);
      console.log(`[Moraqeb Blog] Scheduled every ${config.blogIntervalMinutes} min (MiniMax ${config.minimaxModel})`);

      // Posts: first after 1 minute, then every 15 minutes
      setTimeout(() => {
        runPostCycle().catch(err => console.error('[Moraqeb Post] Initial post failed:', err.message));
      }, 1 * 60 * 1000);
      setInterval(runPostCycle, 15 * 60 * 1000);
      console.log('[Moraqeb Post] Scheduled every 15 min (MiniMax ' + config.minimaxModel + ')');
    }
  });
}

// Graceful error handling — log full stack traces for diagnosis
process.on('unhandledRejection', (err) => {
  console.error('[Moraqeb] Unhandled rejection:', err?.stack || err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[Moraqeb] Uncaught exception:', err?.stack || err?.message || err);
});

start().catch(err => {
  console.error('[Moraqeb] FATAL — Server failed to start:', err?.stack || err?.message || err);
  process.exit(1);
});
