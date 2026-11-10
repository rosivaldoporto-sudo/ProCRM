/**
 * Som de nova mensagem, sintetizado com Web Audio.
 *
 * Sem arquivo de áudio: nada para baixar, cachear ou liberar no CSP, e
 * funciona offline. São duas notas curtas (Lá5 → Ré6), baixas o bastante
 * para não assustar em um escritório.
 */

type AudioContextCtor = typeof AudioContext;

let context: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (context) return context;
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor })
      .webkitAudioContext;
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    context = null;
  }
  return context;
}

/**
 * Os navegadores só deixam tocar áudio depois de um gesto do usuário.
 * Chamar isto no primeiro clique/tecla "destrava" o contexto para os
 * alertas que chegarem depois.
 */
export function primeAlertSound(): void {
  const ctx = getContext();
  if (ctx?.state === 'suspended') void ctx.resume().catch(() => undefined);
}

export function playMessageChime(): void {
  const ctx = getContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const now = ctx.currentTime;
    const notes: [frequency: number, offset: number][] = [
      [880, 0],
      [1174.66, 0.13],
    ];
    for (const [frequency, offset] of notes) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = now + offset;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      // Envelope curto: sem ele o corte seco do oscilador vira um estalo.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.32);
    }
  } catch {
    // Áudio indisponível (política do navegador, dispositivo sem saída).
  }
}
