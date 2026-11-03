import { getRequestConfig } from 'next-intl/server';
import messages from '../../messages/pt-BR.json';

// O produto é só em português: idioma e fuso fixos, sem catálogo por ambiente.
export default getRequestConfig(async () => ({
  locale: 'pt-BR',
  timeZone: 'America/Sao_Paulo',
  messages,
}));
