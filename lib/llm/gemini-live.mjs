// Gemini 2.5 Flash Live — Real-time audio WebSocket session
// Part of Moraqeb (مراقب) Voice AI Assistant

import WebSocket from 'ws';

const TAG = '[Moraqeb Voice]';
const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000]; // exponential backoff

export class GeminiLiveSession {
  /**
   * @param {string} apiKey  — Gemini API key
   * @param {string} systemPrompt — system instruction text
   */
  constructor(apiKey, systemPrompt) {
    this._apiKey = apiKey;
    this._systemPrompt = systemPrompt;

    // Callbacks
    this._onAudioCb = null;
    this._onTurnCompleteCb = null;
    this._onErrorCb = null;

    // State
    this._ws = null;
    this._setupDone = false;
    this._setupResolve = null;
    this._setupReject = null;
    this._setupPromise = null;
    this._closed = false;
    this._reconnectAttempt = 0;
    this._reconnecting = false;

    this._connect();
  }

  // ── Public API ──────────────────────────────────────────────

  /** Resolves when the Gemini server acknowledges the setup message. */
  async waitForSetup() {
    if (this._setupDone) return;
    if (!this._setupPromise) {
      this._setupPromise = new Promise((resolve, reject) => {
        this._setupResolve = resolve;
        this._setupReject = reject;
      });
    }
    return this._setupPromise;
  }

  /** Send a chunk of base64-encoded PCM 16 kHz mono audio to Gemini. */
  sendAudio(base64PcmChunk) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const msg = {
      realtimeInput: {
        mediaChunks: [{
          mimeType: 'audio/pcm;rate=16000',
          data: base64PcmChunk,
        }],
      },
    };
    try {
      this._ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error(TAG, 'sendAudio error:', err.message);
    }
  }

  /** Register callback for incoming audio chunks: callback(base64PcmChunk) */
  onAudio(callback) { this._onAudioCb = callback; }

  /** Register callback for turn-complete events: callback() */
  onTurnComplete(callback) { this._onTurnCompleteCb = callback; }

  /** Register callback for errors: callback(error) */
  onError(callback) { this._onErrorCb = callback; }

  /** Close the session permanently (no reconnect). */
  close() {
    this._closed = true;
    if (this._ws) {
      try { this._ws.close(1000, 'client close'); } catch { /* ignore */ }
      this._ws = null;
    }
    console.log(TAG, 'Session closed');
  }

  // ── Internal ────────────────────────────────────────────────

  _connect() {
    if (this._closed) return;

    const url = `${WS_BASE}?key=${this._apiKey}`;
    console.log(TAG, 'Connecting to Gemini Live API...');

    this._ws = new WebSocket(url);

    this._ws.on('open', () => {
      console.log(TAG, 'WebSocket connected — sending setup');
      this._reconnectAttempt = 0;
      this._sendSetup();
    });

    this._ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._handleMessage(msg);
      } catch (err) {
        console.error(TAG, 'Failed to parse message:', err.message);
      }
    });

    this._ws.on('error', (err) => {
      console.error(TAG, 'WebSocket error:', err.message);
      this._emitError(err);
    });

    this._ws.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : 'unknown';
      console.log(TAG, `WebSocket closed: code=${code} reason=${reasonStr}`);
      if (!this._closed) {
        this._scheduleReconnect();
      }
    });
  }

  _sendSetup() {
    const setupMsg = {
      setup: {
        model: MODEL,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Orus',
              },
            },
          },
        },
        systemInstruction: {
          parts: [{ text: this._systemPrompt }],
        },
      },
    };

    try {
      this._ws.send(JSON.stringify(setupMsg));
    } catch (err) {
      console.error(TAG, 'Failed to send setup:', err.message);
      this._emitError(err);
    }
  }

  _handleMessage(msg) {
    // Setup acknowledgement
    if (msg.setupComplete !== undefined) {
      console.log(TAG, 'Setup complete — session ready');
      this._setupDone = true;
      if (this._setupResolve) {
        this._setupResolve();
        this._setupResolve = null;
        this._setupReject = null;
      }
      return;
    }

    // Server content — audio output from model
    if (msg.serverContent) {
      const sc = msg.serverContent;

      // Check for turn completion
      if (sc.turnComplete) {
        if (this._onTurnCompleteCb) {
          try { this._onTurnCompleteCb(); } catch (err) {
            console.error(TAG, 'turnComplete callback error:', err.message);
          }
        }
        return;
      }

      // Extract audio parts from modelTurn
      if (sc.modelTurn && sc.modelTurn.parts) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData && part.inlineData.data) {
            const audioData = part.inlineData.data;
            if (this._onAudioCb) {
              try { this._onAudioCb(audioData); } catch (err) {
                console.error(TAG, 'onAudio callback error:', err.message);
              }
            }
          }
        }
      }
    }

    // Tool calls or other messages we don't handle yet
    if (msg.toolCall) {
      console.log(TAG, 'Received tool call (not implemented):', JSON.stringify(msg.toolCall).substring(0, 200));
    }
  }

  _emitError(err) {
    if (this._onErrorCb) {
      try { this._onErrorCb(err); } catch { /* swallow */ }
    }
    // Reject pending setup if still waiting
    if (this._setupReject) {
      this._setupReject(err);
      this._setupResolve = null;
      this._setupReject = null;
    }
  }

  _scheduleReconnect() {
    if (this._closed || this._reconnecting) return;
    this._reconnecting = true;

    const delay = RECONNECT_DELAYS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this._reconnectAttempt++;

    console.log(TAG, `Reconnecting in ${delay}ms (attempt ${this._reconnectAttempt})...`);

    // Reset setup state for the new connection
    this._setupDone = false;
    this._setupPromise = new Promise((resolve, reject) => {
      this._setupResolve = resolve;
      this._setupReject = reject;
    });

    setTimeout(() => {
      this._reconnecting = false;
      if (!this._closed) {
        this._connect();
      }
    }, delay);
  }
}
