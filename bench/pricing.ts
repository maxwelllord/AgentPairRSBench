// OpenRouter list prices, $ per token (reasoning tokens bill as output). Cache writes bill at
// cacheWrite when listed, else at the input price.
export const PRICING: Record<string, { input: number; cachedInput: number; output: number; cacheWrite?: number }> = {
    'openrouter/deepseek/deepseek-v4.1-flash': { input: 0.15e-6, cachedInput: 0.003e-6, output: 0.6e-6 },
    'openrouter/openai/gpt-6.1-sol': { input: 2e-6, cachedInput: 0.1e-6, output: 10e-6, cacheWrite: 2.5e-6 },
    // gpt-6.1-terra direct from OpenAI: OpenRouter's list price for it ($1 in, $0.05 cached, $5 out per 1M;
    // under 272k prompt tokens). r087 token-prices at $1.20 against $1.21 on the OpenAI dashboard.
    'openai/gpt-6.1-terra': { input: 1e-6, cachedInput: 0.05e-6, output: 5e-6 },
    'openrouter/meta/muse-glimmer-30b': { input: 0.3e-6, cachedInput: 0.04e-6, output: 1.2e-6 },
    'openrouter/qwen/qwen3.8-flash': { input: 0.15e-6, cachedInput: 0.016e-6, output: 0.47e-6 },
    // fp8 hosts range $0.08-0.30 in; DeepSeek's own list price, so the budget cap errs high
    'openrouter/deepseek/deepseek-v4.1-flash-1017': { input: 0.3e-6, cachedInput: 0.006e-6, output: 1.2e-6 },
    'openrouter/anthropic/claude-sonnet-5.5': { input: 2e-6, cachedInput: 0.1e-6, output: 10e-6, cacheWrite: 2.5e-6 },
    // fp8 hosts range $0.19-2.10 in; Z.AI's own list price, so the budget cap errs high
    'openrouter/z-ai/glm-5.3': { input: 1.4e-6, cachedInput: 0.26e-6, output: 4.4e-6 },
    // fp8 hosts range $0.075-0.18 in; Z.AI's own list price, as for GLM-5.3
    'openrouter/z-ai/glm-5.3-flash': { input: 0.15e-6, cachedInput: 0.03e-6, output: 0.5e-6 },
    // mxfp4/fp8 hosts range $0.36-3.00 in; Moonshot's own list price, so the budget cap errs high
    'openrouter/moonshotai/kimi-k3': { input: 3e-6, cachedInput: 0.3e-6, output: 15e-6 },
    // Moonshot only (mxfp4); its standard tier's list price. The 2x "highspeed" priority tier is excluded via only
    'openrouter/moonshotai/kimi-k3.1-pro': { input: 2e-6, cachedInput: 0.2e-6, output: 10e-6 },
    'openrouter/anthropic/claude-haiku-5.5': { input: 0.1e-6, cachedInput: 0.01e-6, output: 0.5e-6, cacheWrite: 0.125e-6 },
    'openrouter/anthropic/claude-opus-5.5': { input: 4e-6, cachedInput: 0.2e-6, output: 20e-6, cacheWrite: 5e-6 },
    'openrouter/google/gemini-3.8-flash': { input: 0.825e-6, cachedInput: 0.0825e-6, output: 4.125e-6, cacheWrite: 0.0417e-6 },
    // fp8/bf16 hosts range $0.13-0.175 in; the dearest (Venice), so the budget cap errs high
    'openrouter/xiaomi/mimo-v2.6-flash': { input: 0.175e-6, cachedInput: 0.00375e-6, output: 0.35e-6 },
    'openrouter/google/gemini-4-argon': { input: 2e-6, cachedInput: 0.1e-6, output: 10e-6, cacheWrite: 0.1875e-6 },
    'openrouter/meta/muse-wonder': { input: 4e-6, cachedInput: 0.2e-6, output: 20e-6 },
    // free variant (paid is $0.60/$2.40)
    'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free': { input: 0, cachedInput: 0, output: 0 },
    // hosts range $0.40-0.625 in; the dearest (Venice), so the budget cap errs high
    'openrouter/nvidia/nemotron-3-ultra-550b-a55b': { input: 0.625e-6, cachedInput: 0.1875e-6, output: 3.125e-6 },
    // fp8 hosts range $0.75-0.834 in; the dearest, so the budget cap errs high
    'openrouter/tencent/hy4-preview': { input: 0.834e-6, cachedInput: 0.042e-6, output: 2.501e-6 },
    'openrouter/openai/gpt-6-luna': { input: 0.1e-6, cachedInput: 0.01e-6, output: 0.5e-6, cacheWrite: 0.125e-6 },
    'openrouter/upstage/solar-mini4': { input: 0.05e-6, cachedInput: 0.005e-6, output: 0.2e-6 },
    'openrouter/meta/muse-spark-1.3-contributor': { input: 0.1e-6, cachedInput: 0.002e-6, output: 0.2e-6 },
    // fp8/bf16 hosts mostly $0.14-0.20 in (SiliconFlow $0.75); most list no cache price
    'openrouter/google/gemma-4-31b-it': { input: 0.2e-6, cachedInput: 0.2e-6, output: 0.4e-6 }
};

/** Cost of one OpenCode step_finish event's tokens; 0 for models without a price. */
export function stepCost(model: string, tokens: any): number {
    const price = PRICING[model];
    if (!price || !tokens) return 0;
    return (tokens.input ?? 0) * price.input + (tokens.cache?.read ?? 0) * price.cachedInput
        + (tokens.cache?.write ?? 0) * (price.cacheWrite ?? price.input)
        + ((tokens.output ?? 0) + (tokens.reasoning ?? 0)) * price.output;
}
