// services/image.js
const { logSystemEvent } = require('../logger.js');
const { generateTextWithFallback } = require('./ai.js');

// ===== CONFIG =====
const IMAGE_RATE_LIMIT_MAX    = 3;
const IMAGE_RATE_LIMIT_WINDOW = 60;  // seconds
const IMAGE_MAX_PROMPT_LENGTH = 500;
const IMAGE_MODEL             = process.env.IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell';
const IMAGE_STEPS             = 4; // the cost per image scales with this; 8 is the model's maximum
const IMAGE_RETRY_MAX         = 3;
const IMAGE_RETRY_BASE_MS     = 2000;
const RETRYABLE_STATUS_CODES  = new Set([429, 500, 502, 503, 504]);

// Discord needs the right file extension, and the API doesn't state the format.
function detectImageType(buffer) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
    if (buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return 'image/jpeg';
}

// ===== RATE LIMIT STORE =====
// Map<userId, { count: number, windowStart: number }>
const imageRateLimitStore = new Map();

// Prune stale rate limit entries every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [userId, data] of imageRateLimitStore) {
        if (now - data.windowStart > IMAGE_RATE_LIMIT_WINDOW * 1000) {
            imageRateLimitStore.delete(userId);
        }
    }
}, 10 * 60 * 1000);

// ===== IMAGE KEYWORD DETECTION =====
const IMAGE_TRIGGER_PATTERNS = [
    /\b(draw|paint|sketch|illustrate|generate|create|make|show)\s+(me\s+)?(a\s+|an\s+|the\s+)?(picture|image|photo|artwork|illustration|drawing|painting|portrait|wallpaper|scene|art)\b/i,
    /\b(picture|image|photo|artwork|illustration|drawing|painting)\s+of\b/i,
    /\bcan you (draw|paint|illustrate|generate|create|make|visualize)\b/i,
    /\bgenerate\s+(a\s+|an\s+)?(image|picture|photo|artwork|illustration)\b/i,
    /\bshow\s+me\s+(what|how|a|an|the)\b/i,
];

function detectImageRequest(messageText) {
    return IMAGE_TRIGGER_PATTERNS.some(pattern => pattern.test(messageText));
}

// ===== PROMPT SANITIZATION =====
const NSFW_TERMS = [
    'nude', 'naked', 'nsfw', 'explicit', 'porn', 'hentai', 'sexual',
    'genitals', 'breasts', 'topless', 'xxx', 'erotic', 'lewd',
    'underage', 'child', 'minor', 'loli', 'shota',
    'gore', 'graphic violence', 'mutilation', 'torture',
];

const NSFW_REPLACEMENTS = {
    'nude':     'clothed person',
    'naked':    'clothed person',
    'nsfw':     'appropriate',
    'explicit': 'tasteful',
    'gore':     'peaceful scene',
    'violence': 'calm scene',
};

function sanitizeImagePrompt(prompt) {
    let sanitized = prompt.substring(0, IMAGE_MAX_PROMPT_LENGTH);
    for (const term of NSFW_TERMS) {
        const replacement = NSFW_REPLACEMENTS[term] || '';
        sanitized = sanitized.replace(new RegExp(`\\b${term}\\b`, 'gi'), replacement);
    }
    return sanitized.replace(/\s{2,}/g, ' ').trim();
}

// ===== RATE LIMIT CHECK =====
function checkImageRateLimit(userId) {
    const now  = Date.now();
    const data = imageRateLimitStore.get(userId);

    if (!data || (now - data.windowStart) > IMAGE_RATE_LIMIT_WINDOW * 1000) {
        imageRateLimitStore.set(userId, { count: 1, windowStart: now });
        return { allowed: true, remaining: IMAGE_RATE_LIMIT_MAX - 1 };
    }

    if (data.count >= IMAGE_RATE_LIMIT_MAX) {
        const secondsLeft = Math.ceil(IMAGE_RATE_LIMIT_WINDOW - (now - data.windowStart) / 1000);
        return { allowed: false, secondsLeft, remaining: 0 };
    }

    data.count++;
    imageRateLimitStore.set(userId, data);
    return { allowed: true, remaining: IMAGE_RATE_LIMIT_MAX - data.count };
}

// ===== PROMPT ENHANCEMENT =====
async function enhanceImagePrompt(rawPrompt) {
    try {
        const { text } = await generateTextWithFallback({
            messages: [
                {
                    role: 'system',
                    content: `You are an expert at writing image generation prompts.
Take the user's simple request and expand it into a rich, detailed prompt.
Rules:
- Add art style, lighting, mood, camera angle if they make sense
- Keep it under 150 words
- Do NOT add anything NSFW or that violates content policy
- Return ONLY the improved prompt, no explanation, no quotes`,
                },
                { role: 'user', content: rawPrompt },
            ],
        });
        const enhanced = text.trim();

        // If the model "enhanced" the prompt into a refusal / content-policy
        // message, don't feed that refusal into the image model. Fall back to
        // the raw prompt. Try to detect refusals generically across phrasing.
        const lower = enhanced.toLowerCase();
        if (!enhanced ||
            lower.includes('cannot fulfill') ||
            lower.includes('unable to fulfill') ||
            lower.includes('can\'t fulfill') ||
            lower.includes('can’t fulfill') ||
            lower.includes('violates (my )?content policy') ||
            lower.includes('against my (content )?policies') ||
            lower.includes('i (can\'t|can’t|cannot|am unable) (create|generate|depict|produce)') ||
            lower.includes('won\'t') ||
            lower.includes('won’t') ||
            lower.includes('not (able|allowed) to (create|generate|depict|produce|draw)') ||
            /^(i\s+(can'?t|cannot|am unable to|won'?t)|sorry[,.!]|i'm sorry|i\'m sorry)/i.test(enhanced) ||
            lower.length < 3) {
            console.warn('[Image] Prompt enhancement returned a refusal; using raw prompt');
            return rawPrompt;
        }

        console.log(`[Image] Prompt enhanced: "${rawPrompt}" → "${enhanced.substring(0, 80)}..."`);
        return enhanced;
    } catch (error) {
        console.warn('[Image] Prompt enhancement failed, using raw prompt:', error.message);
        return rawPrompt;
    }
}

// ===== SLEEP HELPER =====
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== CORE IMAGE GENERATION =====
// Uses CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN via the Workers AI REST API.
// This matches the original implementation from the pre-refactor index.js.
async function generateImage(prompt, userId = 'unknown', options = {}) {
    const { enhance = true, platform = 'discord' } = options;

    // 1. Rate limit check
    const rateCheck = checkImageRateLimit(userId);
    if (!rateCheck.allowed) {
        return {
            success: false,
            error: `⏳ You're generating images too fast! Try again in **${rateCheck.secondsLeft}s**.`,
        };
    }

    // 2. Sanitize
    const sanitized = sanitizeImagePrompt(prompt);
    if (!sanitized || sanitized.length < 3) {
        return { success: false, error: '❌ Prompt was empty after filtering. Try describing something different.' };
    }

    // 3. Optionally enhance the prompt via AI
    const finalPrompt = enhance ? await enhanceImagePrompt(sanitized) : sanitized;

    // 4. Generate via Cloudflare Workers AI
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken  = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) {
        logSystemEvent('IMAGE_ERROR', 'ERROR', 'image', 'CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN is not set');
        return { success: false, error: '🔑 Image generation is not configured. Contact the server admin.' };
    }

    const url  = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${IMAGE_MODEL}`;
    const body = { prompt: finalPrompt, steps: IMAGE_STEPS };

    let lastError = null;

    for (let attempt = 1; attempt <= IMAGE_RETRY_MAX; attempt++) {
        if (attempt > 1) {
            const waitMs = IMAGE_RETRY_BASE_MS * Math.pow(2, attempt - 2);
            console.log(`[Image] Retry ${attempt}/${IMAGE_RETRY_MAX} — waiting ${waitMs}ms`);
            await sleep(waitMs);
        }

        try {
            console.log(`[Image] Generating for ${userId} on ${platform} (attempt ${attempt}) — "${finalPrompt.substring(0, 80)}..."`);
            logSystemEvent('IMAGE_GENERATE', 'INFO', 'image', `Generating image for ${userId}: "${finalPrompt.substring(0, 80)}"`);

            const res = await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
                body:    JSON.stringify(body),
            });

            if (!res.ok) {
                const errText = await res.text();
                if (RETRYABLE_STATUS_CODES.has(res.status)) {
                    lastError = new Error(`HTTP ${res.status}: ${errText.substring(0, 120)}`);
                    console.warn(`[Image] Retryable error on attempt ${attempt}:`, lastError.message);
                    continue;
                }
                throw new Error(`HTTP ${res.status}: ${errText.substring(0, 200)}`);
            }

            const data = await res.json();
            if (!data?.result?.image) throw new Error('Workers AI response contained no image');

            const buffer = Buffer.from(data.result.image, 'base64');
            const mimeType = detectImageType(buffer);

            console.log(`[Image] Success — ${buffer.length} bytes (${mimeType})`);
            logSystemEvent('IMAGE_SUCCESS', 'INFO', 'image', `Image generated for ${userId} — ${buffer.length} bytes`);

            return {
                success:        true,
                buffer,
                mimeType,
                finalPrompt,
                originalPrompt: prompt,
                remaining:      rateCheck.remaining,
            };

        } catch (error) {
            lastError = error;
            const msg = (error.message || '').toLowerCase();
            const isRetryable = RETRYABLE_STATUS_CODES.has(parseInt(msg.match(/\d{3}/)?.[0])) ||
                                msg.includes('fetch failed') ||
                                msg.includes('network');
            if (!isRetryable || attempt === IMAGE_RETRY_MAX) break;
            console.warn(`[Image] Attempt ${attempt} failed, will retry:`, error.message);
        }
    }

    // All attempts failed
    console.error('[Image Generation Error]', lastError);
    logSystemEvent('IMAGE_ERROR', 'ERROR', 'image', `Image generation failed for ${userId} after ${IMAGE_RETRY_MAX} attempts: ${lastError?.message}`, lastError);

    let friendlyError = '❌ Image generation failed. Try again in a moment.';
    const msg = (lastError?.message || '').toLowerCase();
    if (lastError?.isSafety || msg.includes('nsfw') || msg.includes('safety') || msg.includes('content policy') || msg.includes('refused')) {
        friendlyError = '🚫 That prompt triggered the content filter. Try describing something differently.';
    }
    if (msg.includes('rate limit') || msg.includes('429')) friendlyError = '⏳ Too many requests to the image API. Try again in ~30 seconds.';
    if (msg.includes('timeout') || msg.includes('timed'))  friendlyError = '⌛ Image generation timed out. Try a simpler prompt.';
    if (msg.includes('auth') || msg.includes('key'))       friendlyError = '🔑 API authentication error. Contact the server admin.';

    return { success: false, error: friendlyError };
}

// ===== EXPORTS =====
module.exports = {
    generateImage,
    checkImageRateLimit,
    detectImageRequest,
    sanitizeImagePrompt,
    enhanceImagePrompt,
};
