# Versionamento e como voltar uma versão

Este projeto guarda **todas as versões** no GitHub. Nada que já foi publicado se
perde: cada publicação vira um ponto de restauração ao qual dá para voltar.

## Como funciona

1. **Cada publicação cria uma "Versão N".**
   Toda vez que o ProCRM é publicado (push na `main`, que a Hostinger usa para
   construir e publicar o CRM), registra-se uma versão nomeada na aba *Releases*
   — por exemplo **"Versão 7 — 25/11/2026 às 16:20"**.

2. **Onde ver todas as versões:**
   Página de *Releases* do repositório →
   <https://github.com/rosivaldoporto-sudo/ProCRM/releases>
   A lista mostra, da mais nova para a mais antiga, cada publicação, com a data e
   o resumo do que mudou.

3. **Cada versão aponta para o estado exato do código naquele momento.**
   É um retrato fiel do que foi publicado.

## Quem cria a versão (e por quê é diferente do roboeditor)

Este repositório é um **fork** (do `wacrm`). O GitHub **não roda workflows de
`push` em forks** — por isso, aqui, o registro da versão **não** é feito por um
job automático do GitHub Actions (como é no roboeditor, que é um repositório
próprio). Em vez disso, **a versão é criada junto com a publicação**: quando o
ProCRM é publicado a partir do Claude (push na `main`), o Claude cria a
"Versão N" correspondente nas *Releases*, no mesmo momento.

Na prática não muda nada para você: continua "peço ao Claude para publicar" e a
versão aparece sozinha nas *Releases*.

## Como voltar para uma versão anterior

Se uma publicação nova apresentar algum problema, **é só pedir aqui no Claude**,
por exemplo:

> "Voltar para a Versão 6."
> ou "A última publicação quebrou X, desfaz."

O que o Claude faz:

1. Confirma com você qual versão é a boa.
2. Desfaz as alterações problemáticas (`git revert`) — isso **cria uma versão
   nova** que é uma cópia fiel da versão boa anterior.
3. Republica: o push na `main` faz a Hostinger publicar de novo, e o Claude
   registra a nova versão. O CRM volta ao estado da versão boa, e o histórico
   continua intacto (nada é apagado).

Ou seja: voltar atrás **nunca destrói** nada — apenas acrescenta uma nova versão
que reproduz uma antiga. Dá sempre para avançar e recuar com segurança.

## O que NÃO precisamos (de propósito)

Fluxos de time grande — branches de homologação, pull requests revisados,
ambiente de *staging* — ficam de fora por serem exagero para um projeto tocado
por uma pessoa. O conjunto **commit + versão nomeada + voltar quando preciso** é
o tamanho certo e segue as boas práticas.

## Nota técnica

- As versões são releases `vN` (tag `vN`, título "Versão N — data") apontando
  para o commit publicado. O próximo número é sempre o maior `vN` existente + 1.
- A publicação em si é feita pela Hostinger (deploy por Git ao dar push na
  `main`), fora do GitHub.
- Se um dia este repositório deixar de ser um fork, dá para automatizar o
  registro da versão por GitHub Actions, igual ao roboeditor. Enquanto for fork,
  o Claude registra a versão ao publicar — é confiável e dá no mesmo.
- Rollback = `git revert` dos commits ruins **ou** republicar o conteúdo de uma
  tag antiga; em ambos os casos o próximo push para a `main` faz a Hostinger
  republicar.
