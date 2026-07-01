'use strict';

/**
 * Gerencia configuração do provedor de IA (provider, model, API key, rate limit).
 * Tudo fica no localStorage — nunca sai do dispositivo.
 */
window.AIConfigService = (function () {
  const KEYS = {
    provider:  'mural_ai_provider',
    model:     'mural_ai_model',
    apiKey:    'mural_ai_key',
    rateLimit: 'mural_ai_rate',
    batchSize: 'mural_ai_batch',
  };

  const AUDIO_KEYS = {
    provider: 'mural_audio_provider',
    model:    'mural_audio_model',
    apiKey:   'mural_audio_key',
  };

  const DEFAULT_MODELS = {
    anthropic: 'claude-haiku-4-5-20251001',
    openai:    'gpt-4o-mini',
    google:    'gemini-1.5-flash',
    xai:       'grok-2-vision-1212',
    mistral:   'pixtral-12b-2409',
  };

  const DEFAULT_AUDIO_MODELS = {
    openai: 'whisper-1',
    groq:   'whisper-large-v3',
    google: 'gemini-1.5-flash',
  };

  function get(key, fallback = '') {
    return localStorage.getItem(key) ?? fallback;
  }

  function getConfig() {
    return {
      provider:  get(KEYS.provider),
      model:     get(KEYS.model),
      apiKey:    get(KEYS.apiKey),
      rateLimit: parseInt(get(KEYS.rateLimit, '20'), 10),
      batchSize: parseInt(get(KEYS.batchSize, '5'), 10),
    };
  }

  function saveConfig({ provider, model, apiKey, rateLimit, batchSize }) {
    if (provider  !== undefined) localStorage.setItem(KEYS.provider,  provider);
    if (model     !== undefined) localStorage.setItem(KEYS.model,     model);
    if (apiKey    !== undefined) localStorage.setItem(KEYS.apiKey,    apiKey);
    if (rateLimit !== undefined) localStorage.setItem(KEYS.rateLimit, String(rateLimit));
    if (batchSize !== undefined) localStorage.setItem(KEYS.batchSize, String(batchSize));
  }

  function isConfigured() {
    const { provider, apiKey } = getConfig();
    return !!provider && apiKey.length > 8;
  }

  function getDefaultModel(provider) {
    return DEFAULT_MODELS[provider] || '';
  }

  // ── Configuração de áudio ────────────────────────────────────────────────
  function getAudioConfig() {
    return {
      provider: get(AUDIO_KEYS.provider),
      model:    get(AUDIO_KEYS.model),
      apiKey:   get(AUDIO_KEYS.apiKey),
    };
  }

  function saveAudioConfig({ provider, model, apiKey }) {
    if (provider !== undefined) localStorage.setItem(AUDIO_KEYS.provider, provider);
    if (model    !== undefined) localStorage.setItem(AUDIO_KEYS.model,    model);
    if (apiKey   !== undefined) localStorage.setItem(AUDIO_KEYS.apiKey,   apiKey);
  }

  function isAudioConfigured() {
    const { provider, apiKey } = getAudioConfig();
    return !!provider && apiKey.length > 8;
  }

  function getDefaultAudioModel(provider) {
    return DEFAULT_AUDIO_MODELS[provider] || '';
  }

  // ── Transcrição de áudio ────────────────────────────────────────────────
  // Recebe um Blob de áudio (m4a/webm/mp3) e retorna o texto transcrito.
  async function transcribeAudio(audioBlob) {
    const { provider, model, apiKey } = getAudioConfig();
    if (!provider || !apiKey) throw new Error('IA de áudio não configurada');

    if (provider === 'openai') return _transcribeOpenAI(audioBlob, model, apiKey);
    if (provider === 'groq')   return _transcribeGroq(audioBlob, model, apiKey);
    if (provider === 'google') return _transcribeGoogle(audioBlob, model, apiKey);
    throw new Error(`Provedor de áudio desconhecido: ${provider}`);
  }

  async function _transcribeOpenAI(audioBlob, model, apiKey) {
    const form = new FormData();
    form.append('file', audioBlob, 'audio.m4a');
    form.append('model', model || DEFAULT_AUDIO_MODELS.openai);
    form.append('language', 'pt');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `OpenAI Whisper HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.text;
  }

  async function _transcribeGroq(audioBlob, model, apiKey) {
    const form = new FormData();
    form.append('file', audioBlob, 'audio.m4a');
    form.append('model', model || DEFAULT_AUDIO_MODELS.groq);
    form.append('language', 'pt');
    form.append('response_format', 'json');
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Groq HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.text;
  }

  async function _transcribeGoogle(audioBlob, model, apiKey) {
    const base64 = await _blobToBase64(audioBlob);
    const mimeType = audioBlob.type || 'audio/m4a';
    const m = model || DEFAULT_AUDIO_MODELS.google;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mimeType, data: base64 } },
              { text: 'Transcreva este áudio em português. Retorne apenas o texto transcrito, sem comentários.' },
            ],
          }],
        }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Gemini HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.candidates[0].content.parts[0].text;
  }

  function _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // ── chamada à API do provedor configurado ───────────────────────────────
  // Recebe um thumb em base64 (JPEG) e retorna JSON com análise da foto.
  async function analyzePhoto(imageBase64) {
    const { provider, model, apiKey } = getConfig();
    if (!provider || !apiKey) throw new Error('IA não configurada');

    const prompt = `Analise esta foto e retorne um JSON com exatamente estas chaves:
{
  "description": "Descrição resumida da foto em português (1-2 frases)",
  "scene": "tipo de cena (ex: praia, restaurante, sala de estar, parque)",
  "occasion": "possível ocasião (ex: aniversário, natal, viagem, cotidiano) ou null",
  "people_count": número aproximado de pessoas visíveis (0 se nenhuma),
  "tags": ["lista", "de", "tags", "relevantes", "em", "português"],
  "objects": ["objetos", "ou", "elementos", "principais"],
  "mood": "clima ou atmosfera da foto (ex: alegre, tranquilo, íntimo)"
}
Responda APENAS com o JSON, sem markdown, sem texto adicional.
Use linguagem cuidadosa para inferências: prefira "possível" ou "provável".`;

    if (provider === 'anthropic') {
      return _callAnthropic(imageBase64, prompt, model, apiKey);
    } else if (provider === 'openai') {
      return _callOpenAI(imageBase64, prompt, model, apiKey);
    } else if (provider === 'google') {
      return _callGemini(imageBase64, prompt, model, apiKey);
    } else if (provider === 'xai') {
      return _callXAI(imageBase64, prompt, model, apiKey);
    } else if (provider === 'mistral') {
      return _callMistral(imageBase64, prompt, model, apiKey);
    }
    throw new Error(`Provedor desconhecido: ${provider}`);
  }

  // ── Anthropic ───────────────────────────────────────────────────────────
  async function _callAnthropic(imageBase64, prompt, model, apiKey) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODELS.anthropic,
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
            { type: 'text',  text: prompt },
          ],
        }],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Anthropic HTTP ${res.status}`);
    }
    const data = await res.json();
    return JSON.parse(data.content[0].text);
  }

  // ── OpenAI ──────────────────────────────────────────────────────────────
  async function _callOpenAI(imageBase64, prompt, model, apiKey) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODELS.openai,
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `OpenAI HTTP ${res.status}`);
    }
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  }

  // ── Google Gemini ────────────────────────────────────────────────────────
  async function _callGemini(imageBase64, prompt, model, apiKey) {
    const m = model || DEFAULT_MODELS.google;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
              { text: prompt },
            ],
          }],
          generationConfig: { maxOutputTokens: 512 },
        }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Gemini HTTP ${res.status}`);
    }
    const data = await res.json();
    const text = data.candidates[0].content.parts[0].text;
    return JSON.parse(text);
  }

  // ── xAI (Grok) — API compatível com OpenAI ──────────────────────────────
  async function _callXAI(imageBase64, prompt, model, apiKey) {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODELS.xai,
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `xAI HTTP ${res.status}`);
    }
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  }

  // ── Mistral (Pixtral) ────────────────────────────────────────────────────
  async function _callMistral(imageBase64, prompt, model, apiKey) {
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODELS.mistral,
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
            { type: 'text',      text: prompt },
          ],
        }],
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Mistral HTTP ${res.status}`);
    }
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  }

  return {
    getConfig, saveConfig, isConfigured, getDefaultModel, analyzePhoto,
    getAudioConfig, saveAudioConfig, isAudioConfigured, getDefaultAudioModel, transcribeAudio,
  };
})();
