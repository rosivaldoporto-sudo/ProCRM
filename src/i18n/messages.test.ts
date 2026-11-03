import { describe, expect, it } from 'vitest';
import { IntlMessageFormat } from 'intl-messageformat';
import messages from '../../messages/pt-BR.json';

type Node = string | { [key: string]: Node };

function leaves(node: Node, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  return Object.entries(node).flatMap(([key, value]) =>
    leaves(value, prefix ? `${prefix}.${key}` : key)
  );
}

describe('messages/pt-BR.json', () => {
  // Uma mensagem ICU inválida (ex.: `{{1}}` sem aspas) não quebra a build: na
  // tela aparece o nome da chave em inglês no lugar do texto.
  it('only has messages the ICU parser accepts', () => {
    const invalid = leaves(messages as Node).filter(([, text]) => {
      try {
        new IntlMessageFormat(text, 'pt-BR');
        return false;
      } catch {
        return true;
      }
    });

    expect(invalid).toEqual([]);
  });
});
