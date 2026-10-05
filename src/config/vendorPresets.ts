/**
 * Union vendor presets for the Lumen provider switcher.
 *
 * Simplified from the cc-switch per-app catalogs (`claude/codex/gemini/
 * grokBuild/pi/opencode/openclaw/hermes *Presets.ts`): one canonical entry
 * per vendor/tool instead of dozens of regional and plan variants.
 *
 * `app` names the owning tool config. Entries whose tool has no Rust
 * file-switch support yet (grok, hermes, pi, minimax, kimi, meta, devin,
 * vertex, antigravity, xai) are forward-compatible data for later tasks.
 */

export type Vendor =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'grok'
  | 'opencode'
  | 'openclaw'
  | 'hermes'
  | 'pi'
  | 'minimax'
  | 'kimi'
  | 'meta'
  | 'devin'
  | 'vertex'
  | 'antigravity'
  | 'xai';

export interface VendorPreset {
  vendor: Vendor;
  /** Owning tool config the preset writes to (forwards-compatible when the tool has no switch engine yet). */
  app: string;
  name: string;
  baseUrl: string;
  apiKeyField: string;
  defaultModel: string;
  requiresOAuth?: boolean;
}

export const vendorPresets: VendorPreset[] = [
  {
    vendor: 'claude',
    app: 'claude',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKeyField: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-4-5',
  },
  {
    vendor: 'codex',
    app: 'codex',
    name: 'OpenAI Codex',
    baseUrl: 'https://api.openai.com',
    apiKeyField: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5',
    requiresOAuth: true,
  },
  {
    vendor: 'gemini',
    app: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKeyField: 'GEMINI_API_KEY',
    defaultModel: 'gemini-3.6-flash',
  },
  {
    // Grok CLI tool; xAI upstream key entry is the separate `xai` preset.
    vendor: 'grok',
    app: 'grok',
    name: 'Grok CLI',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyField: 'XAI_API_KEY',
    defaultModel: 'grok-4.5',
  },
  {
    vendor: 'opencode',
    app: 'opencode',
    name: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen',
    apiKeyField: 'OPENCODE_API_KEY',
    defaultModel: 'claude-sonnet-4-5',
  },
  {
    // Local gateway default; the key slot holds the gateway token.
    vendor: 'openclaw',
    app: 'openclaw',
    name: 'OpenClaw Gateway',
    baseUrl: 'http://127.0.0.1:18789',
    apiKeyField: 'OPENCLAW_API_KEY',
    defaultModel: 'claude-sonnet-4-5',
  },
  {
    // Nous Research official endpoint carried by the cc-switch hermes preset.
    vendor: 'hermes',
    app: 'hermes',
    name: 'Nous Hermes',
    baseUrl: 'https://inference-api.nousresearch.com/v1',
    apiKeyField: 'NOUS_API_KEY',
    defaultModel: 'Hermes-4-405B',
  },
  {
    // Pi speaks Anthropic Messages natively, so its default is the Anthropic endpoint.
    vendor: 'pi',
    app: 'pi',
    name: 'Pi Agent',
    baseUrl: 'https://api.anthropic.com',
    apiKeyField: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-4-5',
  },
  {
    vendor: 'minimax',
    app: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    apiKeyField: 'MINIMAX_API_KEY',
    defaultModel: 'MiniMax-M3',
  },
  {
    // Flagship Kimi K3 on the domestic platform endpoint.
    vendor: 'kimi',
    app: 'kimi',
    name: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyField: 'MOONSHOT_API_KEY',
    defaultModel: 'kimi-k3',
  },
  {
    vendor: 'meta',
    app: 'meta',
    name: 'Meta Llama',
    baseUrl: 'https://api.llama.com/v1',
    apiKeyField: 'LLAMA_API_KEY',
    defaultModel: 'Llama-4-Maverick-17B-Instruct',
  },
  {
    // Devin API-compatible slot; retarget baseUrl for self-hosted gateways.
    vendor: 'devin',
    app: 'devin',
    name: 'Devin',
    baseUrl: 'https://api.devin.ai/v1',
    apiKeyField: 'DEVIN_API_KEY',
    defaultModel: 'devin',
  },
  {
    vendor: 'vertex',
    app: 'vertex',
    name: 'Google Vertex AI',
    baseUrl: 'https://us-central1-aiplatform.googleapis.com',
    apiKeyField: 'GOOGLE_API_KEY',
    defaultModel: 'gemini-3.6-flash',
  },
  {
    // Antigravity signs in with Google OAuth; a key is optional.
    vendor: 'antigravity',
    app: 'antigravity',
    name: 'Google Antigravity',
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    apiKeyField: 'GOOGLE_API_KEY',
    defaultModel: 'claude-sonnet-4-5',
    requiresOAuth: true,
  },
  {
    // xAI upstream API entry; the Grok CLI tool entry is the `grok` preset.
    vendor: 'xai',
    app: 'xai',
    name: 'xAI API',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyField: 'XAI_API_KEY',
    defaultModel: 'grok-4.5',
  },
];

export function getVendorPreset(vendor: Vendor): VendorPreset | undefined {
  return vendorPresets.find((preset) => preset.vendor === vendor);
}
