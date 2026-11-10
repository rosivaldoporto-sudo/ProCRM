'use client';

import { useSyncExternalStore } from 'react';

/**
 * Preferências dos alertas de nova mensagem com o app aberto (som e
 * aviso na tela). Ficam no navegador, como tema e painéis: cada
 * dispositivo decide por si — o celular pode tocar e o computador não.
 */
export interface InboxAlertPrefs {
  /** Toca um som curto quando chega mensagem. */
  sound: boolean;
  /** Mostra um aviso na tela quando o agente está em outra página. */
  toast: boolean;
}

const STORAGE_KEY = 'wacrm:inbox-alerts';
const DEFAULTS: InboxAlertPrefs = { sound: true, toast: true };

let cached: InboxAlertPrefs | null = null;
const listeners = new Set<() => void>();

function read(): InboxAlertPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<InboxAlertPrefs> | null;
    return {
      sound: typeof parsed?.sound === 'boolean' ? parsed.sound : DEFAULTS.sound,
      toast: typeof parsed?.toast === 'boolean' ? parsed.toast : DEFAULTS.toast,
    };
  } catch {
    // Navegação privada / storage bloqueado / JSON inválido.
    return DEFAULTS;
  }
}

export function getInboxAlertPrefs(): InboxAlertPrefs {
  if (typeof window === 'undefined') return DEFAULTS;
  if (!cached) cached = read();
  return cached;
}

export function setInboxAlertPrefs(patch: Partial<InboxAlertPrefs>): void {
  cached = { ...getInboxAlertPrefs(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // Persistência é melhor-esforço; a escolha vale até recarregar.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Outra aba mudou a preferência.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cached = read();
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

const getServerSnapshot = () => DEFAULTS;

export function useInboxAlertPrefs(): InboxAlertPrefs {
  return useSyncExternalStore(subscribe, getInboxAlertPrefs, getServerSnapshot);
}
