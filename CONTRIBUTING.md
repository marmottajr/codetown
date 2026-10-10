# Como contribuir

Obrigado por querer contribuir com o Habblaud! Relatos de bugs, ideias e melhorias são bem-vindos.

## Antes de começar

- Para bugs e ideias, procure nas [issues](https://github.com/marmottajr/habblaud/issues) se o assunto já foi registrado.
- Para mudanças maiores ou que alterem o comportamento do Habblaud, abra uma issue para conversar sobre a proposta antes de implementar.
- Prefira mudanças pequenas e focadas. Se a alteração muda o que aparece ou acontece no escritório, descreva esse comportamento no pull request.

## Preparar o ambiente

O Habblaud requer Node.js 22.12 ou mais recente e npm. Depois de clonar o repositório:

```sh
npm install
npm run dev
```

O escritório de desenvolvimento fica em <http://localhost:4747>.

## Verificar uma mudança

Antes de abrir o pull request, rode:

```sh
npm run typecheck
npm test
npm run build
```

Se a mudança alterar um plugin do Claude Code, valide também o plugin afetado:

```sh
claude plugin validate mod/habblaud
claude plugin test mod/habblaud
```

Use o caminho do plugin alterado (`mod/habblaud-permissoes` ou `mod/habblaud-mensagens`) quando for o caso.

## Abrir um pull request

- Use um título claro e explique o problema, a mudança e como ela foi verificada.
- Referencie a issue relacionada, se houver.
- Para mudanças visuais, inclua uma captura de tela ou um GIF, se ajudar a mostrar o resultado.
- Atualize a seção **Não lançado** do `CHANGELOG.md` quando a mudança trouxer algo visível para quem usa o Habblaud.
- Não inclua dados pessoais, credenciais ou conteúdo privado de sessões em capturas, exemplos ou logs.

Se algo não estiver claro, pergunte na issue relacionada antes de seguir por uma direção que possa mudar o comportamento do projeto.
