// Per-model behavior verified on the development Mac. Unknown models use the defaults.
// reasoning: wire values accepted for reasoning_effort ('' = model default is always allowed).
// normalizedCoordinates: the model grounds clicks on a 0–1000 grid instead of screenshot pixels,
// so its screenshots can be downscaled without changing its coordinate space.
const PROFILES = {
  'incoai/Qwen3.6-35B-A3B-Splash': { label: 'Splash 35B · A3B', reasoning: ['none'], normalizedCoordinates: true },
  'incoai/Qwen3.8-27B-Splash': { label: 'Splash 27B', reasoning: ['none', 'low', 'medium', 'xhigh'] },
  'froggeric/Qwen3.6-35B-A3B-Uncensored-Heretic-MLX-6bit': { label: 'Splash 35B · A3B · Abliterated 6-bit', reasoning: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], normalizedCoordinates: true },
  'tcstacks/Qwen3.6-35B-A3B-Heretic-Splash': { label: 'Splash 35B · A3B · Abliterated', reasoning: ['none'], normalizedCoordinates: true },
  'audreyt/Qwen3.8-27B-Splash-abliterated': { label: 'Splash 27B · Abliterated', reasoning: ['none', 'low', 'medium', 'xhigh'] },
};
const DEFAULT = { reasoning: [], normalizedCoordinates: false };
const profile = model => ({ ...DEFAULT, ...PROFILES[model] });

module.exports = { profile, PROFILES };
