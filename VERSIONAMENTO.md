# Versionamento e como voltar uma versão

Este projeto guarda **todas as versões** no GitHub. Nada que já foi publicado se
perde: cada publicação vira um ponto de restauração ao qual dá para voltar.

## Como funciona

1. **Cada publicação cria uma "Versão N" automaticamente.**
   Toda vez que uma alteração é publicada (push na `main`, que a Hostinger usa
   para construir e publicar o CRM), o próprio GitHub registra a publicação como
   uma versão nomeada — por exemplo **"Versão 7 — 25/11/2026 às 16:20"**.

   O registro é feito a **cada publicação**, independentemente de o CI (lint,
   typecheck, testes e build) passar ou falhar. A razão: a Hostinger publica a
   `main` de qualquer jeito, então todo estado que foi para o ar precisa ter o
   seu marco para dar rollback — mesmo que algum teste esteja vermelho. Também dá
   para criar uma versão à mão pelo botão **"Run workflow"** na aba *Actions*.

2. **Onde ver todas as versões:**
   Página de *Releases* do repositório →
   <https://github.com/rosivaldoporto-sudo/ProCRM/releases>
   A lista mostra, da mais nova para a mais antiga, cada publicação, com a data e
   o resumo do que mudou.

3. **Cada versão aponta para o estado exato do código naquele momento.**
   É um retrato fiel do que foi publicado.

## Como voltar para uma versão anterior

Se uma publicação nova apresentar algum problema, **é só pedir aqui no Claude**,
por exemplo:

> "Voltar para a Versão 6."
> ou "A última publicação quebrou X, desfaz."

O que o Claude faz:

1. Confirma com você qual versão é a boa.
2. Desfaz as alterações problemáticas (`git revert`) — isso **cria uma versão
   nova** que é uma cópia fiel da versão boa anterior.
3. Republica: o push na `main` faz a Hostinger publicar de novo. O CRM volta ao
   estado da versão boa, e o histórico continua intacto (nada é apagado).

Ou seja: voltar atrás **nunca destrói** nada — apenas acrescenta uma nova versão
que reproduz uma antiga. Dá sempre para avançar e recuar com segurança.

## O que NÃO precisamos (de propósito)

Fluxos de time grande — branches de homologação, pull requests revisados,
ambiente de *staging* — ficam de fora por serem exagero para um projeto tocado
por uma pessoa. O conjunto **commit + CI + versão nomeada + voltar quando
preciso** é o tamanho certo e segue as boas práticas.

## Nota técnica (para quem for mexer no deploy)

- O registro da versão está no job `versao` em `.github/workflows/ci.yml`, que
  roda em push para a `main` (ou pelo botão "Run workflow"), **independente** do
  job `check`, e cria uma release `vN` apontando para o commit publicado.
- A publicação em si é feita pela Hostinger (deploy por Git ao dar push na
  `main`), fora do GitHub Actions. O job `versao` apenas *marca* a versão; ele
  não publica nem depende da Hostinger.
- Em 26/11/2026 este repositório deixou de ser um *fork* do `wacrm` (saiu da rede
  de forks). Isso foi o que permitiu o GitHub rodar o CI nos pushes e, com ele, o
  registro automático da versão — antes, por ser fork, o push não disparava nada.
- Rollback = `git revert` dos commits ruins **ou** republicar o conteúdo de uma
  tag antiga; em ambos os casos o próximo push para a `main` faz a Hostinger
  republicar.
